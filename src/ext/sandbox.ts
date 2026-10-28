import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { h } from "../lib/dom";
import { sandboxDocument } from "./document";
import { checkRequest, LIMITS, RateLimiter, type Permission } from "./protocol";
import { TimerGroup } from "./timers";

export type ApiHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * One running extension: a hidden sandboxed iframe plus the plumbing to talk to it. The extension's script runs in a
 * Web Worker that the iframe starts (see bootstrap.ts). The iframe also owns the command timeout and terminates the
 * worker when it is exceeded. This class validates every message and keeps its own, longer clock as a backstop.
 */
export class Sandbox {
  private frame: HTMLIFrameElement | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; cancel: () => void }>();
  private timers = new TimerGroup();
  private docId: string | null = null;
  private nextId = 1;
  private limiter = new RateLimiter();
  private registered = new Set<string>();
  private ready: Promise<void> | null = null;
  private failStart: ((e: Error, reason: string) => void) | null = null;
  private onMessage = (ev: MessageEvent) => void this.receive(ev);
  lastError: string | null = null;

  constructor(
    readonly extId: string,
    private code: string,
    private granted: readonly Permission[],
    private handle: ApiHandler,
    private onDead: (reason: string) => void,
  ) {}

  get running(): boolean {
    return this.frame !== null;
  }
  hasCommand(local: string): boolean {
    return this.registered.has(local);
  }

  /** Creates the iframe and waits until the worker bootstrap reports ready. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cancel = this.timers.add(LIMITS.startTimeoutMs, () => this.failStart?.(new Error("The extension did not start in time."), "start-timeout"));
      this.failStart = (e, reason) => {
        cancel();
        this.failStart = null;
        reject(e);
        this.kill(reason);
      };
      this.readyHook = () => {
        cancel();
        this.failStart = null;
        resolve();
      };
      window.addEventListener("message", this.onMessage);
      // The document is served by the app from its own URI scheme with its own CSP (no network, only inline
      // script and blob workers); a frame with an inline document would inherit the app's stricter CSP and its
      // scripts would never run. sandbox without allow-same-origin: opaque origin, no access to the app. The
      // extension's script does not run in the document but in a worker the document starts.
      api
        .sandboxStage(sandboxDocument(this.code))
        .then((id) => {
          if (!this.ready) return void api.sandboxRelease(id).catch(() => {});
          this.docId = id;
          this.frame = h("iframe", { sandbox: "allow-scripts", src: convertFileSrc(id, "nnext"), "aria-hidden": "true", tabIndex: -1, title: `extension ${this.extId}`, style: "display:none" });
          document.body.append(this.frame);
        })
        .catch((e) => this.failStart?.(e instanceof Error ? e : new Error(String(e)), "start-failed"));
    });
    return this.ready;
  }
  private readyHook: (() => void) | null = null;

  private async receive(ev: MessageEvent): Promise<void> {
    if (!this.frame || ev.source !== this.frame.contentWindow) return;
    const data = ev.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.event === "ready") return void this.readyHook?.();
    if (data.event === "error") {
      this.lastError = String(data.message ?? "").slice(0, 300);
      return;
    }
    // The worker could not be created, or the extension's script does not parse.
    if (data.event === "worker-failed") {
      this.lastError = String(data.message ?? "").slice(0, 300);
      this.failStart?.(new Error(this.lastError || "The extension script could not be loaded."), "start-failed");
      return;
    }
    // The iframe's clock ran out and it terminated the worker.
    if (data.event === "timeout") {
      if (this.pending.has(data.id as number)) this.expire(data.id as number);
      return;
    }
    // A reply to something we asked (a command run).
    if (!("method" in data)) {
      const p = this.pending.get(data.id as number);
      if (!p) return;
      this.pending.delete(data.id as number);
      p.cancel();
      if (data.error) p.reject(new Error(String(data.error).slice(0, 300)));
      else p.resolve(data.result);
      return;
    }
    // A call from the extension.
    const id = data.id as number;
    if (!this.limiter.allow()) {
      this.kill("rate-limit");
      return;
    }
    const checked = checkRequest(data, this.granted);
    if (!checked.ok) return this.reply(id, undefined, checked.error);
    try {
      if (checked.req.method === "commands.register") {
        this.registered.add(String(checked.req.params.id));
        return this.reply(id, null);
      }
      this.reply(id, await this.handle(checked.req.method, checked.req.params));
    } catch (e) {
      this.reply(id, undefined, e instanceof Error ? e.message : String(e));
    }
  }

  private reply(id: number, result?: unknown, error?: string): void {
    this.frame?.contentWindow?.postMessage(error ? { id, error } : { id, result: result ?? null }, "*");
  }

  /** A command ran out of time: the extension is stopped and its caller gets an error. */
  private expire(id: number): void {
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.cancel();
    p?.reject(new Error("The command took too long and the extension was stopped."));
    this.kill("command-timeout");
  }

  /**
   * Runs a registered command. The iframe times it (see bootstrap.ts) and terminates the worker when the time is up;
   * this class keeps a longer clock of its own in case the iframe never reports. Either way the sandbox is killed
   * and the extension is disabled.
   */
  run(command: string, context: Record<string, unknown> = {}): Promise<void> {
    const w = this.frame?.contentWindow;
    if (!w) return Promise.reject(new Error("The extension is not running."));
    return new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      // Both clocks stop while a dialog opened by the extension is on screen (see `hold`).
      const cancel = this.timers.add(LIMITS.commandTimeoutMs + LIMITS.commandBackstopMs, () => this.expire(id));
      this.pending.set(id, { resolve: () => resolve(), reject, cancel });
      w.postMessage({ id, method: "command.run", params: { command, context } }, "*");
    });
  }

  /** Pauses the command timeout, in the iframe and here, until the returned function is called (for dialogs waiting on the user). */
  hold(): () => void {
    const release = this.timers.hold();
    this.control("hold");
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
      this.control("release");
    };
  }

  private control(control: "hold" | "release"): void {
    this.frame?.contentWindow?.postMessage({ control }, "*");
  }

  kill(reason = "stopped"): void {
    if (!this.frame && !this.ready) return;
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
    this.failStart = null;
    this.timers.clear();
    if (this.docId) void api.sandboxRelease(this.docId).catch(() => {});
    this.docId = null;
    for (const p of this.pending.values()) {
      p.cancel();
      p.reject(new Error("The extension stopped."));
    }
    this.pending.clear();
    this.registered.clear();
    if (reason !== "stopped") this.onDead(reason);
  }
}

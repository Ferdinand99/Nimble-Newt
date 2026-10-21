import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { h } from "../lib/dom";
import { BOOTSTRAP } from "./bootstrap";
import { buildSrcdoc, checkRequest, LIMITS, RateLimiter, type Permission } from "./protocol";
import { TimerGroup } from "./timers";

export type ApiHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** One running extension: a hidden sandboxed iframe plus the plumbing to talk to it. */
export class Sandbox {
  private frame: HTMLIFrameElement | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; cancel: () => void }>();
  private timers = new TimerGroup();
  private docId: string | null = null;
  private nextId = 1;
  private limiter = new RateLimiter();
  private registered = new Set<string>();
  private ready: Promise<void> | null = null;
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

  /** Creates the iframe and waits until the bootstrap reports ready. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cancel = this.timers.add(LIMITS.startTimeoutMs, () => {
        this.kill("start-timeout");
        reject(new Error("The extension did not start in time."));
      });
      this.readyHook = () => {
        cancel();
        resolve();
      };
      window.addEventListener("message", this.onMessage);
      // The document is served by the app from its own URI scheme with its own CSP (no network, only inline
      // script); a srcdoc frame would inherit the app's stricter CSP and its scripts would never run.
      // sandbox without allow-same-origin: opaque origin, no access to the app.
      api
        .sandboxStage(buildSrcdoc(BOOTSTRAP, this.code))
        .then((id) => {
          if (!this.ready) return void api.sandboxRelease(id).catch(() => {});
          this.docId = id;
          this.frame = h("iframe", { sandbox: "allow-scripts", src: convertFileSrc(id, "nnext"), "aria-hidden": "true", tabIndex: -1, title: `extension ${this.extId}`, style: "display:none" });
          document.body.append(this.frame);
        })
        .catch((e) => {
          cancel();
          this.kill("start-failed");
          reject(e instanceof Error ? e : new Error(String(e)));
        });
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

  /** Runs a registered command; the run is abandoned (and the sandbox killed) after the timeout. */
  run(command: string, context: Record<string, unknown> = {}): Promise<void> {
    const w = this.frame?.contentWindow;
    if (!w) return Promise.reject(new Error("The extension is not running."));
    return new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      // The clock stops while a dialog opened by the extension is on screen (see `hold`).
      const cancel = this.timers.add(LIMITS.commandTimeoutMs, () => {
        this.pending.delete(id);
        this.kill("command-timeout");
        reject(new Error("The command took too long and the extension was stopped."));
      });
      this.pending.set(id, { resolve: () => resolve(), reject, cancel });
      w.postMessage({ id, method: "command.run", params: { command, context } }, "*");
    });
  }

  /** Pauses the command timeout until the returned function is called (for dialogs waiting on the user). */
  hold(): () => void {
    return this.timers.hold();
  }

  kill(reason = "stopped"): void {
    if (!this.frame && !this.ready) return;
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
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

// A stand-in for the app around a real sandbox document, for the end-to-end check (see sandbox.spec.ts).
//
// What is real: the sandbox document (`sandboxDocument`, the same output the app stages), the CSP header (read from
// src-tauri/src/sandbox.rs), the iframe attributes (`sandbox="allow-scripts"`, opaque origin), the validation of every
// message (`checkRequest`) and the bootstraps. What is stood in: the app window (a small page that relays messages like
// Sandbox does) and the editor (a few strings).
//
// Everything listens on 127.0.0.1 only. A sink (TCP and UDP on one port) records anything that reaches it.

import { readFileSync } from "node:fs";
import http from "node:http";
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { IFRAME_BOOTSTRAP, WORKER_API, WORKER_HEARTBEAT } from "../src/ext/bootstrap";
import { sandboxDocument } from "../src/ext/document";
import { buildSrcdoc, checkRequest, SANDBOX_CSP, type Permission, type SandboxTimes } from "../src/ext/protocol";

/** The header the real scheme handler sends: the `CSP` constant of src-tauri/src/sandbox.rs. */
export const HEADER_CSP = /pub const CSP: &str = "([^"]*)";/.exec(readFileSync(fileURLToPath(new URL("../src-tauri/src/sandbox.rs", import.meta.url)), "utf8"))?.[1] ?? "";

// ---- the sink: everything that gets through shows up here -----------------------------------------------------

export interface Sink {
  port: number;
  /** One line per thing that reached the sink: a TCP connection, a request, a WebSocket upgrade or a UDP packet. */
  hits: string[];
  close(): Promise<void>;
}

export async function startSink(): Promise<Sink> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`request ${req.method} ${req.url}`);
    const url = req.url ?? "";
    const type = /importScripts|\/t\/import|\/t\/worker/.test(url) ? "text/javascript" : "text/plain";
    const body = url.includes("importScripts") ? "self.__imp=1;" : url.includes("/t/import") ? "export default 1;" : url.includes("/t/worker") ? "postMessage(1);" : "ok";
    // Open CORS on purpose: if something is blocked, it must be the sandbox policy and not the sink.
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end(body);
  });
  server.on("connection", (socket) => {
    hits.push("tcp connection");
    socket.on("error", () => {});
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // The same port over UDP (QUIC, which WebTransport would use). Best effort: the port may be taken.
  const udp = dgram.createSocket("udp4");
  udp.on("message", () => hits.push("udp packet"));
  udp.on("error", () => {});
  await new Promise<void>((r) => {
    udp.once("error", () => r());
    udp.bind(port, "127.0.0.1", () => r());
  });
  return {
    port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        try {
          udp.close();
        } catch {
          /* never bound */
        }
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// ---- the web servers: the page that plays the app, and the sandbox documents ---------------------------------

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><script>
window.__msgs = [];
window.__bc = [];
try { new BroadcastChannel("nn-bc").onmessage = function (e) { window.__bc.push(e.data); }; } catch (e) {}
var f = document.createElement("iframe");
f.setAttribute("sandbox", "allow-scripts");
f.src = new URL(location.href).searchParams.get("sb");
window.addEventListener("message", async function (e) {
  if (e.source !== f.contentWindow) return;
  var m = e.data;
  window.__msgs.push(m);
  // a call from the extension: validated and answered by the node side
  if (m && typeof m === "object" && "method" in m && m.method !== "command.run") f.contentWindow.postMessage(await window.nnHost(m), "*");
});
window.nnSend = function (m) { f.contentWindow.postMessage(m, "*"); };
document.body.append(f);
</script></body></html>`;

export interface Servers {
  hostPort: number;
  docPort: number;
  /** Stages a document; the `csp` header it is served with defaults to the real one. */
  stage(html: string, csp?: string): string;
  close(): Promise<void>;
}

export async function startServers(): Promise<Servers> {
  const docs = new Map<string, { html: string; csp: string }>();
  const listen = (handler: http.RequestListener) =>
    new Promise<http.Server>((r) => {
      const s = http.createServer(handler);
      s.listen(0, "127.0.0.1", () => r(s));
    });
  const host = await listen((req, res) => {
    if (!(req.url ?? "").startsWith("/host.html")) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(HOST_PAGE);
  });
  const doc = await listen((req, res) => {
    const d = docs.get((req.url ?? "").slice(1));
    if (!d) return void res.writeHead(404, { "Content-Security-Policy": HEADER_CSP }).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": d.csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }).end(d.html);
  });
  const hostPort = (host.address() as AddressInfo).port;
  const docPort = (doc.address() as AddressInfo).port;
  let n = 0;
  return {
    hostPort,
    docPort,
    stage(html, csp = HEADER_CSP) {
      const id = `doc${++n}`;
      docs.set(id, { html, csp });
      return `http://127.0.0.1:${docPort}/${id}`;
    },
    close: () =>
      new Promise<void>((r) => {
        host.closeAllConnections();
        doc.closeAllConnections();
        host.close(() => doc.close(() => r()));
      }),
  };
}

// ---- a running extension --------------------------------------------------------------------------------------

export interface Editor {
  doc: string;
  selection: string;
  /** What the extension did to the editor, in order. */
  edits: { method: string; text: string }[];
  /** What it showed to the user. */
  messages: { text: string; kind?: string }[];
  /** The answer to ui.prompt. */
  promptAnswer: string;
  /** The extension's storage (permission "storage"). */
  storage: Map<string, string>;
}

export interface OpenOptions {
  code: string;
  permissions: Permission[];
  /** The clocks of the iframe (the app uses 10 s, 2 s and 5 s); shorter ones keep the tests quick. */
  times?: SandboxTimes;
  /** Leave out the lockdown of the worker bootstrap, to show that the CSP alone holds. Default: the real bootstrap. */
  lockdown?: boolean;
  /** Serve the document with a different header and meta policy: only for the control that proves the sink works. */
  csp?: string;
  /** Change only the meta tag in the document; the header stays the real one. */
  metaCsp?: string;
  editor?: Partial<Editor>;
}

type Spec = { event?: string; message?: string; reply?: number };

export class Extension {
  readonly editor: Editor;
  readonly registered = new Set<string>();
  private nextId = 1;
  private constructor(
    readonly page: Page,
    editor: Partial<Editor>,
  ) {
    this.editor = { doc: "", selection: "", edits: [], messages: [], promptAnswer: "https://example.com", storage: new Map(), ...editor };
  }

  static async open(page: Page, servers: Servers, o: OpenOptions): Promise<Extension> {
    const ext = new Extension(page, o.editor ?? {});
    await page.exposeFunction("nnHost", (m: unknown) => ext.answer(m, o.permissions));
    // What the app stages (src/ext/document.ts), or the same without the lockdown part of the worker bootstrap.
    let html = o.lockdown === false ? buildSrcdoc(IFRAME_BOOTSTRAP, WORKER_HEARTBEAT + WORKER_API + "\n" + o.code, o.times) : sandboxDocument(o.code, o.times);
    const meta = o.csp ?? o.metaCsp;
    if (meta) html = html.replace(SANDBOX_CSP, meta);
    const src = servers.stage(html, o.csp);
    await page.goto(`http://127.0.0.1:${servers.hostPort}/host.html?sb=${encodeURIComponent(src)}`);
    return ext;
  }

  /** What the app's `Sandbox.receive` does for a call from the extension: validate, then answer. */
  private answer(m: unknown, granted: Permission[]): { id: number; result?: unknown; error?: string } {
    const checked = checkRequest(m, granted);
    const id = (m as { id: number }).id;
    if (!checked.ok) return { id, error: checked.error };
    const { method, params } = checked.req;
    const e = this.editor;
    switch (method) {
      case "commands.register":
        this.registered.add(String(params.id));
        return { id, result: null };
      case "editor.getText":
        return { id, result: e.doc };
      case "editor.getSelection":
        return { id, result: { text: e.selection, ranges: [] } };
      case "editor.getLanguage":
        return { id, result: "plaintext" };
      case "editor.getFileName":
        return { id, result: "test.txt" };
      case "editor.replaceSelection":
      case "editor.replaceAll":
      case "editor.insertText":
        e.edits.push({ method, text: String(params.text) });
        return { id, result: null };
      case "ui.message":
        e.messages.push({ text: String(params.text), kind: params.kind as string | undefined });
        return { id, result: null };
      case "ui.prompt":
        return { id, result: e.promptAnswer };
      case "ui.pick":
        return { id, result: (params.items as string[])[0] };
      case "storage.set":
        e.storage.set(String(params.key), String(params.value));
        return { id, result: null };
      case "storage.get":
        return { id, result: e.storage.get(String(params.key)) ?? null };
      case "storage.remove":
        e.storage.delete(String(params.key));
        return { id, result: null };
      default:
        return { id, result: null };
    }
  }

  /** Every message the app window has received from the iframe so far. */
  messages(): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(() => (window as unknown as { __msgs: Record<string, unknown>[] }).__msgs);
  }

  /** Waits for `{ event }`, or for the reply to command run `reply`; resolves to the message, or null on timeout. */
  async waitFor(spec: Spec, ms = 15_000): Promise<Record<string, unknown> | null> {
    const handle = await this.page
      .waitForFunction(
        (s) => (window as unknown as { __msgs: Record<string, unknown>[] }).__msgs.find((m) => !!m && typeof m === "object" && (s.event !== undefined ? m.event === s.event && (s.message === undefined || m.message === s.message) : !("method" in m) && m.id === s.reply && ("result" in m || "error" in m))) ?? null,
        spec,
        { timeout: ms, polling: 20 },
      )
      .catch(() => null);
    return handle ? ((await handle.jsonValue()) as Record<string, unknown>) : null;
  }

  async ready(): Promise<void> {
    if (!(await this.waitFor({ event: "ready" }))) throw new Error(`the extension never became ready: ${JSON.stringify(await this.messages())}`);
  }

  /** Starts a command like `Sandbox.run` does; resolves to its outcome. */
  async run(command: string, context: Record<string, unknown> = { locale: "en" }, ms = 10_000): Promise<{ ok: true } | { error: string } | { timeout: true } | { silence: true }> {
    const id = this.nextId++;
    await this.page.evaluate((m) => (window as unknown as { nnSend(m: unknown): void }).nnSend(m), { id, method: "command.run", params: { command, context } });
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const msgs = await this.messages();
      if (msgs.some((m) => m.event === "timeout" && m.id === id)) return { timeout: true };
      const reply = msgs.find((m) => !("method" in m) && m.id === id && ("result" in m || "error" in m));
      if (reply) return "error" in reply ? { error: String(reply.error) } : { ok: true };
      await this.page.waitForTimeout(20);
    }
    return { silence: true };
  }

  send(m: unknown): Promise<void> {
    return this.page.evaluate((x) => (window as unknown as { nnSend(m: unknown): void }).nnSend(x), m);
  }

  /** How many `event` messages (with this text, if given) have arrived. */
  async count(event: string, message?: string): Promise<number> {
    return (await this.messages()).filter((m) => m.event === event && (message === undefined || m.message === message)).length;
  }

  broadcastReceived(): Promise<unknown[]> {
    return this.page.evaluate(() => (window as unknown as { __bc: unknown[] }).__bc);
  }
}

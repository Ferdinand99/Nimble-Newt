import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IFRAME_BOOTSTRAP, WORKER_BOOTSTRAP } from "./bootstrap";

// Both bootstraps are plain scripts that only touch the globals of their realm. They are run here as functions whose
// parameters shadow those globals, so every message they send and every timer they set can be observed.

type Listener = (e: unknown) => void;

function runWorkerBootstrap() {
  const listeners = new Map<string, Listener[]>();
  const self = {
    postMessage: vi.fn(),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  } as Record<string, unknown> & { postMessage: ReturnType<typeof vi.fn> };
  new Function("self", WORKER_BOOTSTRAP)(self);
  const fire = (type: string, e: unknown) => (listeners.get(type) ?? []).forEach((fn) => fn(e));
  const nimble = self.nimble as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> & { version: number };
  const sent = () => self.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { self, fire, nimble, sent, flush };
}

describe("worker bootstrap", () => {
  it("defines a frozen nimble v1 and then reports ready", () => {
    const { self, nimble, sent } = runWorkerBootstrap();
    expect(nimble.version).toBe(1);
    expect(Object.keys(nimble).sort()).toEqual(["clipboard", "commands", "editor", "storage", "ui", "version"]);
    expect(Object.isFrozen(nimble)).toBe(true);
    for (const k of ["commands", "editor", "ui", "clipboard", "storage"]) expect(Object.isFrozen(nimble[k]), k).toBe(true);
    expect(() => {
      (self as Record<string, unknown>).nimble = {};
    }).toThrow();
    expect(() => Object.defineProperty(self, "nimble", { value: 1 })).toThrow();
    expect(sent()).toEqual([{ event: "ready" }]);
  });

  it("needs no window or document, and does not poke at WebRTC (a worker has none)", () => {
    expect(WORKER_BOOTSTRAP).not.toMatch(/\b(window|document|parent)\b/);
    expect(WORKER_BOOTSTRAP).not.toMatch(/RTC/);
  });

  it("sends calls as { id, method, params } and settles them from the reply", async () => {
    const { fire, nimble, sent } = runWorkerBootstrap();
    const text = nimble.editor.getText();
    const rep = nimble.editor.replaceAll(5);
    const [, a, b] = sent();
    expect(a).toEqual({ id: 1, method: "editor.getText", params: {} });
    expect(b).toEqual({ id: 2, method: "editor.replaceAll", params: { text: "5" } });
    fire("message", { data: { id: 1, result: "hello" } });
    fire("message", { data: { id: 2, error: "nope" } });
    await expect(text).resolves.toBe("hello");
    await expect(rep).rejects.toThrow("nope");
  });

  it("coerces arguments to strings and keeps the wire format of every method", () => {
    const { nimble, sent } = runWorkerBootstrap();
    void nimble.ui.message(7, "success");
    void nimble.ui.prompt({ title: "t", placeholder: "p", value: "v" });
    void nimble.ui.pick({ title: "t", items: [1, "b"] });
    void nimble.clipboard.writeText(1);
    void nimble.storage.set("k", 2);
    void nimble.storage.get("k");
    void nimble.storage.remove("k");
    void nimble.editor.getSelection();
    void nimble.editor.getLanguage();
    void nimble.editor.getFileName();
    void nimble.editor.replaceSelection("x");
    void nimble.editor.insertText("y");
    expect(sent().slice(1).map(({ id: _id, ...rest }) => JSON.parse(JSON.stringify(rest)))).toEqual([
      { method: "ui.message", params: { text: "7", kind: "success" } },
      { method: "ui.prompt", params: { title: "t", placeholder: "p", value: "v" } },
      { method: "ui.pick", params: { title: "t", items: ["1", "b"] } },
      { method: "clipboard.writeText", params: { text: "1" } },
      { method: "storage.set", params: { key: "k", value: "2" } },
      { method: "storage.get", params: { key: "k" } },
      { method: "storage.remove", params: { key: "k" } },
      { method: "editor.getSelection", params: {} },
      { method: "editor.getLanguage", params: {} },
      { method: "editor.getFileName", params: {} },
      { method: "editor.replaceSelection", params: { text: "x" } },
      { method: "editor.insertText", params: { text: "y" } },
    ]);
  });

  it("registers handlers, runs a command with its context and answers { id, result: null }", async () => {
    const { fire, nimble, sent, flush } = runWorkerBootstrap();
    const seen: unknown[] = [];
    void nimble.commands.register("go", async (ctx: unknown) => void seen.push(ctx));
    expect(sent()[1]).toMatchObject({ method: "commands.register", params: { id: "go" } });
    fire("message", { data: { id: 9, method: "command.run", params: { command: "go", context: { locale: "nb" } } } });
    await flush();
    expect(seen).toEqual([{ locale: "nb" }]);
    expect(sent().at(-1)).toEqual({ id: 9, result: null });
  });

  it("answers a failing or missing handler with { id, error }", async () => {
    const { fire, nimble, sent, flush } = runWorkerBootstrap();
    void nimble.commands.register("bad", () => Promise.reject(new Error("boom")));
    fire("message", { data: { id: 1, method: "command.run", params: { command: "bad" } } });
    fire("message", { data: { id: 2, method: "command.run", params: { command: "nothing" } } });
    await flush();
    expect(sent().slice(-2).sort((a, b) => (a.id as number) - (b.id as number))).toEqual([
      { id: 1, error: "boom" },
      { id: 2, error: "No handler registered for nothing" },
    ]);
  });

  it("rejects a handler that is not a function", () => {
    const { nimble } = runWorkerBootstrap();
    expect(() => nimble.commands.register("x", 5)).toThrow(TypeError);
  });

  it("ignores junk messages and replies nobody asked for", () => {
    const { fire, sent } = runWorkerBootstrap();
    for (const data of [null, 5, "x", undefined, { id: 99, result: 1 }, {}]) fire("message", { data });
    expect(sent()).toEqual([{ event: "ready" }]);
  });

  it("reports uncaught errors and rejections as { event: 'error' }", () => {
    const { fire, sent } = runWorkerBootstrap();
    fire("error", { message: "kaput" });
    fire("unhandledrejection", { reason: new Error("later") });
    fire("unhandledrejection", { reason: "plain" });
    expect(sent().slice(1)).toEqual([
      { event: "error", message: "kaput" },
      { event: "error", message: "later" },
      { event: "error", message: "plain" },
    ]);
  });
});

// ---- the iframe side ----------------------------------------------------------------------------------------------

class FakeWorker {
  static all: FakeWorker[] = [];
  static failWith: Error | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message?: string; preventDefault: () => void }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(public url: string) {
    if (FakeWorker.failWith) throw FakeWorker.failWith;
    FakeWorker.all.push(this);
  }
  /** The worker sends a message up. */
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

function runIframeBootstrap(timeoutMs = 1000, source = "WORKER SOURCE") {
  const host = { postMessage: vi.fn() };
  let onMessage: Listener = () => {};
  const window = { parent: host, addEventListener: (_t: string, fn: Listener) => (onMessage = fn) };
  const blobs: unknown[][] = [];
  class FakeBlob {
    constructor(public parts: unknown[], public opts: unknown) {
      blobs.push(parts);
    }
  }
  const URLish = { createObjectURL: vi.fn(() => "blob:null/abc") };
  new Function("window", "Worker", "Blob", "URL", "NN_WORKER_SOURCE", "NN_COMMAND_TIMEOUT_MS", IFRAME_BOOTSTRAP)(window, FakeWorker, FakeBlob, URLish, source, timeoutMs);
  const worker = FakeWorker.all[0] as FakeWorker | undefined;
  const fromHost = (data: unknown, source: unknown = host) => onMessage({ source, data });
  const toHost = () => host.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
  return { host, worker, fromHost, toHost, blobs, URLish };
}

describe("iframe bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.all = [];
    FakeWorker.failWith = null;
  });
  afterEach(() => vi.useRealTimers());

  it("starts one blob worker from the worker source and nothing else", () => {
    const { worker, blobs, URLish, toHost } = runIframeBootstrap(1000, "SRC");
    expect(FakeWorker.all).toHaveLength(1);
    expect(blobs).toEqual([["SRC"]]);
    expect(URLish.createObjectURL).toHaveBeenCalledOnce();
    expect(worker!.url).toBe("blob:null/abc");
    expect(toHost()).toEqual([]);
  });

  it("never touches the DOM, makes frames or reaches for the network itself", () => {
    expect(IFRAME_BOOTSTRAP).not.toMatch(/\b(document|fetch|XMLHttpRequest|WebSocket|importScripts|eval)\b|createElement|iframe/);
  });

  it("passes messages in both directions unchanged", () => {
    const { worker, fromHost, toHost } = runIframeBootstrap();
    const call = { id: 1, method: "editor.getText", params: {} };
    worker!.emit(call);
    worker!.emit({ event: "ready" });
    worker!.emit({ event: "error", message: "x" });
    expect(toHost()).toEqual([call, { event: "ready" }, { event: "error", message: "x" }]);
    expect(toHost()[0]).toBe(call);
    const reply = { id: 1, result: "text" };
    fromHost(reply);
    expect(worker!.postMessage).toHaveBeenCalledWith(reply);
    expect(worker!.postMessage.mock.calls[0][0]).toBe(reply);
  });

  it("ignores messages from anyone but the app, and anything that is not an object", () => {
    const { worker, fromHost } = runIframeBootstrap();
    fromHost({ id: 1, result: 1 }, { not: "the host" });
    fromHost({ id: 1, method: "command.run", params: {} }, null);
    for (const junk of [null, undefined, 5, "str"]) fromHost(junk);
    worker!.emit(5);
    worker!.emit(null);
    expect(worker!.postMessage).not.toHaveBeenCalled();
  });

  it("does not pass control messages on to the worker", () => {
    const { worker, fromHost } = runIframeBootstrap();
    fromHost({ control: "hold" });
    fromHost({ control: "release" });
    fromHost({ control: "other" });
    expect(worker!.postMessage).not.toHaveBeenCalled();
  });

  it("terminates the worker and reports { event: 'timeout', id } when a command is too slow", () => {
    const { worker, fromHost, toHost } = runIframeBootstrap(1000);
    fromHost({ id: 7, method: "command.run", params: { command: "spin", context: {} } });
    expect(worker!.postMessage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(worker!.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker!.terminate).toHaveBeenCalledOnce();
    expect(toHost()).toEqual([{ event: "timeout", id: 7 }]);
    // The worker is gone: nothing more is passed to it, and the clock does not fire again.
    fromHost({ id: 8, method: "command.run", params: { command: "x" } });
    fromHost({ id: 1, result: 1 });
    vi.advanceTimersByTime(60_000);
    expect(worker!.postMessage).toHaveBeenCalledOnce();
    expect(worker!.terminate).toHaveBeenCalledOnce();
    expect(toHost()).toHaveLength(1);
  });

  it("stops the clock when the command answers, with a result or an error", () => {
    const { worker, fromHost, toHost } = runIframeBootstrap(1000);
    fromHost({ id: 1, method: "command.run", params: { command: "a" } });
    fromHost({ id: 2, method: "command.run", params: { command: "b" } });
    worker!.emit({ id: 1, result: null });
    worker!.emit({ id: 2, error: "failed" });
    vi.advanceTimersByTime(10_000);
    expect(worker!.terminate).not.toHaveBeenCalled();
    expect(toHost()).toEqual([
      { id: 1, result: null },
      { id: 2, error: "failed" },
    ]);
  });

  it("only times command runs, not other messages or the extension's own calls", () => {
    const { worker, fromHost } = runIframeBootstrap(1000);
    fromHost({ id: 1, result: "x" });
    worker!.emit({ id: 1, method: "editor.getText", params: {} });
    vi.advanceTimersByTime(60_000);
    expect(worker!.terminate).not.toHaveBeenCalled();
  });

  it("a request from the worker with the id of a running command does not stop that clock", () => {
    const { worker, fromHost } = runIframeBootstrap(1000);
    fromHost({ id: 1, method: "command.run", params: { command: "a" } });
    worker!.emit({ id: 1, method: "editor.getText", params: {} });
    vi.advanceTimersByTime(1000);
    expect(worker!.terminate).toHaveBeenCalledOnce();
  });

  it("does not count the time while the app holds the clock, and resumes with what was left", () => {
    const { worker, fromHost, toHost } = runIframeBootstrap(1000);
    fromHost({ id: 1, method: "command.run", params: { command: "ask" } });
    vi.advanceTimersByTime(600);
    fromHost({ control: "hold" });
    vi.advanceTimersByTime(60_000);
    expect(worker!.terminate).not.toHaveBeenCalled();
    fromHost({ control: "release" });
    vi.advanceTimersByTime(399);
    expect(worker!.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker!.terminate).toHaveBeenCalledOnce();
    expect(toHost()).toEqual([{ event: "timeout", id: 1 }]);
  });

  it("holds nest, a command that starts during a hold waits for the release, and an extra release is harmless", () => {
    const { worker, fromHost } = runIframeBootstrap(100);
    fromHost({ control: "release" }); // nothing held: ignored
    fromHost({ control: "hold" });
    fromHost({ control: "hold" });
    fromHost({ id: 1, method: "command.run", params: { command: "a" } });
    vi.advanceTimersByTime(10_000);
    fromHost({ control: "release" });
    vi.advanceTimersByTime(10_000);
    expect(worker!.terminate).not.toHaveBeenCalled();
    fromHost({ control: "release" });
    vi.advanceTimersByTime(99);
    expect(worker!.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(worker!.terminate).toHaveBeenCalledOnce();
  });

  it("reports { event: 'worker-failed' } when the worker cannot be created", () => {
    FakeWorker.failWith = new Error("blocked by policy");
    const { toHost, fromHost } = runIframeBootstrap();
    expect(toHost()).toEqual([{ event: "worker-failed", message: "blocked by policy" }]);
    // No listener was set up: later messages do nothing.
    fromHost({ id: 1, method: "command.run", params: {} });
    expect(toHost()).toHaveLength(1);
  });

  it("reports a script that does not load before ready, but not an error after ready", () => {
    const first = runIframeBootstrap();
    const preventDefault = vi.fn();
    first.worker!.onerror!({ message: "SyntaxError: bad", preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(first.toHost()).toEqual([{ event: "worker-failed", message: "SyntaxError: bad" }]);

    FakeWorker.all = [];
    const second = runIframeBootstrap();
    second.worker!.emit({ event: "ready" });
    second.worker!.onerror!({ message: "later error", preventDefault });
    expect(second.toHost()).toEqual([{ event: "ready" }]);
  });
});

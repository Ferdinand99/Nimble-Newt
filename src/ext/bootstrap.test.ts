import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IFRAME_BOOTSTRAP, WORKER_API, WORKER_BOOTSTRAP, WORKER_HEARTBEAT, WORKER_LOCKDOWN } from "./bootstrap";

// The bootstraps are plain scripts that only touch the globals of their realm. They are run here as functions whose
// parameters shadow those globals, so every message they send and every timer they set can be observed.

type Listener = (e: unknown) => void;

/** A fake worker global; `proto` holds what lives on the prototype chain, as in a real engine. */
function fakeWorkerGlobal(proto: Record<string, unknown> = {}, own: Record<string, unknown> = {}) {
  const listeners = new Map<string, Listener[]>();
  const self = Object.create(proto) as Record<string, unknown> & { postMessage: ReturnType<typeof vi.fn> };
  Object.assign(self, own, {
    postMessage: vi.fn(),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  });
  const fire = (type: string, e: unknown) => (listeners.get(type) ?? []).forEach((fn) => fn(e));
  const sent = () => self.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
  return { self, fire, sent, listeners };
}

function runWorkerBootstrap(code: string = WORKER_BOOTSTRAP) {
  const g = fakeWorkerGlobal();
  const navigator = {};
  new Function("self", "navigator", code)(g.self, navigator);
  const nimble = g.self.nimble as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> & { version: number };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { ...g, nimble, flush };
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

  it("is the heartbeat, then the lockdown, then the API, in that order", () => {
    expect(WORKER_BOOTSTRAP).toBe(WORKER_HEARTBEAT + WORKER_LOCKDOWN + WORKER_API);
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

describe("worker heartbeat", () => {
  it("answers a ping with a pong carrying the same nonce, from the first listener registered", () => {
    const { fire, sent, listeners } = runWorkerBootstrap();
    expect(listeners.get("message")!.length).toBe(2); // the heartbeat, then the API: both before any extension code
    fire("message", { data: { control: "ping", nonce: "abc123" } });
    expect(sent().at(-1)).toEqual({ control: "pong", nonce: "abc123" });
    expect(sent().filter((m) => m.control === "pong")).toHaveLength(1);
  });

  it("works on its own, so it is in place before anything else of ours", () => {
    const { fire, sent } = runWorkerBootstrap(WORKER_HEARTBEAT);
    fire("message", { data: { control: "ping", nonce: "n" } });
    expect(sent()).toEqual([{ control: "pong", nonce: "n" }]);
  });

  it("ignores pings without a string nonce and other messages", () => {
    const { fire, sent } = runWorkerBootstrap(WORKER_HEARTBEAT);
    for (const data of [{ control: "ping" }, { control: "ping", nonce: 5 }, { control: "pong", nonce: "x" }, { control: "hold" }, null, "x"]) fire("message", { data });
    expect(sent()).toEqual([]);
  });
});

describe("worker lockdown", () => {
  const names = ["fetch", "fetchLater", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker"];
  const make = () => {
    // Some of these live on the prototype chain (as importScripts does), some on the global itself (as fetch does).
    const protoOwn: Record<string, unknown> = {};
    const selfOwn: Record<string, unknown> = {};
    names.forEach((n, i) => ((i % 2 ? selfOwn : protoOwn)[n] = function original() {}));
    const g = fakeWorkerGlobal(Object.create(protoOwn, {}), selfOwn);
    const navProto = { sendBeacon: () => true };
    const navigator = Object.create(navProto) as Record<string, unknown>;
    new Function("self", "navigator", WORKER_LOCKDOWN)(g.self, navigator);
    return { self: g.self, navigator, protoOwn, navProto };
  };

  it("makes the network APIs undefined for the extension, wherever they lived", () => {
    const { self, navigator } = make();
    for (const n of names) expect(typeof self[n], n).toBe("undefined");
    expect(typeof navigator.sendBeacon).toBe("undefined");
  });

  it("also takes them off the prototype chain, so no original can be fetched from there", () => {
    const { protoOwn, navProto } = make();
    for (const n of names.filter((_, i) => i % 2 === 0)) expect(typeof protoOwn[n], n).toBe("undefined");
    expect(typeof navProto.sendBeacon).toBe("undefined");
  });

  it("cannot be undone: the properties are not configurable, writes do nothing", () => {
    const { self, navigator } = make();
    for (const n of names) {
      expect(() => Object.defineProperty(self, n, { value: () => 1 }), n).toThrow();
      (self as Record<string, unknown>)[n] = () => 1;
      expect(typeof self[n], n).toBe("undefined");
      expect(Object.getOwnPropertyDescriptor(self, n)?.configurable, n).toBe(false);
    }
    expect(() => Object.defineProperty(navigator, "sendBeacon", { value: () => 1 })).toThrow();
  });

  it("leaves what the API needs alone", () => {
    const { self } = make();
    expect(typeof self.postMessage).toBe("function");
    expect(typeof self.addEventListener).toBe("function");
  });

  it("does not need a navigator", () => {
    const g = fakeWorkerGlobal();
    expect(() => new Function("self", "navigator", WORKER_LOCKDOWN)(g.self, undefined)).not.toThrow();
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
  /** What the iframe has sent down, minus heartbeat pings. */
  down() {
    return this.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.control !== "ping");
  }
  pings() {
    return this.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.control === "ping");
  }
}

interface Clocks {
  commandMs?: number;
  pingMs?: number;
  unresponsiveMs?: number;
}

// By default the heartbeat is out of the way (a day), so the tests of the command clock can run for a long time.
function runIframeBootstrap({ commandMs = 1000, pingMs = 86_400_000, unresponsiveMs = 86_400_000 }: Clocks = {}, source = "WORKER SOURCE") {
  const host = { postMessage: vi.fn() };
  let onMessage: Listener = () => {};
  const window = { parent: host, addEventListener: (_t: string, fn: Listener) => (onMessage = fn) };
  const blobs: unknown[][] = [];
  class FakeBlob {
    constructor(public parts: unknown[], public opts: unknown) {
      blobs.push(parts);
    }
  }
  const URLish = { createObjectURL: vi.fn(() => "blob:null/abc"), revokeObjectURL: vi.fn() };
  new Function("window", "Worker", "Blob", "URL", "NN_WORKER_SOURCE", "NN_COMMAND_TIMEOUT_MS", "NN_PING_MS", "NN_UNRESPONSIVE_MS", IFRAME_BOOTSTRAP)(window, FakeWorker, FakeBlob, URLish, source, commandMs, pingMs, unresponsiveMs);
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
    const { worker, blobs, URLish, toHost } = runIframeBootstrap({}, "SRC");
    expect(FakeWorker.all).toHaveLength(1);
    expect(blobs).toEqual([["SRC"]]);
    expect(URLish.createObjectURL).toHaveBeenCalledOnce();
    expect(worker!.url).toBe("blob:null/abc");
    expect(toHost()).toEqual([]);
  });

  it("never touches the DOM, makes frames or reaches for the network itself", () => {
    expect(IFRAME_BOOTSTRAP).not.toMatch(/\b(document|fetch|XMLHttpRequest|WebSocket|importScripts|eval)\b|createElement|iframe/);
  });

  it("passes well-formed messages in both directions", () => {
    const { worker, fromHost, toHost } = runIframeBootstrap();
    const call = { id: 1, method: "editor.getText", params: {} };
    worker!.emit(call);
    worker!.emit({ event: "ready" });
    worker!.emit({ event: "error", message: "x" });
    expect(toHost()).toEqual([call, { event: "ready" }, { event: "error", message: "x" }]);
    const reply = { id: 1, result: "text" };
    fromHost(reply);
    expect(worker!.down()).toEqual([reply]);
    expect(worker!.down()[0]).toBe(reply);
  });

  it("ignores messages from anyone but the app, and anything that is not an object", () => {
    const { worker, fromHost } = runIframeBootstrap();
    fromHost({ id: 1, result: 1 }, { not: "the host" });
    fromHost({ id: 1, method: "command.run", params: {} }, null);
    for (const junk of [null, undefined, 5, "str"]) fromHost(junk);
    worker!.emit(5);
    worker!.emit(null);
    expect(worker!.down()).toEqual([]);
  });

  it("does not pass control messages on to the worker", () => {
    const { worker, fromHost } = runIframeBootstrap();
    fromHost({ control: "hold" });
    fromHost({ control: "release" });
    fromHost({ control: "other" });
    expect(worker!.down()).toEqual([]);
  });

  describe("relay: only a well-formed request, reply, ready or error event goes on to the app", () => {
    const accepted: [string, unknown, unknown][] = [
      ["a request", { id: 3, method: "ui.message", params: { text: "t" } }, { id: 3, method: "ui.message", params: { text: "t" } }],
      ["a request without params", { id: 3, method: "editor.getText" }, { id: 3, method: "editor.getText" }],
      ["a success reply", { id: 4, result: null }, { id: 4, result: null }],
      ["an error reply", { id: 4, error: "bad" }, { id: 4, error: "bad" }],
      ["ready", { event: "ready", extra: 1 }, { event: "ready" }],
      ["an error event", { event: "error", message: "m", extra: 1 }, { event: "error", message: "m" }],
      ["a request with extra keys, which are dropped", { id: 3, method: "x", params: {}, junk: "y" }, { id: 3, method: "x", params: {} }],
    ];
    for (const [what, sent, relayed] of accepted) {
      it(`passes ${what}`, () => {
        const { worker, toHost } = runIframeBootstrap();
        worker!.emit(sent);
        expect(toHost()).toEqual([relayed]);
      });
    }

    const dropped: [string, unknown][] = [
      ["a forged timeout", { event: "timeout", id: 1 }],
      ["a forged worker-failed", { event: "worker-failed", message: "x" }],
      ["a forged unresponsive", { event: "unresponsive" }],
      ["an unknown event", { event: "beat" }],
      ["an error event without text", { event: "error" }],
      ["a forged hold", { control: "hold" }],
      ["a forged release", { control: "release" }],
      ["a reply with a result", { id: 1, result: { big: "x" } }],
      ["a reply with both result and error", { id: 1, result: null, error: 5 }],
      ["an empty object", {}],
      ["a request with a bad id", { id: "1", method: "x" }],
      ["a request with a fractional id", { id: 1.5, method: "x" }],
      ["a request with a method that is not a string", { id: 1, method: 5 }],
      ["a request with a very long method", { id: 1, method: "m".repeat(65) }],
      ["a request with list params", { id: 1, method: "x", params: [1] }],
      ["a request with null params", { id: 1, method: "x", params: null }],
      ["a list", [1, 2]],
    ];
    for (const [what, sent] of dropped) {
      it(`drops ${what}`, () => {
        const { worker, toHost } = runIframeBootstrap();
        worker!.emit(sent);
        expect(toHost()).toEqual([]);
      });
    }

    it("cuts long error text", () => {
      const { worker, toHost } = runIframeBootstrap();
      worker!.emit({ event: "error", message: "e".repeat(5000) });
      worker!.emit({ id: 1, error: "r".repeat(5000) });
      expect(toHost().map((m) => String(m.message ?? m.error).length)).toEqual([300, 300]);
    });

    it("forged messages do not touch the clock or the worker", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap({ commandMs: 1000 });
      fromHost({ id: 1, method: "command.run", params: { command: "x" } });
      worker!.emit({ control: "hold" });
      worker!.emit({ event: "timeout", id: 99 });
      worker!.emit({ event: "worker-failed", message: "x" });
      vi.advanceTimersByTime(1000);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ event: "timeout", id: 1 }]);
    });
  });

  describe("command clock", () => {
    it("terminates the worker and reports { event: 'timeout', id } when a command is too slow", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap({ commandMs: 1000 });
      fromHost({ id: 7, method: "command.run", params: { command: "spin", context: {} } });
      expect(worker!.down()).toHaveLength(1);
      vi.advanceTimersByTime(999);
      expect(worker!.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ event: "timeout", id: 7 }]);
      // The worker is gone: nothing more is passed to it, and the clock does not fire again.
      fromHost({ id: 8, method: "command.run", params: { command: "x" } });
      fromHost({ id: 1, result: 1 });
      vi.advanceTimersByTime(60_000);
      expect(worker!.down()).toHaveLength(1);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toHaveLength(1);
    });

    it("stops the clock when the command answers, with a result or an error", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap({ commandMs: 1000 });
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
      const { worker, fromHost } = runIframeBootstrap({ commandMs: 1000 });
      fromHost({ id: 1, result: "x" });
      worker!.emit({ id: 1, method: "editor.getText", params: {} });
      vi.advanceTimersByTime(60_000);
      expect(worker!.terminate).not.toHaveBeenCalled();
    });

    it("a request from the worker with the id of a running command does not stop that clock", () => {
      const { worker, fromHost } = runIframeBootstrap({ commandMs: 1000 });
      fromHost({ id: 1, method: "command.run", params: { command: "a" } });
      worker!.emit({ id: 1, method: "editor.getText", params: {} });
      vi.advanceTimersByTime(1000);
      expect(worker!.terminate).toHaveBeenCalledOnce();
    });

    it("does not count the time while the app holds the clock, and resumes with what was left", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap({ commandMs: 1000 });
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
      const { worker, fromHost } = runIframeBootstrap({ commandMs: 100 });
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
  });

  describe("heartbeat", () => {
    const clocks = { commandMs: 100_000, pingMs: 2000, unresponsiveMs: 5000 };
    /** Answers every ping that has been sent and not answered yet, as a healthy worker does. */
    const answer = (w: FakeWorker, answered = new Set<string>()) => {
      for (const p of w.pings()) {
        const n = p.nonce as string;
        if (!answered.has(n)) {
          answered.add(n);
          w.emit({ control: "pong", nonce: n });
        }
      }
    };

    /** A worker that is idle again: it answers every ping from now on. */
    const healthy = (w: FakeWorker, ms: number) => {
      const answered = new Set<string>();
      for (let t = 0; t < ms; t += 500) {
        vi.advanceTimersByTime(500);
        answer(w, answered);
      }
    };

    it("pings the worker with a fresh random nonce each time", () => {
      const { worker } = runIframeBootstrap(clocks);
      expect(worker!.pings()).toEqual([]);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      const nonces = worker!.pings().map((p) => p.nonce as string);
      expect(nonces).toHaveLength(3);
      expect(new Set(nonces).size).toBe(3);
      for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
      expect(worker!.pings().every((p) => p.control === "ping")).toBe(true);
    });

    it("leaves a worker that answers alone, however long it runs, and never relays the pongs", () => {
      const { worker, toHost } = runIframeBootstrap(clocks);
      const answered = new Set<string>();
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(2000);
        answer(worker!, answered);
      }
      expect(worker!.terminate).not.toHaveBeenCalled();
      expect(toHost()).toEqual([]);
    });

    it("terminates a worker that stops answering and tells the app { event: 'unresponsive' }", () => {
      const { worker, toHost } = runIframeBootstrap(clocks);
      vi.advanceTimersByTime(2000); // first ping goes out
      vi.advanceTimersByTime(5000 + 249);
      expect(worker!.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ event: "unresponsive" }]);
    });

    it("then stops pinging and does not report twice", () => {
      const { worker, toHost } = runIframeBootstrap(clocks);
      vi.advanceTimersByTime(60_000);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ event: "unresponsive" }]);
      const n = worker!.postMessage.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      expect(worker!.postMessage.mock.calls.length).toBe(n);
    });

    it("lets a step that blocks the worker for less than the limit finish: its queued ping is answered afterwards", () => {
      const { worker, toHost } = runIframeBootstrap(clocks);
      vi.advanceTimersByTime(2000); // ping 1 goes out; the worker is busy and does not read it
      vi.advanceTimersByTime(4900); // 4.9 s later it is done and reads it
      answer(worker!);
      healthy(worker!, 60_000);
      expect(worker!.terminate).not.toHaveBeenCalled();
      expect(toHost()).toEqual([]);
    });

    it("gives an answer that is already on its way a moment after the deadline", () => {
      const { worker } = runIframeBootstrap(clocks);
      vi.advanceTimersByTime(2000);
      const n = worker!.pings()[0].nonce as string;
      vi.advanceTimersByTime(5000 + 100); // past the deadline, inside the grace
      worker!.emit({ control: "pong", nonce: n });
      healthy(worker!, 60_000);
      expect(worker!.terminate).not.toHaveBeenCalled();
    });

    it("cannot be answered for: a pong with a nonce nobody sent, or an old one, does not count", () => {
      const { worker } = runIframeBootstrap(clocks);
      vi.advanceTimersByTime(2000);
      const first = worker!.pings()[0].nonce as string;
      worker!.emit({ control: "pong", nonce: first }); // the real answer to ping 1
      vi.advanceTimersByTime(2000); // ping 2: the worker is now stuck and never reads it
      // A script stuck in a loop sends what it has: the old nonce, guesses, junk.
      for (let i = 0; i < 50; i++) {
        worker!.emit({ control: "pong", nonce: first });
        worker!.emit({ control: "pong", nonce: "0".repeat(32) });
        worker!.emit({ control: "pong", nonce: i });
        worker!.emit({ control: "pong" });
        worker!.emit({ control: "pong", nonce: "__proto__" });
      }
      vi.advanceTimersByTime(5000 + 250);
      expect(worker!.terminate).toHaveBeenCalledOnce();
    });

    it("catches a script that answers its command early and then loops (the command clock is already cleared)", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap(clocks);
      fromHost({ id: 3, method: "command.run", params: { command: "evade" } });
      worker!.emit({ id: 3, result: null }); // the extension's own listener replies at once, then spins
      vi.advanceTimersByTime(60_000);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ id: 3, result: null }, { event: "unresponsive" }]);
    });

    it("does not stop while the app holds the command clock: a worker waiting for a dialog is idle and answers", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap(clocks);
      fromHost({ id: 1, method: "command.run", params: { command: "ask" } });
      fromHost({ control: "hold" });
      const answered = new Set<string>();
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(2000);
        answer(worker!, answered);
      }
      expect(worker!.terminate).not.toHaveBeenCalled();
      expect(toHost()).toEqual([]);
    });

    it("also catches a worker that loops during a hold", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap(clocks);
      fromHost({ id: 1, method: "command.run", params: { command: "ask" } });
      fromHost({ control: "hold" });
      vi.advanceTimersByTime(60_000);
      expect(worker!.terminate).toHaveBeenCalledOnce();
      expect(toHost()).toEqual([{ event: "unresponsive" }]);
    });

    it("stops pinging once the command clock has terminated the worker", () => {
      const { worker, fromHost, toHost } = runIframeBootstrap({ ...clocks, commandMs: 1000 });
      fromHost({ id: 1, method: "command.run", params: { command: "spin" } });
      vi.advanceTimersByTime(60_000);
      expect(toHost()).toEqual([{ event: "timeout", id: 1 }]);
      expect(worker!.pings()).toEqual([]);
    });
  });

  it("revokes the blob URL once the worker has started, and only once", () => {
    const { worker, URLish } = runIframeBootstrap();
    expect(URLish.revokeObjectURL).not.toHaveBeenCalled(); // not before the worker has read it
    worker!.emit({ event: "ready" });
    expect(URLish.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:null/abc");
    worker!.emit({ event: "ready" });
    vi.advanceTimersByTime(60_000);
    expect(URLish.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("reports { event: 'worker-failed' } when the worker cannot be created", () => {
    FakeWorker.failWith = new Error("blocked by policy");
    const { toHost, fromHost, URLish } = runIframeBootstrap();
    expect(toHost()).toEqual([{ event: "worker-failed", message: "blocked by policy" }]);
    expect(URLish.revokeObjectURL).toHaveBeenCalledOnce();
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
    expect(first.worker!.terminate).toHaveBeenCalledOnce();
    expect(first.URLish.revokeObjectURL).toHaveBeenCalledOnce();

    FakeWorker.all = [];
    const second = runIframeBootstrap();
    second.worker!.emit({ event: "ready" });
    second.worker!.onerror!({ message: "later error", preventDefault });
    expect(second.toHost()).toEqual([{ event: "ready" }]);
  });
});

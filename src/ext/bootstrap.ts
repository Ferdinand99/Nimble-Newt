/**
 * The scripts that make up an extension's sandbox. They are written as strings because they are embedded in the
 * sandbox document (see `buildSrcdoc`), and as plain ES5-style code with no imports.
 *
 *   host (app window)  <->  IFRAME_BOOTSTRAP (sandbox iframe)  <->  WORKER_BOOTSTRAP + extension script (Web Worker)
 *
 * The extension's script runs in a dedicated Web Worker, never in the iframe's window. A worker has no DOM, cannot
 * create frames and has no WebRTC (`RTCPeerConnection` only exists in `Window`), and the CSP of the sandbox document
 * (`worker-src blob:`, everything else `'none'`) is inherited by the worker. So there is no child frame to recover a
 * WebRTC constructor from, and `terminate()` can stop a script that never returns. See docs/extensions.md.
 *
 * The extension script shares the worker's global with the worker bootstrap, so it can read and send any message the
 * bootstrap can. Nothing here relies on the extension behaving: the iframe only relays well-formed messages, the app
 * validates them again, and the iframe stops a worker that does not answer its heartbeat.
 */

/**
 * Runs first in the worker. Answers the iframe's heartbeat from a listener that is registered before the extension's
 * script is even parsed. A stuck worker does not read the ping, so the extension cannot answer for it, and each ping
 * carries a fresh random nonce that only the iframe knows until the worker reads it.
 */
export const WORKER_HEARTBEAT = `
(function () {
  "use strict";
  var post = self.postMessage.bind(self);
  self.addEventListener("message", function (e) {
    var m = e.data;
    if (m && typeof m === "object" && m.control === "ping" && typeof m.nonce === "string") post({ control: "pong", nonce: m.nonce });
  });
})();
`;

/**
 * Defence in depth, and not the barrier: the CSP of the sandbox document is what stops the network. Before the
 * extension's script runs, the network-capable APIs are removed from the worker's global and its prototype chain (and
 * from `navigator`) and replaced by non-configurable getters that return `undefined`. The script then has no reference
 * to them and, with `Worker` gone, no other realm to get them from.
 */
export const WORKER_LOCKDOWN = `
(function () {
  "use strict";
  var names = ["fetch", "fetchLater", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker"];
  function gone() { return undefined; }
  function hide(obj, name) {
    try {
      Object.defineProperty(obj, name, { get: gone, set: function () {}, configurable: false, enumerable: false });
    } catch (e) {
      try { delete obj[name]; } catch (e2) {}
    }
  }
  function sweep(start, list) {
    for (var o = start; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      list.forEach(function (n) { if (Object.prototype.hasOwnProperty.call(o, n)) hide(o, n); });
    }
  }
  sweep(self, names);
  names.forEach(function (n) { hide(self, n); });
  if (typeof navigator === "object" && navigator) {
    sweep(navigator, ["sendBeacon"]);
    hide(navigator, "sendBeacon");
  }
})();
`;

/**
 * Defines the frozen `nimble` API (version 1) and talks to the iframe with `postMessage`; the iframe passes the
 * well-formed messages on to the app, and the app validates every one of them.
 */
export const WORKER_API = `
(function () {
  "use strict";
  var post = self.postMessage.bind(self);
  var nextId = 1;
  var pending = new Map();
  var handlers = new Map();
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ id: id, method: method, params: params || {} });
    });
  }
  self.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.method === "command.run") {
      var h = handlers.get(m.params && m.params.command);
      Promise.resolve()
        .then(function () {
          if (!h) throw new Error("No handler registered for " + (m.params && m.params.command));
          return h(m.params.context || {});
        })
        .then(function () { post({ id: m.id, result: null }); },
              function (err) { post({ id: m.id, error: String((err && err.message) || err) }); });
      return;
    }
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  self.addEventListener("error", function (e) {
    post({ event: "error", message: String(e.message || e) });
  });
  self.addEventListener("unhandledrejection", function (e) {
    post({ event: "error", message: String((e.reason && e.reason.message) || e.reason) });
  });
  var api = {
    version: 1,
    commands: {
      register: function (id, fn) {
        if (typeof fn !== "function") throw new TypeError("handler must be a function");
        handlers.set(String(id), fn);
        return call("commands.register", { id: String(id) });
      }
    },
    editor: {
      getText: function () { return call("editor.getText"); },
      getSelection: function () { return call("editor.getSelection"); },
      getLanguage: function () { return call("editor.getLanguage"); },
      getFileName: function () { return call("editor.getFileName"); },
      replaceSelection: function (text) { return call("editor.replaceSelection", { text: String(text) }); },
      replaceAll: function (text) { return call("editor.replaceAll", { text: String(text) }); },
      insertText: function (text) { return call("editor.insertText", { text: String(text) }); }
    },
    ui: {
      message: function (text, kind) { return call("ui.message", { text: String(text), kind: kind }); },
      prompt: function (o) { o = o || {}; return call("ui.prompt", { title: String(o.title || ""), placeholder: o.placeholder === undefined ? undefined : String(o.placeholder), value: o.value === undefined ? undefined : String(o.value) }); },
      pick: function (o) { o = o || {}; return call("ui.pick", { title: String(o.title || ""), items: (o.items || []).map(String) }); }
    },
    clipboard: { writeText: function (text) { return call("clipboard.writeText", { text: String(text) }); } },
    storage: {
      get: function (key) { return call("storage.get", { key: String(key) }); },
      set: function (key, value) { return call("storage.set", { key: String(key), value: String(value) }); },
      remove: function (key) { return call("storage.remove", { key: String(key) }); }
    }
  };
  Object.freeze(api.commands); Object.freeze(api.editor); Object.freeze(api.ui);
  Object.freeze(api.clipboard); Object.freeze(api.storage);
  Object.defineProperty(self, "nimble", { value: Object.freeze(api), writable: false, configurable: false });
  post({ event: "ready" });
})();
`;

/** What runs in the worker before the extension's script: the heartbeat, then the lockdown, then the `nimble` API. */
export const WORKER_BOOTSTRAP = WORKER_HEARTBEAT + WORKER_LOCKDOWN + WORKER_API;

/**
 * Runs in the sandbox iframe and is the only script of ours that runs there. It needs these globals, which the
 * document declares in an earlier script: `NN_WORKER_SOURCE` (the worker bootstrap followed by the extension's
 * script), `NN_COMMAND_TIMEOUT_MS`, `NN_PING_MS` and `NN_UNRESPONSIVE_MS`.
 *
 * It builds the blob worker and relays messages between the worker and the app. From the worker it passes on only a
 * well-formed request, reply, `ready` or `error` event; anything else is dropped. It keeps two clocks:
 *
 * - The command clock. When a command has not answered in time it calls `worker.terminate()`, which stops even a loop
 *   that never ends, and tells the app with `{ event: "timeout", id }`. The app can pause it (`{ control: "hold" }`
 *   and `{ control: "release" }`) while a dialog it drew is waiting for the user.
 * - The heartbeat. A script can answer a command early and then loop, or loop at the top level, which the command
 *   clock cannot see. So every `NN_PING_MS` the worker is pinged with a fresh random nonce, and if a ping is still
 *   unanswered after `NN_UNRESPONSIVE_MS` the worker is terminated and the app told with `{ event: "unresponsive" }`.
 *   A busy but healthy worker answers as soon as its current step ends, so a step shorter than the limit is fine. The
 *   heartbeat does not pause for dialogs: a worker that is waiting for the app is idle and answers.
 *
 * If the worker cannot be created, or its script does not parse, the app is told with
 * `{ event: "worker-failed", message }`. The blob URL is revoked as soon as the worker has started (or failed).
 */
export const IFRAME_BOOTSTRAP = `
(function () {
  "use strict";
  var host = window.parent;
  var worker = null;
  var ready = false;
  var holds = 0;
  var blobUrl = null;
  var beatTimer = null;
  var runs = new Map(); // id of a running command -> { left, armedAt, handle }
  var pings = new Map(); // nonce of an unanswered ping -> { handle }

  function toHost(m) { host.postMessage(m, "*"); }
  function revoke() {
    if (blobUrl === null) return;
    try { URL.revokeObjectURL(blobUrl); } catch (e) {}
    blobUrl = null;
  }
  function stopClocks() {
    runs.forEach(function (r) { if (r.handle !== null) clearTimeout(r.handle); });
    runs.clear();
    pings.forEach(function (p) { clearTimeout(p.handle); });
    pings.clear();
    if (beatTimer !== null) { clearInterval(beatTimer); beatTimer = null; }
  }
  // Stops the worker for good and tells the app why.
  function stop(report) {
    stopClocks();
    if (worker) { worker.terminate(); worker = null; }
    revoke();
    toHost(report);
  }
  function fail(err) {
    stop({ event: "worker-failed", message: String((err && err.message) || err).slice(0, 300) });
  }

  function arm(id, r) {
    r.armedAt = Date.now();
    r.handle = setTimeout(function () { if (runs.has(id)) stop({ event: "timeout", id: id }); }, r.left);
  }
  function hold() {
    if (holds++ !== 0) return;
    var now = Date.now();
    runs.forEach(function (r) {
      if (r.handle !== null) clearTimeout(r.handle);
      r.handle = null;
      r.left = Math.max(0, r.left - (now - r.armedAt));
    });
  }
  function release() {
    if (holds === 0) return;
    if (--holds === 0) runs.forEach(function (r, id) { arm(id, r); });
  }

  function nonce() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
    return s;
  }
  function beat() {
    if (!worker) return;
    var n = nonce();
    // One more short look after the deadline, so that an answer that is already queued (after the machine slept, say)
    // is read before the worker is given up on.
    var handle = setTimeout(function () {
      setTimeout(function () { if (pings.has(n)) stop({ event: "unresponsive" }); }, 250);
    }, NN_UNRESPONSIVE_MS);
    pings.set(n, { handle: handle });
    worker.postMessage({ control: "ping", nonce: n });
  }

  // The only messages that go on to the app: a request { id, method, params }, the answer to a command
  // { id, result: null } or { id, error }, { event: "ready" } and { event: "error", message }. Text is cut short.
  function clean(d) {
    if (!d || typeof d !== "object") return null;
    if (typeof d.event === "string") {
      if (d.event === "ready") return { event: "ready" };
      if (d.event === "error" && typeof d.message === "string") return { event: "error", message: d.message.slice(0, 300) };
      return null;
    }
    if (!Number.isSafeInteger(d.id)) return null;
    if ("method" in d) {
      if (typeof d.method !== "string" || d.method.length > 64) return null;
      if (d.params === undefined) return { id: d.id, method: d.method };
      if (!d.params || typeof d.params !== "object" || Array.isArray(d.params)) return null;
      return { id: d.id, method: d.method, params: d.params };
    }
    if (typeof d.error === "string") return { id: d.id, error: d.error.slice(0, 300) };
    if (d.result === null && !("error" in d)) return { id: d.id, result: null };
    return null;
  }

  try {
    blobUrl = URL.createObjectURL(new Blob([NN_WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(blobUrl);
  } catch (err) {
    worker = null;
    fail(err);
    return;
  }
  worker.onmessage = function (e) {
    var d = e.data;
    if (d && typeof d === "object" && d.control === "pong") {
      var p = typeof d.nonce === "string" ? pings.get(d.nonce) : undefined;
      if (p) { clearTimeout(p.handle); pings.delete(d.nonce); }
      return;
    }
    var m = clean(d);
    if (!m) return;
    if (m.event === "ready") { ready = true; revoke(); }
    // The answer to a command ends its clock.
    if (!("event" in m) && !("method" in m) && runs.has(m.id)) {
      var r = runs.get(m.id);
      if (r.handle !== null) clearTimeout(r.handle);
      runs.delete(m.id);
    }
    toHost(m);
  };
  // A script that does not parse never gets to run the bootstrap, so it can only be reported from here. Errors after
  // the start are reported by the worker bootstrap itself.
  worker.onerror = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!ready) fail((e && e.message) || "the extension script could not be loaded");
  };
  beatTimer = setInterval(beat, NN_PING_MS);

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== host || !m || typeof m !== "object") return;
    if (typeof m.control === "string") {
      if (m.control === "hold") hold();
      else if (m.control === "release") release();
      return;
    }
    if (!worker) return;
    if (m.method === "command.run" && typeof m.id === "number") {
      var run = { left: NN_COMMAND_TIMEOUT_MS, armedAt: 0, handle: null };
      runs.set(m.id, run);
      if (holds === 0) arm(m.id, run);
    }
    worker.postMessage(m);
  });
})();
`;

/**
 * The two scripts that make up an extension's sandbox. Both are written as strings because they are embedded in the
 * sandbox document (see `buildSrcdoc`), and both are written as plain ES5-style code with no imports.
 *
 *   host (app window)  <->  IFRAME_BOOTSTRAP (sandbox iframe)  <->  WORKER_BOOTSTRAP + extension script (Web Worker)
 *
 * The extension's script runs in a dedicated Web Worker, never in the iframe's window. A worker has no DOM, cannot
 * create frames and has no WebRTC (`RTCPeerConnection` only exists in `Window`), and the CSP of the sandbox document
 * (`worker-src blob:`, everything else `'none'`) is inherited by the worker. So there is no child frame to recover a
 * WebRTC constructor from, and `terminate()` can stop a script that never returns. See docs/extensions.md.
 */

/**
 * Runs inside the Web Worker, before the extension's script (they are concatenated into one blob worker). Defines
 * the frozen `nimble` API (version 1) and talks to the iframe with `postMessage`; the iframe passes the messages on
 * to the app unchanged, and the app validates every one of them.
 */
export const WORKER_BOOTSTRAP = `
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

/**
 * Runs in the sandbox iframe and is the only script of ours that runs there. It needs two globals that the document
 * declares in an earlier script: `NN_WORKER_SOURCE` (the worker bootstrap followed by the extension's script) and
 * `NN_COMMAND_TIMEOUT_MS`.
 *
 * It builds the blob worker, passes messages between the worker and the app unchanged, and owns the command
 * timeout: when a command has not answered in time it calls `worker.terminate()`, which stops even a loop that
 * never ends, and tells the app with `{ event: "timeout", id }`. The app can pause the clock (`{ control: "hold" }`
 * and `{ control: "release" }`) while a dialog it drew is waiting for the user. If the worker cannot be created, or
 * its script does not parse, the app is told with `{ event: "worker-failed", message }`.
 */
export const IFRAME_BOOTSTRAP = `
(function () {
  "use strict";
  var host = window.parent;
  var worker = null;
  var ready = false;
  var holds = 0;
  var runs = new Map(); // id of a running command -> { left, armedAt, handle }

  function toHost(m) { host.postMessage(m, "*"); }
  function fail(err) { toHost({ event: "worker-failed", message: String((err && err.message) || err).slice(0, 300) }); }

  function arm(id, r) {
    r.armedAt = Date.now();
    r.handle = setTimeout(function () { expire(id); }, r.left);
  }
  function stopClocks() {
    runs.forEach(function (r) { if (r.handle !== null) clearTimeout(r.handle); });
    runs.clear();
  }
  function expire(id) {
    if (!runs.has(id)) return;
    stopClocks();
    if (worker) { worker.terminate(); worker = null; }
    toHost({ event: "timeout", id: id });
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

  try {
    var url = URL.createObjectURL(new Blob([NN_WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch (err) {
    worker = null;
    fail(err);
    return;
  }
  worker.onmessage = function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.event === "ready") ready = true;
    // The answer to a command ends its clock.
    if (!("method" in d) && ("result" in d || "error" in d) && runs.has(d.id)) {
      var r = runs.get(d.id);
      if (r.handle !== null) clearTimeout(r.handle);
      runs.delete(d.id);
    }
    toHost(d);
  };
  // A script that does not parse never gets to run the bootstrap, so it can only be reported from here. Errors after
  // the start are reported by the worker bootstrap itself.
  worker.onerror = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!ready) fail((e && e.message) || "the extension script could not be loaded");
  };

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

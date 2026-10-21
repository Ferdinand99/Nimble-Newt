/**
 * The script that defines the `nimble` API inside an extension's sandbox. It runs before the extension's own script,
 * talks to the app only through postMessage and exposes a frozen object. Written as a string because it is embedded
 * in the sandbox document.
 */
export const BOOTSTRAP = `
(function () {
  "use strict";
  var host = window.parent;
  // WebRTC is not covered by CSP; removing it here is defence in depth only (see docs/extensions.md).
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"].forEach(function (n) {
    try { Object.defineProperty(window, n, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  var nextId = 1;
  var pending = new Map();
  var handlers = new Map();
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      host.postMessage({ id: id, method: method, params: params || {} }, "*");
    });
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== host || !m || typeof m !== "object") return;
    if (m.method === "command.run") {
      var h = handlers.get(m.params && m.params.command);
      Promise.resolve()
        .then(function () {
          if (!h) throw new Error("No handler registered for " + (m.params && m.params.command));
          return h(m.params.context || {});
        })
        .then(function () { host.postMessage({ id: m.id, result: null }, "*"); },
              function (err) { host.postMessage({ id: m.id, error: String((err && err.message) || err) }, "*"); });
      return;
    }
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  window.addEventListener("error", function (e) {
    host.postMessage({ event: "error", message: String(e.message || e) }, "*");
  });
  window.addEventListener("unhandledrejection", function (e) {
    host.postMessage({ event: "error", message: String((e.reason && e.reason.message) || e.reason) }, "*");
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
  Object.defineProperty(window, "nimble", { value: Object.freeze(api), writable: false, configurable: false });
  host.postMessage({ event: "ready" }, "*");
})();
`;

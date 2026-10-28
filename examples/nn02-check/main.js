// NN-02 check. A test extension for the Nimble Newt sandbox. Run "NN-02 check" from the Tools menu or the command
// palette. It tries the usual ways out of an extension's sandbox and shows ONE message:
//   green  = every attempt was blocked, the code runs in a Worker and has no WebRTC and no DOM
//   red    = lists what got through.
// It only ever talks to 127.0.0.1 on an unused port (59871). Nothing leaves the machine. To see a "got through" even
// for a bare TCP connect, start a listener first (optional): python -m http.server 59871 --bind 127.0.0.1
// and check that its log stays empty. It needs no permission except showing the result (ui). See README.md.
nimble.commands.register("check", async function () {
  var HOST = "127.0.0.1:59871";
  var HTTP = "http://" + HOST;
  var WS = "ws://" + HOST;
  var inWindow = typeof document !== "undefined" || typeof window !== "undefined";
  var violations = 0;
  try { self.addEventListener("securitypolicyviolation", function () { violations++; }); } catch (e) {}

  var through = []; // attempts that succeeded = a hole
  var blocked = 0;
  var notes = [];
  function cap(ms, p) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r("timeout"); }, ms); })]); }
  // fn resolves to "through" when the attempt worked, "na" when the API is not there; rejection / anything else = blocked
  async function attempt(name, fn) {
    try {
      var r = await cap(2800, Promise.resolve().then(fn));
      if (r === "through") through.push(name); else if (r === "na") notes.push(name + " n/a"); else blocked++;
    } catch (e) { blocked++; }
  }
  function evt(make, openEvents) {
    return new Promise(function (res) {
      var o; try { o = make(); } catch (e) { return res("blocked"); }
      openEvents.forEach(function (n) { o[n] = function () { res("through"); }; });
      o.onerror = function () { res("blocked"); };
      o.onclose = function () { res("blocked"); };
    });
  }

  var tests = [];
  // 1. Where does the extension run? (old design: in the iframe window; new design: in a Worker)
  if (inWindow) through.push("runs in a window (not a worker)");

  // 2. WebRTC: constructors in this global, and (if there is a document) in a fresh child frame
  ["RTCPeerConnection", "webkitRTCPeerConnection"].forEach(function (n) {
    if (typeof self[n] === "function") through.push("WebRTC " + n + " exists");
  });
  try {
    if (typeof RTCPeerConnection === "function") through.push("WebRTC RTCPeerConnection (global)");
  } catch (e) {}
  if (typeof document !== "undefined") {
    tests.push(attempt("WebRTC via child frame", function () {
      return new Promise(function (res) {
        var f = document.createElement("iframe");
        window.addEventListener("message", function (e) { if (e.source === f.contentWindow) res(e.data === "function" ? "through" : "blocked"); });
        f.srcdoc = "<script>parent.postMessage(typeof RTCPeerConnection, '*')<\/script>";
        document.body.appendChild(f);
      });
    }));
  }

  // 3. Network
  tests.push(attempt("fetch", function () { return fetch(HTTP + "/f").then(function () { return "through"; }); }));
  tests.push(attempt("fetch no-cors", function () { return fetch(HTTP + "/n", { mode: "no-cors" }).then(function () { return "through"; }); }));
  tests.push(attempt("fetch keepalive", function () { return fetch(HTTP + "/k", { method: "POST", body: "x", keepalive: true, mode: "no-cors" }).then(function () { return "through"; }); }));
  tests.push(attempt("XMLHttpRequest", function () {
    if (typeof XMLHttpRequest === "undefined") return "na";
    return new Promise(function (res) { var x = new XMLHttpRequest(); x.open("GET", HTTP + "/x"); x.onload = function () { res("through"); }; x.onerror = function () { res("blocked"); }; x.send(); });
  }));
  tests.push(attempt("WebSocket", function () { return evt(function () { return new WebSocket(WS + "/w"); }, ["onopen"]); }));
  tests.push(attempt("EventSource", function () { return typeof EventSource === "undefined" ? "na" : evt(function () { return new EventSource(HTTP + "/e"); }, ["onopen"]); }));
  tests.push(attempt("WebTransport", function () {
    if (typeof WebTransport === "undefined") return "na";
    var wt = new WebTransport("https://" + HOST + "/t");
    return wt.ready.then(function () { return "through"; });
  }));
  tests.push(attempt("importScripts", function () { if (typeof importScripts !== "function") return "na"; importScripts(HTTP + "/i.js"); return "through"; }));
  tests.push(attempt("dynamic import()", function () { return import(HTTP + "/m.js").then(function () { return "through"; }); }));
  tests.push(attempt("sendBeacon", function () { return typeof navigator.sendBeacon === "function" ? (navigator.sendBeacon(HTTP + "/b", "x") ? "through" : "blocked") : "na"; }));
  tests.push(attempt("Worker from http URL", function () {
    return new Promise(function (res) { var w = new Worker(HTTP + "/w.js"); w.onmessage = function () { res("through"); }; w.onerror = function () { res("blocked"); }; });
  }));
  tests.push(attempt("Worker from data: URL", function () {
    return new Promise(function (res) { var w = new Worker("data:text/javascript,postMessage(1)"); w.onmessage = function () { res("through"); }; w.onerror = function () { res("blocked"); }; });
  }));
  tests.push(attempt("SharedWorker", function () { return typeof SharedWorker === "undefined" ? "na" : "blocked"; }));

  // 4. A worker made inside the extension: it must inherit the same limits and have no WebRTC either
  tests.push(attempt("nested Worker (fetch/WebSocket/WebRTC)", function () {
    return new Promise(function (res) {
      var code =
        "var bad=[];if(typeof RTCPeerConnection==='function'||typeof webkitRTCPeerConnection==='function')bad.push('WebRTC');" +
        "fetch('" + HTTP + "/nf').then(function(){bad.push('fetch')},function(){}).then(function(){" +
        "return new Promise(function(r){try{var w=new WebSocket('" + WS + "/nw');w.onopen=function(){bad.push('WebSocket');r()};w.onerror=function(){r()};w.onclose=function(){r()}}catch(e){r()}})" +
        "}).then(function(){postMessage(bad)});";
      var w;
      try { w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); } catch (e) { return res("blocked"); }
      w.onerror = function () { res("blocked"); };
      w.onmessage = function (e) { if (e.data && e.data.length) { e.data.forEach(function (b) { through.push("nested worker: " + b); }); res("blocked"); } else res("blocked"); };
    });
  }));

  await Promise.all(tests);

  var ok = through.length === 0;
  var where = inWindow ? "window" : "worker";
  var text = ok
    ? "NN-02 check: all blocked. Runs in a " + where + ", no WebRTC, " + blocked + " network attempts failed" + (violations ? " (" + violations + " CSP violations seen)" : "") + (notes.length ? ". Not present: " + notes.join(", ") : "") + "."
    : "NN-02 check FAILED. Got through: " + through.join("; ") + ".";
  await nimble.ui.message(text.slice(0, 480), ok ? "success" : "error");
});

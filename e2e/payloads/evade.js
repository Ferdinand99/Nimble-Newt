// Hostile ways to get around the command timeout, and forged messages. The extension shares the worker's global with
// our bootstrap, so it can listen to every message too.

function beatLoop() {
  postMessage({ event: "error", message: "spinning" });
  for (;;) {
    var t = Date.now();
    while (Date.now() - t < 5) {}
    postMessage({ event: "error", message: "beat" });
  }
}

// 1. Answer the command early from our own listener (this clears the iframe's command clock), then loop for ever.
self.addEventListener("message", function (e) {
  var m = e.data;
  if (m && m.method === "command.run" && m.params && m.params.command === "evade") {
    postMessage({ id: m.id, result: null });
    beatLoop();
  }
});
nimble.commands.register("evade", function () { return new Promise(function () {}); });

// 3. A command that finishes normally and leaves a loop behind.
nimble.commands.register("late", function () { setTimeout(beatLoop, 50); });

// A legitimate command that blocks the worker for a while (a long synchronous step).
nimble.commands.register("block", function () {
  var t = Date.now();
  while (Date.now() - t < 1200) {}
});

// 6. Forged messages to the app, as if they came from the iframe.
nimble.commands.register("forge", function () {
  postMessage({ event: "timeout", id: 12345 });
  postMessage({ event: "timeout", id: 1 });
  postMessage({ event: "worker-failed", message: "forged" });
  postMessage({ event: "unresponsive" });
  postMessage({ control: "hold" });
  postMessage({ control: "release" });
  postMessage({ control: "pong", nonce: "guess" });
  postMessage({ event: "ready" , extra: "forged" });
  postMessage({ event: "error", message: "forged-but-allowed" });
});

// A command that spins, to see that a forged hold did not stop the command clock.
nimble.commands.register("spin", beatLoop);

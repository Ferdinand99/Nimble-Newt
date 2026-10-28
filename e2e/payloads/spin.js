// Commands that misbehave. "spin" never returns but shows signs of life every few milliseconds, so the test can see
// the moment it really stops. "slow" takes 700 ms. "quick" returns at once.
nimble.commands.register("spin", function () {
  postMessage({ event: "spinning" });
  for (;;) {
    var t = Date.now();
    while (Date.now() - t < 5) {}
    postMessage({ event: "beat" });
  }
});
nimble.commands.register("slow", function () { return new Promise(function (r) { setTimeout(r, 700); }); });
nimble.commands.register("quick", function () { return Promise.resolve(); });

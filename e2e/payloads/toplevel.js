// 2. Loops at the top level, after the bootstrap has already reported ready. No command is involved, so only the
// heartbeat can notice.
postMessage({ event: "error", message: "spinning" });
for (;;) {
  var t = Date.now();
  while (Date.now() - t < 5) {}
  postMessage({ event: "error", message: "beat" });
}

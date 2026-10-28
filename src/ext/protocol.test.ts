import { describe, expect, it } from "vitest";
import { buildSrcdoc, checkEvent, checkReply, checkRequest, escapeInlineScript, LIMITS, METHOD_PERMISSION, PERMISSIONS, RateLimiter, type Permission } from "./protocol";

const all: Permission[] = [...PERMISSIONS];
const req = (method: string, params: Record<string, unknown> = {}, granted: Permission[] = all, id = 1) => checkRequest({ id, method, params }, granted);

describe("checkRequest", () => {
  it("accepts well-formed calls", () => {
    expect(req("editor.getText").ok).toBe(true);
    expect(req("editor.replaceAll", { text: "x" }).ok).toBe(true);
    expect(req("ui.message", { text: "hi", kind: "success" }).ok).toBe(true);
    expect(req("ui.pick", { title: "t", items: ["a", "b"] }).ok).toBe(true);
    expect(req("storage.set", { key: "k", value: "v" }).ok).toBe(true);
    expect(req("commands.register", { id: "sayHi" }, []).ok).toBe(true);
  });
  it("rejects malformed messages", () => {
    for (const bad of [null, 5, "x", [], {}, { id: 1 }, { method: "editor.getText" }, { id: "1", method: "editor.getText" }, { id: 1.5, method: "editor.getText" }]) {
      expect(checkRequest(bad, all).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("rejects unknown methods, including prototype tricks", () => {
    for (const m of ["fs.read", "constructor", "__proto__", "toString", "editor.getText ", ""]) expect(req(m).ok, m).toBe(false);
  });
  it("enforces permissions per method", () => {
    for (const [method, need] of Object.entries(METHOD_PERMISSION)) {
      if (!need) continue;
      const others = all.filter((p) => p !== need);
      const params = { text: "x", key: "k", value: "v", title: "t", items: ["a"], id: "a" };
      expect(req(method, params, others).ok, `${method} without ${need}`).toBe(false);
      expect(req(method, params, [need]).ok, `${method} with ${need}`).toBe(true);
    }
  });
  it("validates arguments", () => {
    expect(req("editor.insertText", { text: 5 }).ok).toBe(false);
    expect(req("editor.insertText", {}).ok).toBe(false);
    expect(req("editor.replaceAll", { text: "x".repeat(LIMITS.textBytes + 1) }).ok).toBe(false);
    expect(req("ui.message", { text: "x".repeat(LIMITS.messageChars + 1) }).ok).toBe(false);
    expect(req("ui.message", { text: "x", kind: "fatal" }).ok).toBe(false);
    expect(req("ui.pick", { title: "t", items: [] }).ok).toBe(false);
    expect(req("ui.pick", { title: "t", items: [1] }).ok).toBe(false);
    expect(req("ui.pick", { title: "t", items: Array(LIMITS.items + 1).fill("a") }).ok).toBe(false);
    expect(req("storage.get", { key: "k".repeat(LIMITS.keyChars + 1) }).ok).toBe(false);
    expect(req("storage.set", { key: "k", value: "v".repeat(LIMITS.valueChars + 1) }).ok).toBe(false);
    expect(req("commands.register", { id: "9bad" }).ok).toBe(false);
    expect(req("commands.register", { id: "a b" }).ok).toBe(false);
  });
  it("counts bytes, not characters, for text limits", () => {
    expect(req("editor.replaceAll", { text: "é".repeat(LIMITS.textBytes / 2 + 1) }).ok).toBe(false);
  });
  it("ignores extra params and non-object params", () => {
    expect(req("editor.getText", { junk: 1 }).ok).toBe(true);
    expect(checkRequest({ id: 1, method: "editor.getText", params: [1] }, all).ok).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to the limit, then blocks until the window passes", () => {
    const l = new RateLimiter(3, 1000);
    expect([l.allow(0), l.allow(1), l.allow(2), l.allow(3)]).toEqual([true, true, true, false]);
    expect(l.allow(999)).toBe(false);
    expect(l.allow(1000)).toBe(true);
  });
});

describe("srcdoc", () => {
  const worker = "WORKER_SOURCE";
  it("cannot be broken out of with a closing script tag", () => {
    const evil = 'var s = "</script><img src=x onerror=alert(1)>"; </SCRIPT ><!-- x';
    const doc = buildSrcdoc("boot();", worker + evil);
    expect(doc.match(/<\/script>/gi)?.length).toBe(2); // only our own two closing tags
    expect(doc).not.toMatch(/<!--/);
    expect(doc).not.toContain("<img");
    expect(escapeInlineScript("a</script>b")).toBe("a<\\/script>b");
  });
  it("hands the extension's script over as a string that round-trips exactly", () => {
    const nasty = 'a</script>b<!--c--> `${x}` "q" \\ \u2028 \n é';
    const doc = buildSrcdoc("boot();", nasty);
    const m = /var NN_WORKER_SOURCE=(.*?);var NN_COMMAND_TIMEOUT_MS=/s.exec(doc);
    expect(JSON.parse(m![1])).toBe(nasty);
  });
  it("runs only our bootstrap in the document; the extension's script is data, not a script element", () => {
    const doc = buildSrcdoc("boot();", "EXTENSION_CODE();");
    expect(doc.match(/<script>/g)?.length).toBe(2);
    expect(doc.split("<script>")[2]).toBe("boot();</script></body></html>");
  });
  it("tells the bootstrap the command timeout and the heartbeat", () => {
    const doc = buildSrcdoc("", "");
    expect(doc).toContain(`var NN_COMMAND_TIMEOUT_MS=${LIMITS.commandTimeoutMs};`);
    expect(doc).toContain(`var NN_PING_MS=${LIMITS.heartbeatMs};`);
    expect(doc).toContain(`var NN_UNRESPONSIVE_MS=${LIMITS.unresponsiveMs};`);
    const short = buildSrcdoc("", "", { commandTimeoutMs: 400.7, heartbeatMs: 100, unresponsiveMs: 900 });
    expect(short).toContain("var NN_COMMAND_TIMEOUT_MS=400;");
    expect(short).toContain("var NN_PING_MS=100;");
    expect(short).toContain("var NN_UNRESPONSIVE_MS=900;");
  });
  it("keeps the heartbeat shorter than the limit it enforces", () => {
    expect(LIMITS.heartbeatMs).toBeLessThan(LIMITS.unresponsiveMs);
  });
  it("starts with a policy that blocks all network and resources, and allows only the blob worker", () => {
    const doc = buildSrcdoc("", "");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("worker-src blob:");
    expect(doc).not.toContain("connect-src");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
  });
});

describe("checkEvent", () => {
  it("accepts the events the iframe reports and cuts their text", () => {
    expect(checkEvent({ event: "ready", x: 1 })).toEqual({ event: "ready" });
    expect(checkEvent({ event: "unresponsive" })).toEqual({ event: "unresponsive" });
    expect(checkEvent({ event: "timeout", id: 4 })).toEqual({ event: "timeout", id: 4 });
    expect(checkEvent({ event: "error", message: "m" })).toEqual({ event: "error", message: "m" });
    expect(checkEvent({ event: "worker-failed", message: "x".repeat(10_000) })).toEqual({ event: "worker-failed", message: "x".repeat(LIMITS.eventChars) });
    expect(checkEvent({ event: "error", message: { toString: () => "evil" } })).toEqual({ event: "error", message: "" });
    expect(checkEvent({ event: "error" })).toEqual({ event: "error", message: "" });
  });
  it("rejects what is not an event, including prototype tricks", () => {
    for (const bad of [{ event: "beat" }, { event: "constructor" }, { event: "__proto__" }, { event: 5 }, { event: "timeout" }, { event: "timeout", id: "1" }, { event: "timeout", id: 1.5 }, {}]) {
      expect(checkEvent(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("checkReply", () => {
  it("accepts a success with a null result and an error with text", () => {
    expect(checkReply({ id: 1, result: null })).toEqual({ id: 1 });
    expect(checkReply({ id: 2, error: "bad" })).toEqual({ id: 2, error: "bad" });
    expect(checkReply({ id: 2, error: "" })).toEqual({ id: 2, error: "" });
    expect(checkReply({ id: 2, error: "e".repeat(10_000) })).toEqual({ id: 2, error: "e".repeat(LIMITS.eventChars) });
  });
  it("rejects anything else", () => {
    for (const bad of [{ id: 1 }, { id: 1, result: "x" }, { id: 1, result: { big: 1 } }, { id: 1, error: 5 }, { id: 1, error: { x: 1 } }, { id: "1", result: null }, { id: 1.5, result: null }, { id: 1, method: "x", result: null }, { result: null }]) {
      expect(checkReply(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
    }
  });
});

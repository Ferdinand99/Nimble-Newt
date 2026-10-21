import { describe, expect, it } from "vitest";
import { buildSrcdoc, checkRequest, escapeInlineScript, LIMITS, METHOD_PERMISSION, PERMISSIONS, RateLimiter, type Permission } from "./protocol";

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
  it("cannot be broken out of with a closing script tag", () => {
    const evil = 'var s = "</script><img src=x onerror=alert(1)>"; </SCRIPT ><!-- x';
    const doc = buildSrcdoc("boot();", evil);
    expect(doc.match(/<\/script>/gi)?.length).toBe(2); // only our own two closing tags
    expect(doc).not.toMatch(/<!--/);
    expect(escapeInlineScript("a</script>b")).toBe("a<\\/script>b");
  });
  it("starts with a policy that blocks all network and resources", () => {
    const doc = buildSrcdoc("", "");
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("connect-src");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
  });
});

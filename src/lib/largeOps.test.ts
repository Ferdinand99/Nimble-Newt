import { describe, expect, it } from "vitest";
import { LargeOps } from "./largeOps";

describe("large file operations", () => {
  it("gives every operation its own id", () => {
    const o = new LargeOps();
    const a = o.start("search");
    const b = o.start("count");
    expect(a.op).not.toBe(b.op);
  });
  it("supersedes only an older operation of the same kind", () => {
    const o = new LargeOps();
    const count = o.start("count");
    const s1 = o.start("search");
    expect(s1.stale).toBeNull();
    const s2 = o.start("search");
    expect(s2.stale).toBe(s1.op);
    expect(o.isCurrent("search", s1.op)).toBe(false);
    expect(o.isCurrent("search", s2.op)).toBe(true);
    expect(o.isCurrent("count", count.op)).toBe(true);
  });
  it("ignores the end of a superseded operation", () => {
    const o = new LargeOps();
    const s1 = o.start("search");
    const s2 = o.start("search");
    expect(o.finish("search", s1.op)).toBe(false);
    expect(o.running("search")).toBe(s2.op);
    expect(o.finish("search", s2.op)).toBe(true);
    expect(o.running("search")).toBeNull();
  });
});

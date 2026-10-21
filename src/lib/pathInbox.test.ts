import { describe, expect, it } from "vitest";
import { PathInbox } from "./pathInbox";

describe("PathInbox", () => {
  it("keeps paths that arrive before a handler exists, in order, and delivers them once", () => {
    const inbox = new PathInbox();
    inbox.push(["a", "b"]);
    inbox.push(["c"]);
    const got: string[][] = [];
    inbox.attach((p) => got.push(p));
    expect(got).toEqual([["a", "b", "c"]]);
    inbox.attach((p) => got.push(p));
    expect(got).toHaveLength(1);
  });
  it("passes later paths straight to the handler", () => {
    const inbox = new PathInbox();
    const got: string[][] = [];
    inbox.attach((p) => got.push(p));
    inbox.push(["x"]);
    inbox.push([]);
    expect(got).toEqual([["x"]]);
  });
});

import { describe, expect, it } from "vitest";
import { isLossy, lossyPlan } from "./saveLossy";

describe("lossy save helpers", () => {
  it("recognises the lossy error from the backend", () => {
    expect(isLossy({ kind: "lossy", message: "x" })).toBe(true);
    expect(isLossy({ kind: "conflict", message: "x" })).toBe(false);
    expect(isLossy({ kind: "other", message: "x" })).toBe(false);
    expect(isLossy("lossy")).toBe(false);
    expect(isLossy(null)).toBe(false);
  });
  it("switches to UTF-8 without allowing loss", () => {
    expect(lossyPlan("utf8")).toEqual({ encoding: "UTF-8", allowLossy: false });
  });
  it("saves anyway in the same encoding", () => {
    expect(lossyPlan("anyway")).toEqual({ encoding: null, allowLossy: true });
  });
  it("writes nothing on cancel", () => {
    expect(lossyPlan("cancel")).toBeNull();
  });
});

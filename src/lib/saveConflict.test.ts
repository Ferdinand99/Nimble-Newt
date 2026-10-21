import { describe, expect, it } from "vitest";
import { expectedMtime, isConflict } from "./saveConflict";

describe("save conflict helpers", () => {
  it("sends the last seen mtime for existing files only", () => {
    expect(expectedMtime({ path: "/a", savedMtime: 42 }, false)).toBe(42);
    expect(expectedMtime({ path: null, savedMtime: null }, false)).toBeNull();
    expect(expectedMtime({ path: "/a", savedMtime: null }, false)).toBeNull();
  });
  it("sends nothing for Save As or a confirmed overwrite", () => {
    expect(expectedMtime({ path: "/a", savedMtime: 42 }, true)).toBeNull();
  });
  it("recognises the conflict error from the backend", () => {
    expect(isConflict({ kind: "conflict", message: "x" })).toBe(true);
    expect(isConflict({ kind: "other", message: "x" })).toBe(false);
    expect(isConflict("disk full")).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  basename,
  columnSelectRanges,
  detectIndent,
  dirname,
  dropIndex,
  formatShortcut,
  fuzzyFilter,
  fuzzyScore,
  nextUntitledName,
  pushRecent,
  reorder,
} from "./logic";

describe("reorder / dropIndex", () => {
  it("moves items", () => {
    expect(reorder([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(reorder([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(reorder([1, 2], 5, 0)).toEqual([1, 2]);
    expect(reorder([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
  });
  it("finds the drop slot from midpoints", () => {
    expect(dropIndex([50, 150, 250], 10)).toBe(0);
    expect(dropIndex([50, 150, 250], 160)).toBe(2);
    expect(dropIndex([50, 150, 250], 999)).toBe(3);
  });
});

describe("detectIndent", () => {
  it("detects tabs", () => {
    expect(detectIndent("a\n\tb\n\tc\n")).toEqual({ useTabs: true, size: 4 });
  });
  it("detects 2 and 4 spaces", () => {
    expect(detectIndent("a:\n  b:\n    c: 1\n  d: 2\n")).toEqual({ useTabs: false, size: 2 });
    expect(detectIndent("fn a() {\n    b();\n    if x {\n        c();\n    }\n}\n")).toEqual({ useTabs: false, size: 4 });
  });
  it("returns null without evidence", () => {
    expect(detectIndent("one\ntwo\n")).toBeNull();
    expect(detectIndent("")).toBeNull();
  });
});

describe("names and paths", () => {
  it("numbers untitled tabs without reusing names", () => {
    expect(nextUntitledName([], "Untitled")).toBe("Untitled 1");
    expect(nextUntitledName(["Untitled 1", "Untitled 3"], "Untitled")).toBe("Untitled 2");
  });
  it("splits paths for both separators", () => {
    expect(basename("C:\\a\\b.txt")).toBe("b.txt");
    expect(basename("/a/b/c.rs")).toBe("c.rs");
    expect(dirname("/a/b/c.rs")).toBe("/a/b");
    expect(dirname("C:\\a\\b.txt")).toBe("C:\\a");
  });
  it("keeps a bounded MRU list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});

describe("fuzzy", () => {
  it("matches subsequences and ranks contiguous/word-start hits first", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
    const a = fuzzyScore("sv", "Save File")!;
    const b = fuzzyScore("sv", "Reserve Value")!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.positions).toEqual([0, 2]);
  });
  it("filters and keeps order for an empty query", () => {
    const items = ["Open", "Save", "Save As"];
    expect(fuzzyFilter(items, "", (s) => s).map((r) => r.item)).toEqual(items);
    expect(fuzzyFilter(items, "sa", (s) => s).map((r) => r.item)).toEqual(["Save", "Save As"]);
  });
});

describe("formatShortcut", () => {
  it("formats per platform", () => {
    expect(formatShortcut("CmdOrCtrl+Shift+P", true)).toBe("⌘⇧P");
    expect(formatShortcut("CmdOrCtrl+Shift+P", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcut("F3", false)).toBe("F3");
    expect(formatShortcut("Alt+Z", true)).toBe("⌥Z");
  });
});

describe("columnSelectRanges", () => {
  const lens = [10, 2, 8, 5];
  it("builds one range per line and clamps short lines", () => {
    expect(columnSelectRanges(lens.length, (l) => lens[l], { line: 0, col: 3 }, { line: 2, col: 6 })).toEqual([
      { line: 0, from: 3, to: 6 },
      { line: 1, from: 2, to: 2 },
      { line: 2, from: 3, to: 6 },
    ]);
  });
  it("works upwards and with reversed columns", () => {
    const r = columnSelectRanges(lens.length, (l) => lens[l], { line: 2, col: 6 }, { line: 0, col: 3 });
    expect(r.map((x) => x.line)).toEqual([0, 1, 2]);
    expect(r[0]).toEqual({ line: 0, from: 6, to: 3 });
  });
  it("stays within the document", () => {
    expect(columnSelectRanges(lens.length, (l) => lens[l], { line: 3, col: 0 }, { line: 9, col: 1 }).map((x) => x.line)).toEqual([3]);
  });
});

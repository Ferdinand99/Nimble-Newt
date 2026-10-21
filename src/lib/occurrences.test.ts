import { describe, expect, it } from "vitest";
import { findOccurrences, isWordLike } from "./occurrences";

describe("findOccurrences", () => {
  it("finds all non-overlapping matches", () => {
    expect(findOccurrences("aaaa", "aa", { matchCase: true, wholeWord: false })).toEqual([0, 2]);
    expect(findOccurrences("abcabc", "bc", { matchCase: true, wholeWord: false })).toEqual([1, 4]);
  });
  it("honours case", () => {
    expect(findOccurrences("Foo foo FOO", "foo", { matchCase: true, wholeWord: false })).toEqual([4]);
    expect(findOccurrences("Foo foo FOO", "foo", { matchCase: false, wholeWord: false })).toEqual([0, 4, 8]);
  });
  it("matches whole words only when asked, including unicode letters", () => {
    expect(findOccurrences("cat concat cat_x cat", "cat", { matchCase: true, wholeWord: true })).toEqual([0, 17]);
    expect(findOccurrences("blå blåbær blå", "blå", { matchCase: true, wholeWord: true })).toEqual([0, 11]);
  });
  it("handles empty needles and limits", () => {
    expect(findOccurrences("abc", "", { matchCase: true, wholeWord: false })).toEqual([]);
    expect(findOccurrences("a".repeat(100), "a", { matchCase: true, wholeWord: false }, 10)).toHaveLength(10);
  });
  it("detects word-like text", () => {
    expect(isWordLike("foo_1")).toBe(true);
    expect(isWordLike("foo bar")).toBe(false);
    expect(isWordLike("")).toBe(false);
  });
});

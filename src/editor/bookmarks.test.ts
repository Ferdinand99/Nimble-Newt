import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { bookmarkedLines, bookmarkedText, bookmarkField, setBookmarkEffect } from "./bookmarks";

function mk(doc: string, lines: number[] = []) {
  let s = EditorState.create({ doc, extensions: [bookmarkField] });
  if (lines.length) s = s.update({ effects: setBookmarkEffect(lines) }).state;
  return s;
}

describe("bookmark state", () => {
  it("stores line numbers, ignores duplicates and out-of-range lines", () => {
    const s = mk("a\nb\nc\nd", [3, 1, 3, 99, 0]);
    expect(bookmarkedLines(s)).toEqual([1, 3]);
    expect(bookmarkedText(s)).toBe("a\nc");
  });
  it("moves with edits above the bookmark", () => {
    let s = mk("a\nb\nc", [3]);
    s = s.update({ changes: { from: 0, insert: "x\ny\n" } }).state;
    expect(bookmarkedLines(s)).toEqual([5]);
  });
  it("follows the line when text is inserted before it on the same line", () => {
    let s = mk("a\nbb\nc", [2]);
    s = s.update({ changes: { from: 2, insert: "zz" } }).state;
    expect(bookmarkedLines(s)).toEqual([2]);
  });
  it("drops to one marker when two bookmarked lines are joined", () => {
    let s = mk("a\nb\nc", [1, 2]);
    s = s.update({ changes: { from: 1, to: 2 } }).state; // delete the newline between a and b
    expect(bookmarkedLines(s)).toEqual([1]);
  });
  it("keeps a bookmark when its line is replaced entirely", () => {
    let s = mk("a\nb\nc", [2]);
    s = s.update({ changes: { from: 2, to: 3, insert: "new" } }).state;
    expect(bookmarkedLines(s)).toEqual([2]);
    expect(bookmarkedText(s)).toBe("new");
  });
});

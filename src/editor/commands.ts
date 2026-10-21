import { EditorSelection, type SelectionRange } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { columnSelectRanges, type LineCol } from "../lib/logic";

interface Stash {
  sel: EditorSelection;
  anchor: LineCol;
  head: LineCol;
}
let stash: Stash | null = null;

const posToLC = (doc: import("@codemirror/state").Text, pos: number): LineCol => {
  const l = doc.lineAt(pos);
  return { line: l.number - 1, col: pos - l.from };
};

/** Alt+Shift+Arrows: grow a rectangular (column) selection. Remembers the virtual column across short lines. */
export const columnSelect =
  (dx: number, dy: number): Command =>
  (view) => {
    const { state } = view;
    const doc = state.doc;
    let a: LineCol;
    let h: LineCol;
    if (stash && stash.sel.eq(state.selection)) {
      ({ anchor: a, head: h } = stash);
    } else {
      const m = state.selection.main;
      a = posToLC(doc, m.anchor);
      h = posToLC(doc, m.head);
    }
    h = { line: Math.max(0, Math.min(doc.lines - 1, h.line + dy)), col: Math.max(0, h.col + dx) };
    const rs = columnSelectRanges(doc.lines, (l) => doc.line(l + 1).length, a, h);
    const ranges = rs.map((r) => {
      const from = doc.line(r.line + 1).from;
      return EditorSelection.range(from + r.from, from + r.to);
    });
    const mainIndex = Math.max(0, rs.findIndex((r) => r.line === h.line));
    const sel = EditorSelection.create(ranges, mainIndex);
    view.dispatch({ selection: sel, scrollIntoView: true, userEvent: "select" });
    stash = { sel: view.state.selection, anchor: a, head: h };
    return true;
  };

const addCursor =
  (dir: -1 | 1): Command =>
  (view) => {
    const { state } = view;
    const extra: SelectionRange[] = [];
    for (const r of state.selection.ranges) {
      const line = state.doc.lineAt(r.head);
      const target = line.number + dir;
      if (target < 1 || target > state.doc.lines) continue;
      const tl = state.doc.line(target);
      extra.push(EditorSelection.cursor(tl.from + Math.min(r.head - line.from, tl.length)));
    }
    if (!extra.length) return false;
    view.dispatch({ selection: EditorSelection.create([...state.selection.ranges, ...extra], state.selection.mainIndex), scrollIntoView: true });
    return true;
  };
export const addCursorAbove = addCursor(-1);
export const addCursorBelow = addCursor(1);

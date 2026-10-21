import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

class BookmarkMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-bookmark";
    el.setAttribute("aria-label", "Bookmark");
    return el;
  }
}
const marker = new BookmarkMarker();

const toggleEffect = StateEffect.define<number>(); // line start position
const setEffect = StateEffect.define<number[]>(); // 1-based line numbers
const clearEffect = StateEffect.define<null>();

function buildFromLines(state: EditorState, lines: number[]): RangeSet<BookmarkMarker> {
  const b = new RangeSetBuilder<BookmarkMarker>();
  const sorted = [...new Set(lines)].filter((n) => n >= 1 && n <= state.doc.lines).sort((a, c) => a - c);
  for (const n of sorted) b.add(state.doc.line(n).from, state.doc.line(n).from, marker);
  return b.finish();
}

export const bookmarkField = StateField.define<RangeSet<BookmarkMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearEffect)) value = RangeSet.empty;
      else if (e.is(setEffect)) value = buildFromLines(tr.state, e.value);
      else if (e.is(toggleEffect)) {
        const pos = tr.state.doc.lineAt(e.value).from;
        let has = false;
        value.between(pos, pos, () => {
          has = true;
        });
        value = has ? value.update({ filter: (from) => from !== pos }) : value.update({ add: [marker.range(pos)] });
      }
    }
    // Lines that were joined can leave two markers on one line; keep one per line.
    return dedupe(value, tr.state);
  },
});

function dedupe(value: RangeSet<BookmarkMarker>, state: EditorState): RangeSet<BookmarkMarker> {
  const seen = new Set<number>();
  let dup = false;
  const lines: number[] = [];
  const cur = value.iter();
  while (cur.value) {
    const n = state.doc.lineAt(cur.from).number;
    if (seen.has(n)) dup = true;
    seen.add(n);
    lines.push(n);
    cur.next();
  }
  return dup ? buildFromLines(state, lines) : value;
}

/** 1-based numbers of the bookmarked lines, ascending. */
export function bookmarkedLines(state: EditorState): number[] {
  const out: number[] = [];
  const cur = state.field(bookmarkField).iter();
  while (cur.value) {
    out.push(state.doc.lineAt(cur.from).number);
    cur.next();
  }
  return out;
}

export function toggleBookmarkAt(view: EditorView, pos = view.state.selection.main.head): void {
  view.dispatch({ effects: toggleEffect.of(pos) });
}
export function setBookmarkLines(view: EditorView, lines: number[]): void {
  view.dispatch({ effects: setEffect.of(lines) });
}
export function setBookmarkEffect(lines: number[]) {
  return setEffect.of(lines);
}
export function clearBookmarks(view: EditorView): void {
  view.dispatch({ effects: clearEffect.of(null) });
}

/** Moves the cursor to the next/previous bookmark, wrapping around. Returns false when there are none. */
export function jumpBookmark(view: EditorView, dir: 1 | -1): boolean {
  const lines = bookmarkedLines(view.state);
  if (!lines.length) return false;
  const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
  const target = dir === 1 ? (lines.find((n) => n > cur) ?? lines[0]) : ([...lines].reverse().find((n) => n < cur) ?? lines[lines.length - 1]);
  const pos = view.state.doc.line(target).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }), userEvent: "select" });
  return true;
}

/** Bookmarks every line in `lineNumbers` (adds to the existing set). */
export function addBookmarkLines(view: EditorView, lineNumbers: number[]): void {
  setBookmarkLines(view, [...bookmarkedLines(view.state), ...lineNumbers]);
}

export function invertBookmarks(view: EditorView): void {
  const marked = new Set(bookmarkedLines(view.state));
  const all: number[] = [];
  for (let n = 1; n <= view.state.doc.lines; n++) if (!marked.has(n)) all.push(n);
  setBookmarkLines(view, all);
}

/** The bookmarked lines' text joined with newlines, or "" when there are none. */
export function bookmarkedText(state: EditorState): string {
  return bookmarkedLines(state).map((n) => state.doc.line(n).text).join("\n");
}

/** Removes (`marked`) or keeps only (`!marked`) the bookmarked lines; clears the bookmarks. Returns the number of lines removed. */
export function removeLines(view: EditorView, removeMarked: boolean): number {
  const st = view.state;
  const marked = new Set(bookmarkedLines(st));
  const changes: { from: number; to: number }[] = [];
  let count = 0;
  for (let n = 1; n <= st.doc.lines; n++) {
    if (marked.has(n) !== removeMarked) continue;
    const l = st.doc.line(n);
    changes.push({ from: l.from, to: Math.min(st.doc.length, l.to + 1) });
    count++;
  }
  if (!count) return 0;
  // A last line has no trailing newline to take; swallow the one before it instead.
  const last = changes[changes.length - 1];
  if (last.to === st.doc.length && last.from > 0 && st.doc.sliceString(last.to - 1, last.to) !== "\n") last.from--;
  view.dispatch({ changes, effects: clearEffect.of(null), userEvent: "delete" });
  return count;
}

export const bookmarkExtension: Extension = [
  bookmarkField,
  gutter({
    class: "cm-bookmark-gutter",
    markers: (view) => view.state.field(bookmarkField),
    initialSpacer: () => marker,
    domEventHandlers: {
      mousedown(view, line) {
        toggleBookmarkAt(view, line.from);
        return true;
      },
    },
  }),
];

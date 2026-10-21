import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { findOccurrences, isWordLike } from "../lib/occurrences";

export const HIGHLIGHT_COLORS = 5;

export interface Needle {
  text: string;
  color: number; // 1..5
  matchCase: boolean;
  wholeWord: boolean;
}

const setNeedles = StateEffect.define<Needle[]>();

export const needleField = StateField.define<Needle[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNeedles)) return e.value;
    return value;
  },
});

const marks = Array.from({ length: HIGHLIGHT_COLORS }, (_, i) => Decoration.mark({ class: `cm-hl cm-hl-${i + 1}` }));

function build(view: EditorView): DecorationSet {
  const needles = view.state.field(needleField);
  if (!needles.length) return Decoration.none;
  const ranges: ReturnType<(typeof marks)[0]["range"]>[] = [];
  for (const { from, to } of view.visibleRanges) {
    // Extend by the longest needle so matches straddling the viewport edge are found.
    const pad = Math.max(...needles.map((n) => n.text.length));
    const a = Math.max(0, from - pad);
    const b = Math.min(view.state.doc.length, to + pad);
    const text = view.state.sliceDoc(a, b);
    for (const n of needles) {
      for (const i of findOccurrences(text, n.text, n, 2000)) ranges.push(marks[n.color - 1].range(a + i, a + i + n.text.length));
    }
  }
  return Decoration.set(ranges, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setNeedles)))) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const highlightExtension: Extension = [needleField, plugin];

/** Highlights every occurrence of `text` in colour 1..5; the same text+colour again removes it. */
export function toggleHighlight(view: EditorView, text: string, color: number): boolean {
  if (!text || text.includes("\n")) return false;
  const cur = view.state.field(needleField);
  const same = cur.find((n) => n.text === text && n.color === color);
  const next = same ? cur.filter((n) => n !== same) : [...cur.filter((n) => n.text !== text), { text, color, matchCase: true, wholeWord: isWordLike(text) }];
  view.dispatch({ effects: setNeedles.of(next) });
  return true;
}

export function clearHighlights(view: EditorView, color?: number): void {
  const cur = view.state.field(needleField);
  view.dispatch({ effects: setNeedles.of(color ? cur.filter((n) => n.color !== color) : []) });
}

/** The selected text, or the word at the cursor when nothing is selected. */
export function textToHighlight(view: EditorView): string {
  const m = view.state.selection.main;
  if (!m.empty) return view.state.sliceDoc(m.from, m.to);
  const w = view.state.wordAt(m.head);
  return w ? view.state.sliceDoc(w.from, w.to) : "";
}

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { Compartment, type Extension, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { collectWords, suggest, type WordInfo } from "../lib/completion";
import "../styles/completion.css";

/** Documents above this size are only scanned around the cursor. */
const FULL_SCAN_LIMIT = 2_000_000;
const WINDOW = 100_000;
/** Above this size, rescanning after edits is throttled. */
const THROTTLE_SIZE = 200_000;
const THROTTLE_MS = 1500;
const MIN_PREFIX = 2;
const WORD_BEFORE = /[\p{L}\p{N}_$]+/u;
const WORD_AFTER = /^[\p{L}\p{N}_$]*/u;

/** Caches the word list per document value (CodeMirror docs are immutable, so identity means "unchanged"). */
export class WordIndex {
  private doc: Text | null = null;
  private words: WordInfo[] = [];
  private at = 0;
  private pos = -1;
  private time = 0;

  get(doc: Text, pos: number, now = Date.now()): WordInfo[] {
    const windowed = doc.length > FULL_SCAN_LIMIT;
    if (this.doc === doc && (!windowed || Math.abs(pos - this.pos) < WINDOW / 2)) return this.words;
    const stale = this.doc !== null && now - this.time < THROTTLE_MS;
    if (stale && doc.length > THROTTLE_SIZE && (!windowed || Math.abs(pos - this.pos) < WINDOW / 2)) return this.words;
    const from = windowed ? Math.max(0, pos - WINDOW) : 0;
    const to = windowed ? Math.min(doc.length, pos + WINDOW) : doc.length;
    this.words = collectWords(doc.sliceString(from, to));
    this.doc = doc;
    this.at = from;
    this.pos = pos;
    this.time = now;
    return this.words;
  }

  /** Start offset of the last scan (for tests and debugging). */
  get scannedFrom(): number {
    return this.at;
  }
}

function makeSource(): (ctx: CompletionContext) => CompletionResult | null {
  const index = new WordIndex();
  return (ctx) => {
    const m = ctx.matchBefore(WORD_BEFORE);
    if (!m || (m.to - m.from < MIN_PREFIX && !ctx.explicit)) return null;
    const after = WORD_AFTER.exec(ctx.state.doc.sliceString(ctx.pos, Math.min(ctx.state.doc.length, ctx.pos + 100)))?.[0] ?? "";
    const typed = m.text;
    const options = suggest(index.get(ctx.state.doc, ctx.pos), typed, { limit: 30, exclude: typed + after });
    if (options.length === 0) return null;
    return { from: m.from, options: options.map((label) => ({ label, type: "text" })), validFor: /^[\p{L}\p{N}_$]*$/u };
  };
}

/** Completion from words in the current document. Enter accepts; Tab is left to indentWithTab. */
export function wordCompletion(): Extension {
  return autocompletion({
    override: [makeSource()],
    activateOnTyping: true,
    icons: false,
    defaultKeymap: true,
    maxRenderedOptions: 30,
  });
}

/**
 * Put `wordCompletionCompartment.of(wordCompletion())` (or `.of([])` when the setting is off) into the editor
 * extensions, then call `reconfigureWordCompletion(view, on)` when the setting changes.
 */
export const wordCompletionCompartment = new Compartment();

export function wordCompletionSlot(on: boolean): Extension {
  return wordCompletionCompartment.of(on ? wordCompletion() : []);
}

export function reconfigureWordCompletion(view: EditorView, on: boolean): void {
  view.dispatch({ effects: wordCompletionCompartment.reconfigure(on ? wordCompletion() : []) });
}

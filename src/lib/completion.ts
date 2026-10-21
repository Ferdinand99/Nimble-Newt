/**
 * Word-based completion ("complete from this document"). Pure and DOM-free; the CodeMirror glue is
 * src/editor/wordCompletion.ts.
 */

export interface WordInfo {
  word: string;
  count: number;
}

export interface CollectOptions {
  /** Shortest word kept (default 3). */
  minLength?: number;
  /** Most words returned, by frequency then alphabet (default 5000). */
  maxWords?: number;
}

/** Longest word that is indexed; longer runs (base64 blobs, minified code) are skipped. */
export const MAX_WORD_LENGTH = 64;
/** Hard cap on distinct words tracked while scanning, so a huge random file cannot exhaust memory. */
export const MAX_DISTINCT = 200_000;

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;
const ascii = new Uint8Array(128);
// 1 = word char, 2 = digit
for (let c = 48; c <= 57; c++) ascii[c] = 2;
for (let c = 65; c <= 90; c++) ascii[c] = 1;
for (let c = 97; c <= 122; c++) ascii[c] = 1;
ascii[95] = 1; // _
ascii[36] = 1; // $
const nonAscii = new Map<number, boolean>();

function isWordCodePoint(cp: number): boolean {
  if (cp < 128) return ascii[cp] !== 0;
  let r = nonAscii.get(cp);
  if (r === undefined) {
    r = WORD_CHAR_RE.test(String.fromCodePoint(cp));
    if (nonAscii.size < 20000) nonAscii.set(cp, r);
  }
  return r;
}

/** True when `ch` (one code point) may appear inside a completion word. */
export function isWordChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && isWordCodePoint(cp);
}

/** Letters, digits, underscore and dollar form words; words made only of digits are skipped. Case-sensitive keys. */
export function collectWords(text: string, options: CollectOptions = {}): WordInfo[] {
  const minLength = Math.max(1, options.minLength ?? 3);
  const maxWords = Math.max(1, options.maxWords ?? 5000);
  const counts = new Map<string, number>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    // skip non-word characters
    let cp = 0;
    let c = text.charCodeAt(i);
    let step = 1;
    if (c < 128) {
      if (ascii[c] === 0) {
        i++;
        continue;
      }
    } else {
      cp = text.codePointAt(i) ?? c;
      step = cp > 0xffff ? 2 : 1;
      if (!isWordCodePoint(cp)) {
        i += step;
        continue;
      }
    }
    // consume a word
    const start = i;
    let onlyDigits = true;
    let units = 0;
    for (;;) {
      if (c < 128) {
        if (ascii[c] === 1) onlyDigits = false;
        step = 1;
      } else {
        onlyDigits = false;
      }
      i += step;
      units++;
      if (i >= n) break;
      c = text.charCodeAt(i);
      if (c < 128) {
        if (ascii[c] === 0) break;
      } else {
        cp = text.codePointAt(i) ?? c;
        step = cp > 0xffff ? 2 : 1;
        if (!isWordCodePoint(cp)) break;
      }
    }
    if (onlyDigits || units < minLength || i - start > MAX_WORD_LENGTH) continue;
    const w = text.slice(start, i);
    const prev = counts.get(w);
    if (prev !== undefined) counts.set(w, prev + 1);
    else if (counts.size < MAX_DISTINCT) counts.set(w, 1);
  }
  const all: WordInfo[] = [];
  for (const [word, count] of counts) all.push({ word, count });
  all.sort(byFrequency);
  if (all.length > maxWords) all.length = maxWords;
  return all;
}

function byFrequency(a: WordInfo, b: WordInfo): number {
  return b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0);
}

export interface SuggestOptions {
  /** Most suggestions returned (default 30). */
  limit?: number;
  /** A word never suggested (the one being typed). */
  exclude?: string;
}

/**
 * Words that start with `prefix` (case-insensitively), best first: same-case matches, then frequency, then
 * alphabetical. The prefix itself is never suggested. An empty prefix yields nothing.
 */
export function suggest(words: readonly WordInfo[], prefix: string, options: SuggestOptions = {}): string[] {
  const limit = options.limit ?? 30;
  if (!prefix || limit <= 0) return [];
  const lower = prefix.toLowerCase();
  const hits: { w: WordInfo; exact: boolean }[] = [];
  for (const w of words) {
    const word = w.word;
    if (word.length <= prefix.length || word === options.exclude) continue;
    if (word.startsWith(prefix)) hits.push({ w, exact: true });
    else if (word.toLowerCase().startsWith(lower)) hits.push({ w, exact: false });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || byFrequency(a.w, b.w));
  return hits.slice(0, limit).map((h) => h.w.word);
}

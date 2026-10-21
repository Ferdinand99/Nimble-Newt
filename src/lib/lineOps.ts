/**
 * Pure line operations for the editor's "Edit > Line" commands. Everything works on arrays of lines (no newline
 * characters) and returns new arrays; nothing here touches the DOM or CodeMirror.
 */
import { formatInt } from "./numberSequence";

export interface Eol {
  /** Text split into lines, without line terminators. */
  lines: string[];
  /** Dominant terminator in the input ("\n" when there is none). */
  eol: "\n" | "\r\n";
}

/** Splits on \n, \r\n or \r. */
export function toLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function splitEol(text: string): Eol {
  return { lines: toLines(text), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

// ---------------------------------------------------------------- selection -> whole lines

export interface LineRange {
  /** 0-based index of the first line touched by the selection. */
  first: number;
  /** 0-based index of the last line touched (inclusive). */
  last: number;
}

/**
 * Maps a selection (character offsets) to the whole lines it covers. A non-empty selection that ends exactly at the
 * start of a line does not include that line (like most editors). An empty selection covers the caret's line.
 */
export function selectionToLines(text: string, from: number, to: number): LineRange & { start: number; end: number } {
  const a = Math.max(0, Math.min(from, to, text.length));
  let b = Math.max(0, Math.min(Math.max(from, to), text.length));
  if (b > a && (text[b - 1] === "\n" || text[b - 1] === "\r")) {
    // selection ends right after a line break: stop before the next line
    b -= text[b - 1] === "\n" && text[b - 2] === "\r" ? 2 : 1;
  }
  let start = a;
  while (start > 0 && text[start - 1] !== "\n" && text[start - 1] !== "\r") start--;
  let end = b;
  while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
  let first = 0;
  for (let i = 0; i < start; i++) {
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) first++;
  }
  const covered = toLines(text.slice(start, end)).length;
  return { first, last: first + covered - 1, start, end };
}

// ---------------------------------------------------------------- sorting

export interface SortOptions {
  order: "asc" | "desc";
  caseSensitive: boolean;
  /** Natural order: leading numbers (with sign and decimals) and embedded digit runs compare by value. */
  numeric: boolean;
  ignoreLeadingWhitespace?: boolean;
  /** BCP 47 tag (for example "nb"): compare with Intl.Collator, so æ, ø, å sort after z in Norwegian. Default: code points. */
  locale?: string;
}

type Chunk = { k: "n"; v: number; s: string } | { k: "d"; s: string } | { k: "t"; s: string };

const LEAD_NUM = /^[+-]?\d+(?:\.\d+)?/;

function chunks(s: string): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  const lead = LEAD_NUM.exec(s);
  if (lead) {
    out.push({ k: "n", v: Number(lead[0]), s: lead[0] });
    i = lead[0].length;
  }
  const re = /(\d+)|(\D+)/g;
  re.lastIndex = i;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ? { k: "d", s: m[1] } : { k: "t", s: m[2] });
  return out;
}

function cmpDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

function cmpPlain(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function makeComparator(o: SortOptions): (a: string, b: string) => number {
  const collator = o.locale ? new Intl.Collator(o.locale, { sensitivity: o.caseSensitive ? "variant" : "accent", numeric: false }) : null;
  const text = (a: string, b: string) => (collator ? collator.compare(a, b) : o.caseSensitive ? cmpPlain(a, b) : cmpPlain(a.toLowerCase(), b.toLowerCase()));
  const norm = (s: string) => (o.ignoreLeadingWhitespace ? s.replace(/^\s+/, "") : s);
  if (!o.numeric) return (a, b) => text(norm(a), norm(b));
  return (a, b) => {
    const x = norm(a);
    const y = norm(b);
    const ca = chunks(x);
    const cb = chunks(y);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
      const p = ca[i];
      const q = cb[i];
      let r = 0;
      if (p.k === "t" && q.k === "t") r = text(p.s, q.s);
      else if (p.k !== "t" && q.k !== "t") r = p.k === "n" && q.k === "n" ? p.v - q.v : cmpDigits(p.s.replace(/^[+-]/, ""), q.s.replace(/^[+-]/, ""));
      else r = p.k === "t" ? 1 : -1; // numbers before text
      if (r !== 0) return r;
    }
    if (ca.length !== cb.length) return ca.length - cb.length;
    return text(x, y); // equal by value ("01" vs "1"): fall back to plain order
  };
}

/** Stable sort. */
export function sortLines(lines: readonly string[], options: Partial<SortOptions> = {}): string[] {
  const o: SortOptions = { order: "asc", caseSensitive: false, numeric: false, ...options };
  const cmp = makeComparator(o);
  const sign = o.order === "desc" ? -1 : 1;
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => sign * cmp(a.line, b.line) || a.i - b.i)
    .map((e) => e.line);
}

export function reverseLines(lines: readonly string[]): string[] {
  return [...lines].reverse();
}

/** Fisher-Yates; `rng` returns a number in [0, 1) (default Math.random). */
export function shuffleLines(lines: readonly string[], rng: () => number = Math.random): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- duplicates and blanks

export interface DedupeOptions {
  /** "all": keep the first occurrence of every line; "consecutive": only collapse runs of identical lines. */
  mode: "all" | "consecutive";
  caseSensitive: boolean;
}

export function removeDuplicateLines(lines: readonly string[], options: Partial<DedupeOptions> = {}): string[] {
  const { mode, caseSensitive } = { mode: "all", caseSensitive: true, ...options };
  const key = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const out: string[] = [];
  if (mode === "consecutive") {
    let prev: string | null = null;
    for (const l of lines) {
      const k = key(l);
      if (k !== prev) out.push(l);
      prev = k;
    }
    return out;
  }
  const seen = new Set<string>();
  for (const l of lines) {
    const k = key(l);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

/** Keeps one copy (the first) of each line that occurs more than once. */
export function keepOnlyDuplicates(lines: readonly string[], options: { caseSensitive?: boolean } = {}): string[] {
  const key = (s: string) => (options.caseSensitive === false ? s.toLowerCase() : s);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);
  const done = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = key(l);
    if ((counts.get(k) ?? 0) > 1 && !done.has(k)) {
      done.add(k);
      out.push(l);
    }
  }
  return out;
}

/** Drops empty lines; with `blankToo`, also whitespace-only lines. */
export function removeEmptyLines(lines: readonly string[], options: { blankToo?: boolean } = {}): string[] {
  return lines.filter((l) => (options.blankToo ? l.trim() !== "" : l !== ""));
}

export function trimLines(lines: readonly string[], mode: "leading" | "trailing" | "both"): string[] {
  return lines.map((l) => (mode === "leading" ? l.trimStart() : mode === "trailing" ? l.trimEnd() : l.trim()));
}

/** Replaces each run of blank (empty or whitespace-only) lines with the first line of the run. */
export function collapseBlankLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let blank = false;
  for (const l of lines) {
    const b = l.trim() === "";
    if (b && blank) continue;
    out.push(l);
    blank = b;
  }
  return out;
}

// ---------------------------------------------------------------- case

export type CaseMode = "upper" | "lower" | "title" | "sentence" | "invert" | "camel" | "snake" | "kebab" | "pascal";

const WORD_PARTS = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{N}+|[\p{Lo}\p{Lm}\p{Lt}]+/gu;

/** Splits an identifier or phrase into words: "XMLHttpRequest" -> XML, Http, Request; "foo_bar-baz" -> foo, bar, baz. */
export function identifierWords(s: string): string[] {
  return s.match(WORD_PARTS) ?? [];
}

const upperFirst = (w: string) => {
  const [first = "", ...rest] = [...w];
  return first.toUpperCase() + rest.join("").toLowerCase();
};

function invertChar(ch: string): string {
  const u = ch.toUpperCase();
  const l = ch.toLowerCase();
  if (ch === u && ch !== l) return l;
  if (ch === l && ch !== u) return u.length === ch.length ? u : ch; // keep ß as is rather than SS
  return ch;
}

function convertIdentifierLine(line: string, mode: "camel" | "snake" | "kebab" | "pascal"): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(line) as RegExpExecArray;
  const words = identifierWords(m[2]);
  if (words.length === 0) return line;
  let body: string;
  if (mode === "snake") body = words.map((w) => w.toLowerCase()).join("_");
  else if (mode === "kebab") body = words.map((w) => w.toLowerCase()).join("-");
  else if (mode === "pascal") body = words.map(upperFirst).join("");
  else body = words.map((w, i) => (i === 0 ? w.toLowerCase() : upperFirst(w))).join("");
  return m[1] + body + m[3];
}

export function changeCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.toLowerCase().replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, (w) => {
        const [first, ...rest] = [...w];
        return first.toUpperCase() + rest.join("");
      });
    case "sentence": {
      const lower = text.toLowerCase();
      let cap = true;
      let out = "";
      for (const ch of lower) {
        if (cap && /\p{L}/u.test(ch)) {
          out += ch.toUpperCase();
          cap = false;
        } else {
          out += ch;
          if (/[.!?…]/.test(ch)) cap = true;
          else if (/\p{L}|\p{N}/u.test(ch)) cap = false;
        }
      }
      return out;
    }
    case "invert":
      return [...text].map(invertChar).join("");
    default:
      return toLines(text)
        .map((l) => convertIdentifierLine(l, mode))
        .join(text.includes("\r\n") ? "\r\n" : "\n");
  }
}

// ---------------------------------------------------------------- join / split

/**
 * Joins lines into one. Each part loses the whitespace at the edge that touches the separator, and blank lines are
 * skipped so no doubled separators appear. The first part keeps its leading indentation, the last its trailing space.
 */
export function joinLines(lines: readonly string[], separator = " "): string {
  const parts = lines.filter((l) => l.trim() !== "");
  return parts.map((l, i) => (i > 0 ? l.trimStart() : l)).map((l, i) => (i < parts.length - 1 ? l.trimEnd() : l)).join(separator);
}

/**
 * Hard-wraps text at `width` columns, breaking at spaces at or before the limit. Words longer than the width stay
 * whole. Existing line breaks are kept; the whitespace at each break is dropped.
 */
export function splitLines(text: string, options: { width: number }): string[] {
  const width = Math.max(1, Math.floor(options.width) || 1);
  const out: string[] = [];
  for (const line of toLines(text)) {
    let rest = line;
    while (rest.length > width) {
      let idx = -1;
      for (let i = Math.min(width, rest.length - 1); i > 0; i--) {
        if ((rest[i] === " " || rest[i] === "\t") && rest.slice(0, i).trim() !== "") {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        const m = /[ \t]/.exec(rest.slice(width + 1));
        if (!m) break;
        idx = width + 1 + m.index;
        if (rest.slice(0, idx).trim() === "") break;
      }
      out.push(rest.slice(0, idx).trimEnd());
      rest = rest.slice(idx).trimStart();
    }
    out.push(rest);
  }
  return out;
}

/** Splits every line at each occurrence of `delimiter` (string or RegExp). An empty delimiter leaves the text alone. */
export function splitLinesBy(text: string, delimiter: string | RegExp): string[] {
  if (delimiter === "") return toLines(text);
  return toLines(text).flatMap((l) => l.split(delimiter));
}

// ---------------------------------------------------------------- indent / prefix / number

/** Adds `unit` (default one tab) `count` times to every non-empty line. */
export function indentLines(lines: readonly string[], unit = "\t", count = 1): string[] {
  const pad = unit.repeat(Math.max(0, count));
  return lines.map((l) => (l === "" ? l : pad + l));
}

/** Removes one `unit` of indentation: the unit itself, a tab, or up to unit.length leading spaces. */
export function outdentLines(lines: readonly string[], unit = "\t"): string[] {
  return lines.map((l) => {
    if (unit && l.startsWith(unit)) return l.slice(unit.length);
    if (l.startsWith("\t")) return l.slice(1);
    const spaces = /^ */.exec(l)?.[0].length ?? 0;
    return l.slice(Math.min(spaces, unit.length || 1));
  });
}

export function prefixLines(lines: readonly string[], prefix: string, options: { skipEmpty?: boolean } = {}): string[] {
  return lines.map((l) => (options.skipEmpty && l === "" ? l : prefix + l));
}

export function suffixLines(lines: readonly string[], suffix: string, options: { skipEmpty?: boolean } = {}): string[] {
  return lines.map((l) => (options.skipEmpty && l === "" ? l : l + suffix));
}

export interface NumberOptions {
  start: number;
  step: number;
  /** Minimum width of the number. */
  pad: number;
  padChar: "0" | " ";
  /** Text between the number and the line. */
  separator: string;
}

export function numberLines(lines: readonly string[], options: Partial<NumberOptions> = {}): string[] {
  const o: NumberOptions = { start: 1, step: 1, pad: 0, padChar: " ", separator: ". ", ...options };
  return lines.map((l, i) => formatInt(o.start + o.step * i, 10, o.pad, o.padChar) + o.separator + l);
}

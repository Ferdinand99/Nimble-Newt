// Turns a user-defined language definition (validated by the Rust side) into a CodeMirror language.
// The tokenizer only compares literal text, never regular expressions built from user input.

import { foldService, StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { LanguageDef } from "./languages";

export interface UserStringRule {
  start: string;
  end: string;
  escape?: string;
}

export interface UserLanguageDefinition {
  id: string;
  name: string;
  extensions: string[];
  filenames: string[];
  caseSensitive: boolean;
  keywords: { keyword?: string[]; type?: string[]; builtin?: string[]; literal?: string[] };
  lineComment?: string;
  blockComment?: [string, string];
  strings: UserStringRule[];
  numbers: boolean;
  operators?: string;
  fold?: { start: string; end: string };
  wordChars?: string;
}

export const USER_PREFIX = "user-";

/** Fills in defaults for fields a definition may omit (the Rust side already normalises, this is defensive). */
export function normalizeDefinition(raw: Partial<UserLanguageDefinition> & { id: string; name: string }): UserLanguageDefinition {
  return {
    ...raw,
    extensions: raw.extensions ?? [],
    filenames: raw.filenames ?? [],
    caseSensitive: raw.caseSensitive ?? true,
    keywords: raw.keywords ?? {},
    strings: raw.strings ?? [],
    numbers: raw.numbers ?? true,
  };
}

export interface UserState {
  inBlock: boolean;
  str: UserStringRule | null;
}

const GROUPS = [
  ["keyword", "keyword"],
  ["type", "typeName"],
  ["builtin", "builtin"],
  ["literal", "atom"],
] as const;

/** Maps each word to its token name; the first group that lists a word wins. */
export function keywordTable(def: UserLanguageDefinition): Map<string, string> {
  const table = new Map<string, string>();
  for (const [group, token] of GROUPS) {
    for (const w of def.keywords[group] ?? []) {
      const key = def.caseSensitive ? w : w.toLowerCase();
      if (!table.has(key)) table.set(key, token);
    }
  }
  return table;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function userTokenizer(def: UserLanguageDefinition): StreamParser<UserState> {
  const words = keywordTable(def);
  const extra = def.wordChars ?? "";
  // Built from the character class of *our own* fixed pattern plus escaped literal characters.
  const wordRe = new RegExp(`[\\p{L}\\p{N}_${escapeRe(extra).replace(/-/g, "\\-")}]`, "u");
  const startRe = new RegExp(`[\\p{L}_${escapeRe(extra).replace(/-/g, "\\-")}]`, "u");
  const ops = new Set([...(def.operators ?? "")]);
  const [blockOpen, blockClose] = def.blockComment ?? ["", ""];

  const readBlock = (stream: StringStream, state: UserState) => {
    while (!stream.eol()) {
      if (stream.match(blockClose)) {
        state.inBlock = false;
        return;
      }
      stream.next();
    }
  };

  const readString = (stream: StringStream, state: UserState) => {
    const rule = state.str!;
    const esc = rule.escape;
    while (!stream.eol()) {
      if (esc && esc !== rule.end && stream.match(esc)) {
        stream.next();
        continue;
      }
      if (stream.match(rule.end)) {
        // An escape equal to the terminator (SQL style '') means the doubled form stays inside the string.
        if (esc && esc === rule.end && stream.match(rule.end)) continue;
        state.str = null;
        return;
      }
      stream.next();
    }
  };

  const ci = !def.caseSensitive;
  return {
    name: def.id,
    startState: () => ({ inBlock: false, str: null }),
    copyState: (s) => ({ ...s }),
    token(stream, state) {
      if (state.inBlock) {
        readBlock(stream, state);
        return "comment";
      }
      if (state.str) {
        readString(stream, state);
        return "string";
      }
      if (stream.eatSpace()) return null;
      if (def.lineComment && stream.match(def.lineComment)) {
        stream.skipToEnd();
        return "comment";
      }
      if (blockOpen && stream.match(blockOpen)) {
        state.inBlock = true;
        readBlock(stream, state);
        return "comment";
      }
      for (const rule of def.strings) {
        if (stream.match(rule.start)) {
          state.str = rule;
          readString(stream, state);
          return "string";
        }
      }
      const ch = stream.peek() ?? "";
      if (def.numbers && /[0-9]/.test(ch)) {
        if (stream.match(/^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/)) return "number";
      }
      if (startRe.test(ch)) {
        stream.next();
        while (!stream.eol() && wordRe.test(stream.peek()!)) stream.next();
        const word = stream.current();
        return words.get(ci ? word.toLowerCase() : word) ?? null;
      }
      stream.next();
      if (ops.has(ch)) return "operator";
      return null;
    },
    languageData: {
      ...(def.lineComment || def.blockComment ? { commentTokens: { ...(def.lineComment ? { line: def.lineComment } : {}), ...(def.blockComment ? { block: { open: def.blockComment[0], close: def.blockComment[1] } } : {}) } } : {}),
      ...(def.wordChars ? { wordChars: def.wordChars } : {}),
    },
  };
}

export interface FoldRange {
  /** Column in the start line right after the last unmatched opener. */
  fromCol: number;
  toLine: number;
  /** Column of the matching closer in `toLine`. */
  toCol: number;
}

const MAX_FOLD_LINES = 20000;

/** Finds the range to fold for the unmatched `start` delimiter on `lines[index]`, if any (literal matching, nesting aware). */
export function findFold(lines: readonly string[], index: number, start: string, end: string): FoldRange | null {
  if (!start || !end) return null;
  const openers: number[] = [];
  const scan = (line: string, onOpen: (col: number) => void, onClose: (col: number) => boolean) => {
    let i = 0;
    while (i < line.length) {
      if (line.startsWith(start, i)) {
        onOpen(i);
        i += start.length;
      } else if (line.startsWith(end, i)) {
        if (onClose(i)) return true;
        i += end.length;
      } else i++;
    }
    return false;
  };
  scan(lines[index], (c) => openers.push(c), () => (openers.pop(), false));
  if (!openers.length) return null;
  const fromCol = openers[openers.length - 1] + start.length;
  let depth = 1;
  for (let j = index + 1; j < lines.length && j - index <= MAX_FOLD_LINES; j++) {
    let found = -1;
    scan(
      lines[j],
      () => depth++,
      (col) => {
        if (--depth === 0) {
          found = col;
          return true;
        }
        return false;
      },
    );
    if (found >= 0) return { fromCol, toLine: j, toCol: found };
  }
  return null;
}

export function buildUserLanguage(def: UserLanguageDefinition): Extension {
  const lang = StreamLanguage.define(userTokenizer(def));
  if (!def.fold) return lang;
  const { start, end } = def.fold;
  return [
    lang,
    foldService.of((state, lineStart) => {
      const doc = state.doc;
      const first = doc.lineAt(lineStart);
      if (!first.text.includes(start)) return null;
      const upper = Math.min(doc.lines, first.number + MAX_FOLD_LINES);
      const lines: string[] = [];
      for (let n = first.number; n <= upper; n++) lines.push(doc.line(n).text);
      const r = findFold(lines, 0, start, end);
      if (!r) return null;
      return { from: first.from + r.fromCol, to: doc.line(first.number + r.toLine).from + r.toCol };
    }),
  ];
}

export function toLanguageDef(def: UserLanguageDefinition): LanguageDef {
  const comment: LanguageDef["comment"] = {};
  if (def.lineComment) comment.line = def.lineComment;
  if (def.blockComment) comment.block = def.blockComment;
  return {
    id: USER_PREFIX + def.id,
    name: def.name,
    extensions: def.extensions.map((e) => e.toLowerCase()),
    filenames: def.filenames,
    comment: comment.line || comment.block ? comment : undefined,
    load: async () => buildUserLanguage(def),
  };
}

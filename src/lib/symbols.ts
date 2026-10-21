/**
 * Outline / "function list": line-oriented symbol extraction for the languages the editor knows.
 * Pure and DOM-free. Every language has a small profile of regex rules; a light lexer first blanks out comments and
 * string contents (so `/* function x() *\/` and `"class Foo"` do not count) and brace/indent tracking decides
 * whether a line is at a declaration level (so calls and control flow inside function bodies are never reported).
 *
 * Limits: at most MAX_SYMBOLS symbols; lines longer than MAX_LINE_LENGTH are not matched (they are still lexed).
 */

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "struct"
  | "enum"
  | "interface"
  | "trait"
  | "module"
  | "type"
  | "heading"
  | "constant"
  | "section"
  | "selector"
  | "table"
  | "variable";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based. */
  line: number;
  /** Nesting depth (0 = top level) or heading level (markdown: 1-6). */
  level?: number;
}
export type { OutlineSymbol as Symbol };

export const MAX_SYMBOLS = 5000;
export const MAX_LINE_LENGTH = 500;
const MAX_NAME = 120;

// ------------------------------------------------------------------------------------------------ engine types

type Mode = "brace" | "indent" | "flat";

interface Container {
  name: string;
  kind: SymbolKind;
  typeLike: boolean;
  bodyDepth: number;
  indent: number;
  endBased: boolean;
}

interface Ctx {
  /** The line after lexing (comments and string contents removed). */
  line: string;
  /** Previous non-blank cleaned line, trimmed. */
  prev: string;
  indent: number;
  container: Container | undefined;
}

interface Rule {
  re: RegExp;
  kind: SymbolKind | ((m: RegExpExecArray) => SymbolKind);
  /** Capture group holding the name (default 1). */
  group?: number;
  name?: (m: RegExpExecArray) => string;
  /** "top": not inside a class-like body; "type": only inside one; default any. */
  scope?: "top" | "type";
  /** The symbol opens a body whose members are reported too. */
  container?: boolean | "end";
  /** Container without a symbol of its own (extern "C" {, anonymous namespace). */
  silent?: boolean;
  accept?: (m: RegExpExecArray, ctx: Ctx) => boolean;
  level?: (m: RegExpExecArray) => number;
}

interface LexSpec {
  line?: string[];
  block?: [string, string][];
  quotes?: string;
  /** Delimiters of strings that may span lines (backtick, triple quotes). */
  multi?: string[];
  /** Rust: `'x'` is a char literal, `'a` a lifetime. */
  charLit?: boolean;
  /** Whole-line block comments such as Ruby's =begin/=end. */
  lineBlock?: [RegExp, RegExp];
}

interface Profile {
  mode: Mode;
  rules: Rule[];
  lex?: LexSpec;
  /** Removes leading annotations/attributes before matching. */
  strip?: RegExp;
  /** Pops end-based containers. */
  endRe?: RegExp;
  custom?: (lines: string[], out: OutlineSymbol[]) => void;
}

const R = (re: RegExp, kind: Rule["kind"], extra: Partial<Rule> = {}): Rule => ({ re, kind, ...extra });
const TYPE_LIKE = new Set<SymbolKind>(["class", "struct", "enum", "interface", "trait"]);

// ------------------------------------------------------------------------------------------------ lexer

interface LexState {
  end: string;
  lineBlock: boolean;
}

function lexTable(lex: LexSpec): Uint8Array {
  const t = new Uint8Array(128);
  const mark = (s: string) => {
    const c = s.charCodeAt(0);
    if (c < 128) t[c] = 1;
  };
  lex.line?.forEach(mark);
  lex.block?.forEach(([o]) => mark(o));
  lex.multi?.forEach(mark);
  for (const q of lex.quotes ?? "") mark(q);
  return t;
}

const tables = new WeakMap<LexSpec, Uint8Array>();

function lexClean(line: string, lex: LexSpec, st: LexState): string {
  let table = tables.get(lex);
  if (!table) tables.set(lex, (table = lexTable(lex)));
  if (lex.lineBlock) {
    if (st.lineBlock) {
      if (lex.lineBlock[1].test(line)) st.lineBlock = false;
      return "";
    }
    if (lex.lineBlock[0].test(line)) {
      st.lineBlock = true;
      return "";
    }
  }
  const n = line.length;
  let i = 0;
  let from = 0;
  let out = "";
  if (st.end) {
    const e = line.indexOf(st.end);
    if (e < 0) return "";
    i = from = e + st.end.length;
    st.end = "";
    out = " ";
  }
  outer: while (i < n) {
    const code = line.charCodeAt(i);
    if (code >= 128 || table[code] === 0) {
      i++;
      continue;
    }
    if (lex.block) {
      for (const [o, c] of lex.block) {
        if (line.startsWith(o, i)) {
          out += line.slice(from, i) + " ";
          const e = line.indexOf(c, i + o.length);
          if (e < 0) {
            st.end = c;
            return out;
          }
          i = from = e + c.length;
          continue outer;
        }
      }
    }
    if (lex.line) {
      for (const lc of lex.line) if (line.startsWith(lc, i)) return out + line.slice(from, i);
    }
    if (lex.multi) {
      for (const m of lex.multi) {
        if (line.startsWith(m, i)) {
          out += line.slice(from, i) + '""';
          const e = line.indexOf(m, i + m.length);
          if (e < 0) {
            st.end = m;
            return out;
          }
          i = from = e + m.length;
          continue outer;
        }
      }
    }
    const ch = line[i];
    if (lex.quotes?.includes(ch)) {
      if (lex.charLit && ch === "'") {
        let skip = 0;
        if (line[i + 2] === "'" && line[i + 1] !== "\\") skip = 3;
        else if (line[i + 1] === "\\") {
          const e = line.indexOf("'", i + 3);
          if (e > 0 && e - i <= 10) skip = e - i + 1;
        }
        if (skip === 0) {
          i++; // lifetime
          continue;
        }
        out += line.slice(from, i) + "''";
        i = from = i + skip;
        continue;
      }
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      out += line.slice(from, i) + ch + ch;
      i = from = j + 1;
      continue;
    }
    i++;
  }
  return from === 0 ? line : out + line.slice(from);
}

// ------------------------------------------------------------------------------------------------ engine

/** A line that continues a declaration whose opening brace has not appeared yet. */
const PENDING_CONT = /^(?:[:,<]|extends\b|implements\b|where\b|throws\b|with\b|permits\b|inherits\b)/;

function tidy(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + "…" : s;
}

function indentOf(line: string): number {
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4;
    else break;
  }
  return w;
}

function run(lines: string[], p: Profile, out: OutlineSymbol[], lineOffset = 0): void {
  const lex = p.lex;
  const st: LexState = { end: "", lineBlock: false };
  const stack: Container[] = [];
  let depth = 0;
  let prev = "";
  let pending: { name: string; kind: SymbolKind; indent: number; age: number; open: boolean } | null = null;

  for (let li = 0; li < lines.length && out.length < MAX_SYMBOLS; li++) {
    const raw = lines[li];
    let line = lex ? lexClean(raw, lex, st) : raw;
    if (p.strip) line = line.replace(p.strip, (m) => " ".repeat(Math.min(m.length, indentOf(m))));
    if (line.trim() === "") continue;
    const long = raw.length > MAX_LINE_LENGTH;
    const indent = indentOf(line);
    const depthBefore = depth;

    if (p.mode === "indent" && !/^\s*[)\]]/.test(line)) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    }

    if (p.mode === "brace") {
      if (pending) {
        const t = line.trimStart();
        const cont = pending.open || t.startsWith("{") || PENDING_CONT.test(t);
        if (cont && line.includes("{")) {
          stack.push({ name: pending.name, kind: pending.kind, typeLike: TYPE_LIKE.has(pending.kind), bodyDepth: depthBefore + 1, indent: 0, endBased: false });
          pending = null;
        } else if (cont && !line.includes(";") && ++pending.age <= 6) pending.open = /[,:(<]\s*$/.test(line);
        else pending = null;
      }
      if (p.endRe && p.endRe.test(line) && stack.length && stack[stack.length - 1].endBased) stack.pop();
    }

    const top = stack[stack.length - 1];
    const atLevel = p.mode !== "brace" || depthBefore === (top ? top.bodyDepth : 0);
    if (atLevel && !long) {
      const ctx: Ctx = { line, prev, indent, container: top };
      for (const rule of p.rules) {
        const typeLike = !!top?.typeLike;
        if (rule.scope === "top" && typeLike) continue;
        if (rule.scope === "type" && !typeLike) continue;
        const m = rule.re.exec(line);
        if (!m) continue;
        if (rule.accept && !rule.accept(m, ctx)) continue;
        const name = tidy(rule.name ? rule.name(m) : (m[rule.group ?? 1] ?? ""));
        let kind = typeof rule.kind === "function" ? rule.kind(m) : rule.kind;
        if (kind === "function" && typeLike) kind = "method";
        const level = p.mode === "flat" ? (rule.level ? rule.level(m) : 0) : stack.length;
        const silent = rule.silent || (rule.container && name === "");
        if (!silent && name !== "") out.push({ name, kind, line: lineOffset + li + 1, level });
        if (rule.container || silent) {
          const entry: Container = { name, kind, typeLike: TYPE_LIKE.has(kind), bodyDepth: depthBefore + 1, indent, endBased: rule.container === "end" };
          if (p.mode === "indent") stack.push(entry);
          else if (rule.container === "end") {
            entry.bodyDepth = depthBefore;
            stack.push(entry);
          } else if (line.includes("{", m.index)) stack.push(entry);
          else if (!/;\s*$/.test(line)) pending = { name, kind, indent, age: 0, open: /[,:(<]\s*$/.test(line) };
        }
        break;
      }
    }

    if (p.mode === "brace") {
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c === 123) depth++;
        else if (c === 125 && depth > 0) depth--;
      }
      while (stack.length) {
        const t = stack[stack.length - 1];
        if (!t.endBased && t.bodyDepth > depth) stack.pop();
        else break;
      }
    }
    prev = line.trim();
  }
}

// ------------------------------------------------------------------------------------------------ shared pieces

const SLASH_LEX: LexSpec = { line: ["//"], block: [["/*", "*/"]], quotes: "\"'" };
const KEYWORDS = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "catch", "try", "finally", "return", "sizeof", "typeof", "alignof", "decltype",
  "new", "delete", "throw", "using", "lock", "fixed", "unsafe", "checked", "unchecked", "nameof", "default", "when", "with", "synchronized",
  "function", "super", "this", "await", "yield", "static_assert", "assert", "defined", "elif", "until", "goto", "import", "export", "void",
]);
const BAD_PREFIX = /\b(?:return|new|else|throw|delete|case|goto|typedef|using|await|yield|co_return|co_await|co_yield)\b/;

function cFunction(opts: { semi?: "never" | "interface"; scope?: Rule["scope"] } = {}): Rule {
  return R(
    /^\s*([^()=;{}"'`]*?)(~?[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*|operator\s*(?:\(\)|[^\s\w(]+))\s*(?:<[^()=;{}]*>\s*)?\(/,
    "function",
    {
      group: 2,
      scope: opts.scope,
      accept: (m, ctx) => {
        const prefix = m[1];
        const name = m[2];
        const last = name.split("::").pop() ?? name;
        if (KEYWORDS.has(name) || KEYWORDS.has(last) || ctx.line.trimStart().startsWith("#")) return false;
        if (prefix !== "" && !/[\s*&>\]]$/.test(prefix)) return false;
        if (BAD_PREFIX.test(prefix)) return false;
        const t = ctx.line.trimEnd();
        if (t.endsWith(";") && !t.includes("=>")) {
          const ok = opts.semi === "interface" && (ctx.container?.kind === "interface" || /\babstract\b/.test(prefix));
          if (!ok) return false;
        }
        if (prefix.trim() === "") {
          if (name.includes("::") || name.startsWith("~")) return true;
          return ctx.container?.name === last;
        }
        return true;
      },
    },
  );
}

/** Linux style C: return type on the previous line, name at column 0. */
const C_NAME_AT_COL0 = R(/^([A-Za-z_]\w*)\s*\([^;]*$/, "function", {
  accept: (m, ctx) => !KEYWORDS.has(m[1]) && /^[\w\s*&:<>,]+$/.test(ctx.prev) && !/^(?:else|return|typedef|do)\b/.test(ctx.prev) && !ctx.prev.startsWith("#"),
});

const rejectForwardDecl = (m: RegExpExecArray, ctx: Ctx): boolean => {
  const rest = ctx.line.slice(m.index + m[0].length);
  if (/^\s*[\w*&]+\s*\(/.test(rest)) return false; // `struct foo *bar(void)`: a function returning a struct
  return !(/;\s*$/.test(ctx.line) && !ctx.line.includes("{"));
};

const cKind = (word: string): SymbolKind => (/^enum/.test(word) ? "enum" : /^(?:struct|union)$/.test(word) ? "struct" : word === "namespace" ? "module" : "class");

function cRules(): Rule[] {
  return [
    R(/^\s*extern\s+""\s*\{/, "module", { container: true, silent: true, name: () => "" }),
    R(/^\s*(?:inline\s+)?namespace\b\s*([\w:]*)/, "module", { container: true }),
    R(/^\s*(?:typedef\s+)?(?:template\s*<.*>\s*)?(class|struct|union|enum(?:\s+class|\s+struct)?)\s+(?:\[\[[^\]]*\]\]\s*)?(?:[A-Z][A-Z0-9_]*(?:\([^)]*\))?\s+)*([A-Za-z_]\w*(?:::\w+)*)/, (m) => cKind(m[1]), {
      group: 2,
      container: true,
      accept: rejectForwardDecl,
    }),
    cFunction(),
    C_NAME_AT_COL0,
  ];
}

const javaMods = "(?:(?:public|private|protected|internal|static|final|abstract|sealed|non-sealed|partial|open|strictfp|unsafe|readonly|ref|new|file|data|inner)\\s+)*";

// ------------------------------------------------------------------------------------------------ profiles

const EXP = "(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?";
const JS_KW = KEYWORDS;
const jsProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, multi: ["`"] },
  strip: /^\s*(?:@[\w$.]+(?:\([^)]*\))?\s+)+/,
  rules: [
    R(new RegExp(`^\\s*${EXP}(?:abstract\\s+)?class\\s+([\\w$]+)`), "class", { container: true }),
    R(new RegExp(`^\\s*${EXP}interface\\s+([\\w$]+)`), "interface", { container: true }),
    R(new RegExp(`^\\s*${EXP}(?:const\\s+)?enum\\s+([\\w$]+)`), "enum"),
    R(new RegExp(`^\\s*${EXP}type\\s+([\\w$]+)\\s*(?:<[^=]*>)?\\s*=`), "type"),
    R(new RegExp(`^\\s*${EXP}(?:namespace|module)\\s+([\\w$.]+)`), "module", { container: true }),
    R(new RegExp(`^\\s*${EXP}(?:async\\s+)?function\\s*\\*?\\s*([\\w$]+)`), "function"),
    R(
      new RegExp(
        `^\\s*${EXP}(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=]+?)?=\\s*(?:async\\s+)?(?:function\\b|[\\w$]+\\s*=>|\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?::[^=]+?)?\\s*=>|<[^>]*>\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?::[^=]+?)?\\s*=>)`,
      ),
      "function",
    ),
    R(/^\s*([\w$]+(?:\.[\w$]+)+)\s*=\s*(?:async\s+)?function\b/, "function", { scope: "top" }),
    R(new RegExp(`^\\s*${EXP}const\\s+([A-Z][A-Z0-9_]*)\\s*(?::[^=]+?)?=`), "constant", { scope: "top" }),
    R(/^\s*(?:(?:public|private|protected|static|readonly|override|async|declare|accessor)\s+)*([A-Za-z_$#][\w$]*)\s*(?::[^=]+?)?=\s*(?:async\s+)?(?:function\b|[\w$]+\s*=>|\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+?)?\s*=>)/, "method", { scope: "type" }),
    R(/^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|accessor|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*[?!]?\s*(?:<[^()]*>)?\s*\(/, "method", {
      scope: "type",
      accept: (m) => !JS_KW.has(m[1]),
    }),
  ],
};

const pyProfile: Profile = {
  mode: "indent",
  lex: { line: ["#"], quotes: "\"'", multi: ['"""', "'''"] },
  rules: [
    R(/^\s*(?:async\s+)?def\s+(\w+)/, "function", { container: true }),
    R(/^\s*class\s+(\w+)/, "class", { container: true }),
    R(/^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/, "constant"),
  ],
};

const RS_VIS = "(?:pub(?:\\([^)]*\\))?\\s+)?";
const rustProfile: Profile = {
  mode: "brace",
  lex: { line: ["//"], block: [["/*", "*/"]], quotes: "\"'", charLit: true },
  rules: [
    R(new RegExp(`^\\s*${RS_VIS}(?:(?:const|async|unsafe|default|extern(?:\\s+"[^"]*")?)\\s+)*fn\\s+(?:r#)?(\\w+)`), "function"),
    R(new RegExp(`^\\s*${RS_VIS}struct\\s+(\\w+)`), "struct", { container: true }),
    R(new RegExp(`^\\s*${RS_VIS}union\\s+(\\w+)`), "struct", { container: true }),
    R(new RegExp(`^\\s*${RS_VIS}enum\\s+(\\w+)`), "enum", { container: true }),
    R(new RegExp(`^\\s*${RS_VIS}(?:unsafe\\s+)?(?:auto\\s+)?trait\\s+(\\w+)`), "trait", { container: true }),
    R(/^\s*(?:unsafe\s+)?(impl(?:\s|<)[^{]*)/, "class", {
      container: true,
      name: (m) => m[1].replace(/\s+where\b.*$/, ""),
    }),
    R(new RegExp(`^\\s*${RS_VIS}mod\\s+(\\w+)`), "module", { container: true }),
    R(new RegExp(`^\\s*${RS_VIS}(?:const|static)\\s+(?:mut\\s+)?(\\w+)\\s*:`), "constant"),
    R(new RegExp(`^\\s*${RS_VIS}type\\s+(\\w+)`), "type"),
    R(/^\s*(?:#\[macro_export\]\s*)?macro_rules!\s*(\w+)/, "function"),
  ],
};

const goProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, multi: ["`"] },
  rules: [
    R(/^func\s*\(\s*(?:\w+\s+)?\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)/, "method", { name: (m) => `${m[1]}.${m[2]}` }),
    R(/^func\s+(\w+)/, "function"),
    R(/^type\s+(\w+)(?:\[[^\]]*\])?\s+struct\b/, "struct"),
    R(/^type\s+(\w+)(?:\[[^\]]*\])?\s+interface\b/, "interface"),
    R(/^type\s+(\w+)/, "type"),
    R(/^const\s+(\w+)/, "constant"),
  ],
};

const cProfile: Profile = { mode: "brace", lex: SLASH_LEX, rules: cRules() };

const objcProfile: Profile = {
  mode: "brace",
  lex: SLASH_LEX,
  endRe: /^\s*@end\b/,
  rules: [
    R(/^\s*@(interface|implementation|protocol)\s+(\w+)(?:\s*\(\s*(\w*)\s*\))?/, (m) => (m[1] === "protocol" ? "interface" : "class"), {
      container: "end",
      name: (m) => m[2] + (m[3] ? ` (${m[3]})` : ""),
      accept: (_m, ctx) => !/;\s*$/.test(ctx.line),
    }),
    R(/^\s*[-+]\s*\([^)]*\)\s*(\w+)(.*)$/, "method", {
      scope: "type",
      name: (m) => {
        const parts = [...(m[1] + m[2]).matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
        return parts.length ? parts.join(":") + ":" : m[1];
      },
    }),
    ...cRules(),
  ],
};

const csProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, quotes: '"' },
  strip: /^\s*(?:\[[^\]]*\]\s*)+/,
  rules: [
    R(/^\s*namespace\s+([\w.]+)/, "module", { container: true }),
    R(new RegExp(`^\\s*${javaMods}(class|struct|interface|enum|record\\s+struct|record\\s+class|record)\\s+([A-Za-z_]\\w*)`), (m) => (/struct/.test(m[1]) ? "struct" : m[1] === "interface" ? "interface" : m[1] === "enum" ? "enum" : "class"), {
      group: 2,
      container: true,
    }),
    cFunction({ semi: "interface" }),
  ],
};

const javaTypes = R(new RegExp(`^\\s*${javaMods}(class|interface|enum|record|@interface)\\s+([A-Za-z_]\\w*)`), (m) => (m[1] === "interface" || m[1] === "@interface" ? "interface" : m[1] === "enum" ? "enum" : "class"), {
  group: 2,
  container: true,
});

const javaProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, quotes: "\"'", multi: [] },
  strip: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)+/,
  rules: [javaTypes, cFunction({ semi: "interface" })],
};

const dartProfile: Profile = {
  mode: "brace",
  lex: SLASH_LEX,
  strip: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)+/,
  rules: [
    R(/^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*(class|mixin|enum|extension)\s+([A-Za-z_]\w*)/, (m) => (m[1] === "enum" ? "enum" : m[1] === "mixin" ? "trait" : "class"), { group: 2, container: true }),
    R(/^\s*typedef\s+(\w+)/, "type"),
    cFunction({ semi: "interface" }),
  ],
};

const KT_MODS = "(?:(?:public|private|protected|internal|open|abstract|final|override|data|sealed|inline|suspend|operator|infix|tailrec|external|lateinit|const|actual|expect|inner|value|annotation|enum|fun)\\s+)*";
const kotlinProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, multi: ['"""'] },
  strip: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)+/,
  rules: [
    R(/^\s*(?:(?:public|private|protected|internal|open|abstract|final|sealed|data|inner|annotation|enum|value|expect|actual)\s+)*(?:fun\s+)?(class|interface|object)\s+(\w+)/, (m) => (m[1] === "interface" ? "interface" : "class"), { group: 2, container: true }),
    R(/^\s*companion\s+object\b/, "class", { container: true, silent: true }),
    R(new RegExp(`^\\s*${KT_MODS}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w<>?,.]+\\.)?(\\w+)\\s*\\(`), "function"),
    R(/^\s*(?:(?:public|private|internal)\s+)?(?:const\s+val|typealias)\s+(\w+)/, (m) => (/typealias/.test(m[0]) ? "type" : "constant")),
  ],
};

const SW_MODS = "(?:(?:public|private|fileprivate|internal|open|static|final|override|mutating|nonmutating|class|required|convenience|dynamic|nonisolated|async|indirect|lazy|weak)\\s+)*";
const swiftProfile: Profile = {
  mode: "brace",
  lex: { ...SLASH_LEX, multi: ['"""'] },
  strip: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)+/,
  rules: [
    R(new RegExp(`^\\s*${SW_MODS}(class|struct|enum|protocol|extension|actor)\\s+([\\w.]+)`), (m) => (m[1] === "struct" ? "struct" : m[1] === "enum" ? "enum" : m[1] === "protocol" ? "interface" : "class"), {
      group: 2,
      container: true,
      name: (m) => (m[1] === "extension" ? `extension ${m[2]}` : m[2]),
    }),
    R(new RegExp(`^\\s*${SW_MODS}func\\s+([^\\s(<]+)`), "function"),
    R(new RegExp(`^\\s*${SW_MODS}(init[?!]?)\\s*[(<]`), "method", { scope: "type" }),
    R(new RegExp(`^\\s*${SW_MODS}typealias\\s+(\\w+)`), "type"),
  ],
};

const phpProfile: Profile = {
  mode: "brace",
  lex: { line: ["//", "#"], block: [["/*", "*/"]], quotes: "\"'" },
  rules: [
    R(/^\s*namespace\s+([\w\\]+)/, "module", { container: true }),
    R(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/, (m) => (m[1] === "interface" ? "interface" : m[1] === "trait" ? "trait" : m[1] === "enum" ? "enum" : "class"), { group: 2, container: true }),
    R(/^\s*(?:(?:abstract|final|public|private|protected|static)\s+)*function\s+&?\s*(\w+)/, "function"),
    R(/^\s*(?:(?:public|private|protected|final)\s+)*const\s+(\w+)\s*=/, "constant"),
  ],
};

const rubyProfile: Profile = {
  mode: "indent",
  lex: { line: ["#"], quotes: "\"'", lineBlock: [/^=begin\b/, /^=end\b/] },
  rules: [
    R(/^\s*class\s+([A-Z][\w:]*)/, "class", { container: true }),
    R(/^\s*module\s+([A-Z][\w:]*)/, "module", { container: true }),
    R(/^\s*(?:(?:private|protected|public)\s+)?def\s+([^\s(;]+)/, "function", { container: true }),
  ],
};

const luaProfile: Profile = {
  mode: "flat",
  lex: { block: [["--[[", "]]"]], line: ["--"], quotes: "\"'" },
  rules: [
    R(/^\s*(?:local\s+)?function\s+([\w.:]+)/, (m) => (m[1].includes(":") ? "method" : "function"), { level: (m) => (m.input.startsWith(" ") || m.input.startsWith("\t") ? 1 : 0) }),
    R(/^\s*(?:local\s+)?([\w.]+)\s*=\s*function\b/, "function"),
  ],
};

const perlProfile: Profile = {
  mode: "flat",
  lex: { lineBlock: [/^=(?!cut\b)[a-zA-Z]/, /^=cut\b/] },
  rules: [R(/^\s*sub\s+(\w+)/, "function"), R(/^\s*package\s+([\w:]+)/, "module")],
};

const scalaProfile: Profile = {
  mode: "indent",
  lex: { ...SLASH_LEX, quotes: '"', multi: ['"""'] },
  rules: [
    R(/^\s*(?:(?:private|protected|final|sealed|abstract|implicit|case|override|lazy)(?:\[[^\]]*\])?\s+)*(class|object|trait|enum)\s+(\w+)/, (m) => (m[1] === "trait" ? "trait" : m[1] === "enum" ? "enum" : "class"), { group: 2, container: true }),
    R(/^\s*(?:(?:private|protected|final|override|implicit|inline|transparent)(?:\[[^\]]*\])?\s+)*def\s+(\w+|[^\s\w(]+)/, "function", { container: true }),
    R(/^\s*(?:(?:private|protected|final|override)\s+)*type\s+(\w+)/, "type"),
  ],
};

const juliaProfile: Profile = {
  mode: "indent",
  lex: { block: [["#=", "=#"]], line: ["#"], quotes: '"' },
  rules: [
    R(/^\s*function\s+([\w.!]+)/, "function", { container: true }),
    R(/^([A-Za-z_]\w*!?)\s*\([^)]*\)\s*(?:::\s*[\w.{},]+\s*)?=(?!=)/, "function", { container: true }),
    R(/^\s*(?:mutable\s+)?struct\s+(\w+)/, "struct", { container: true }),
    R(/^\s*abstract\s+type\s+(\w+)/, "type"),
    R(/^\s*(?:bare)?module\s+(\w+)/, "module", { container: true }),
    R(/^\s*macro\s+(\w+)/, "function", { container: true }),
    R(/^\s*const\s+([A-Za-z_]\w*)\s*=/, "constant"),
  ],
};

const rProfile: Profile = {
  mode: "flat",
  lex: { line: ["#"], quotes: "\"'" },
  rules: [R(/^\s*([A-Za-z_.][\w.]*)\s*(?:<-|=)\s*function\s*\(/, "function", { level: (m) => (/^\s/.test(m.input) ? 1 : 0) })],
};

const haskellProfile: Profile = {
  mode: "flat",
  lex: { block: [["{-", "-}"]], line: ["--"], quotes: '"' },
  rules: [
    R(/^module\s+([\w.]+)/, "module"),
    R(/^(?:data|newtype)\s+(?:\([^)]*\)\s*=>\s*|[^=]*=>\s*)?(\w+)/, "type"),
    R(/^type\s+(?:family\s+)?(\w+)/, "type"),
    R(/^class\s+(?:\([^)]*\)\s*=>\s*|[^=]*=>\s*)?(\w+)/, "class"),
    R(/^(instance\s+(?:[^=]*=>\s*)?.+?)\s+where\b/, "class"),
    R(/^([a-z_][\w']*)\s*::/, "function"),
  ],
};

const ocamlProfile: Profile = {
  mode: "flat",
  lex: { block: [["(*", "*)"]], quotes: '"' },
  rules: [
    R(/^(?:let|and)\s+(?:rec\s+)?(?:inline\s+)?([a-z_]\w*')?\s*(?=\S)(\w+)\s*((?:[~?]?\(?[\w:'.]+\)?\s*)*)=/, (m) => (m[3] && m[3].trim() ? "function" : "variable"), { group: 2, accept: (m) => m[2] !== "_" && !!m[2] && !/^(?:rec|open)$/.test(m[2]) }),
    R(/^module\s+(?:type\s+)?([A-Z]\w*)/, "module"),
    R(/^(?:and\s+)?type\s+(?:'\w+\s+|\([^)]*\)\s+)?(\w+)/, "type"),
    R(/^class\s+(?:virtual\s+)?(\w+)/, "class"),
    R(/^exception\s+(\w+)/, "type"),
    R(/^val\s+(\w+)/, "function"),
  ],
};

const fsharpProfile: Profile = {
  mode: "indent",
  lex: { block: [["(*", "*)"]], line: ["//"], quotes: '"' },
  rules: [
    R(/^\s*(?:namespace|module)\s+(?:rec\s+)?(?:internal\s+|private\s+|public\s+)?([\w.]+)/, "module"),
    R(/^\s*(?:and|type)\s+(?:private\s+|internal\s+|public\s+)?(\w+)/, "type", { container: true }),
    R(/^\s*(?:(?:static|override|abstract|default)\s+)*member\s+(?:inline\s+)?(?:\w+\.)?(\w+)/, "method", { scope: "type" }),
    R(/^\s*(?:let|and)\s+(?:rec\s+)?(?:inline\s+)?(?:private\s+|internal\s+|public\s+)?(?:mutable\s+)?(\w+)\s*(?:\(|\w+\s+|<)/, "function", { container: true, accept: (m, ctx) => ctx.indent < 8 && m[1] !== "_" }),
  ],
};

const erlangProfile: Profile = {
  mode: "flat",
  lex: { line: ["%"] },
  rules: [
    R(/^-module\(\s*(\w+)/, "module"),
    R(/^-record\(\s*(\w+)/, "struct"),
    R(/^-(?:type|opaque)\s+(\w+)/, "type"),
    R(/^-define\(\s*(\w+)/, "constant"),
    R(/^([a-z]\w*)\s*\(/, "function"),
  ],
};

const clojureProfile: Profile = {
  mode: "flat",
  rules: [
    R(/^\s*\(\s*(?:[\w.-]+\/)?(defn-?|defmacro|defmulti|defmethod|defprotocol|defrecord|deftype|defonce|def|ns)\s+(?:\^\S+\s+|\^\{[^}]*\}\s+)*([^\s()[\]{}]+)/, (m) => (m[1] === "ns" ? "module" : m[1] === "defprotocol" ? "interface" : /^def(?:record|type)$/.test(m[1]) ? "struct" : /^def(?:once)?$/.test(m[1]) ? "variable" : "function"), {
      group: 2,
      level: (m) => (/^\s/.test(m.input) ? 1 : 0),
    }),
  ],
};

const lispProfile: Profile = {
  mode: "flat",
  lex: { block: [["#|", "|#"]], line: [";"] },
  rules: [
    R(/^\s*\(\s*(defun|defmacro|defgeneric|defmethod|defclass|defstruct|defvar|defparameter|defconstant|defpackage|define-condition|define)\s+\(?([^\s()]+)/i, (m) => {
      const w = m[1].toLowerCase();
      return w === "defclass" || w === "define-condition" ? "class" : w === "defstruct" ? "struct" : w === "defpackage" ? "module" : w === "defvar" || w === "defparameter" ? "variable" : w === "defconstant" ? "constant" : "function";
    }, { group: 2, level: (m) => (/^\s/.test(m.input) ? 1 : 0) }),
  ],
};

const fortranProfile: Profile = {
  mode: "flat",
  lex: { line: ["!"], quotes: "\"'" },
  rules: [
    R(/^\s*(?:(?:pure|elemental|recursive|impure|module)\s+)*(?:(?:integer|real|double\s+precision|logical|character|complex|type)(?:\s*\([^)]*\)|\s*\*\s*\d+)?\s+)?(subroutine|function)\s+(\w+)/i, "function", { group: 2 }),
    R(/^\s*(program|module)\s+(?!procedure\b)(\w+)/i, "module", { group: 2 }),
    R(/^\s*type\s*(?:,[^:]*)?(?:::)?\s*(?!\()(\w+)\s*$/i, "struct"),
  ],
};

const pascalProfile: Profile = {
  mode: "flat",
  lex: { block: [["(*", "*)"], ["{", "}"]], line: ["//"], quotes: "'" },
  rules: [
    R(/^\s*(?:class\s+)?(procedure|function|constructor|destructor|operator)\s+([\w.]+)/i, (m) => (m[2].includes(".") ? "method" : "function"), { group: 2 }),
    R(/^\s*(unit|program|library)\s+(\w+)/i, "module", { group: 2 }),
    R(/^\s*(\w+)\s*(?:<[^>]*>)?\s*=\s*(?:packed\s+)?(class|record|interface|object)\b/i, (m) => (m[2].toLowerCase() === "interface" ? "interface" : m[2].toLowerCase() === "record" ? "struct" : "class")),
  ],
};

const vbProfile: Profile = {
  mode: "indent",
  lex: { line: ["'"], quotes: '"' },
  rules: [
    R(/^\s*(?:(?:Public|Private|Protected|Friend|Shared|Static|Overrides|Overridable|MustOverride|NotOverridable|Overloads|Async|Partial|Shadows|Default)\s+)*(Class|Module|Structure|Interface|Enum|Namespace)\s+(\w+)/i, (m) => {
      const w = m[1].toLowerCase();
      return w === "structure" ? "struct" : w === "interface" ? "interface" : w === "enum" ? "enum" : w === "class" ? "class" : "module";
    }, { group: 2, container: true }),
    R(/^\s*(?:(?:Public|Private|Protected|Friend|Shared|Static|Overrides|Overridable|MustOverride|NotOverridable|Overloads|Async|Partial|Shadows)\s+)*(?:Sub|Function)\s+(\w+)/i, "function", { container: true }),
  ],
};

const SQL_KIND: Record<string, SymbolKind> = { table: "table", view: "table", function: "function", procedure: "function", proc: "function", trigger: "function", type: "type", schema: "module", package: "module", sequence: "variable", index: "variable" };
const sqlProfile: Profile = {
  mode: "flat",
  lex: { block: [["/*", "*/"]], line: ["--"], quotes: "'" },
  rules: [
    R(/^\s*create\s+(?:or\s+(?:replace|alter)\s+)?(?:(?:temp|temporary|global|local|unlogged|materialized|recursive|unique|clustered|nonclustered|external|definer\s*=\s*\S+)\s+)*(table|view|function|procedure|proc|trigger|type|schema|package(?:\s+body)?|sequence|index)\s+(?:if\s+not\s+exists\s+)?([\w."[\]`]+)/i, (m) => SQL_KIND[m[1].toLowerCase().split(/\s/)[0]] ?? "variable", {
      group: 2,
      accept: (m) => !/^(?:on|if)$/i.test(m[2]),
    }),
  ],
};

const shellProfile: Profile = {
  mode: "flat",
  rules: [R(/^\s*function\s+([\w.:-]+)/, "function"), R(/^\s*([A-Za-z_][\w.:-]*)\s*\(\s*\)\s*(?:\{.*)?$/, "function")],
};

const psProfile: Profile = {
  mode: "flat",
  lex: { block: [["<#", "#>"]], line: ["#"], quotes: "\"'" },
  rules: [
    R(/^\s*(?:function|filter|workflow)\s+(?:(?:global|script|local|private):)?([\w-]+)/i, "function"),
    R(/^\s*class\s+(\w+)/i, "class"),
    R(/^\s*enum\s+(\w+)/i, "enum"),
  ],
};

const dockerfileProfile: Profile = {
  mode: "flat",
  rules: [R(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i, "section", { name: (m) => m[2] ?? m[1] })],
};

const makefileProfile: Profile = {
  mode: "flat",
  rules: [
    R(/^([A-Za-z0-9_.%/$()@*+-]+(?:[ \t]+[A-Za-z0-9_.%/$()@*+-]+)*)[ \t]*:(?![=:])/, "section", {
      accept: (m) => !/^\.[A-Z_]+$/.test(m[1]) && !/^(?:ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|include|override|vpath|unexport)\b/.test(m[1]),
    }),
  ],
};

const cmakeProfile: Profile = {
  mode: "flat",
  rules: [
    R(/^\s*(function|macro)\s*\(\s*(\w+)/i, "function", { group: 2 }),
    R(/^\s*(?:add_executable|add_library)\s*\(\s*([\w.${}-]+)/i, "module"),
  ],
};

const nginxProfile: Profile = {
  mode: "brace",
  lex: { line: ["#"], quotes: "\"'" },
  rules: [R(/^\s*(http|events|stream|mail|server|upstream\s+\S+|location\s+[^{]+?|map\s+[^{]+?|geo\s+[^{]+?)\s*\{/, "section", { container: true })],
};

const protoProfile: Profile = {
  mode: "brace",
  lex: SLASH_LEX,
  rules: [
    R(/^\s*package\s+([\w.]+)/, "module"),
    R(/^\s*(message|enum|service|extend)\s+([\w.]+)/, (m) => (m[1] === "enum" ? "enum" : m[1] === "service" ? "interface" : "struct"), { group: 2, container: true }),
    R(/^\s*rpc\s+(\w+)/, "method", { scope: "type" }),
  ],
};

const latexLevels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const latexProfile: Profile = {
  mode: "flat",
  rules: [
    R(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)\}/, "section", { group: 2, level: (m) => latexLevels[m[1]] ?? 0 }),
    R(/^\s*\\(?:re)?newcommand\*?\s*\{?\\(\w+)/, "function"),
  ],
};

const graphqlProfile: Profile = {
  mode: "brace",
  lex: { line: ["#"], multi: ['"""'], quotes: '"' },
  rules: [
    R(/^\s*(?:extend\s+)?(type|interface|enum|input|union|scalar|directive)\s+(@?\w+)/, (m) => (m[1] === "interface" ? "interface" : m[1] === "enum" ? "enum" : m[1] === "input" ? "struct" : "type"), { group: 2 }),
    R(/^\s*(query|mutation|subscription|fragment)\s+(\w+)/, "function", { group: 2 }),
  ],
};

const batchProfile: Profile = {
  mode: "flat",
  rules: [R(/^\s*:(?!:)([\w.-]+)/, "function")],
};

const cssLike = (scss: boolean, less: boolean): Profile => ({
  mode: "brace",
  lex: { block: [["/*", "*/"]], line: scss || less ? ["//"] : [], quotes: "\"'" },
  rules: [
    R(/^\s*(@(?:media|supports|layer|container|document|scope)\b[^{;]*?)\s*\{/, "section", { container: true }),
    R(/^\s*(@(?:-\w+-)?keyframes\s+[\w-]+)/, "selector"),
    R(/^\s*(@(?:font-face|page|property|counter-style)\b[^{;]*?)\s*\{/, "selector"),
    ...(scss ? [R(/^\s*@(?:mixin|function)\s+([\w-]+)/, "function"), R(/^\s*(\$[\w-]+)\s*:/, "variable")] : []),
    ...(less ? [R(/^\s*(@[\w-]+)\s*:/, "variable")] : []),
    R(/^\s*([^\s@{};/$][^{};]*?)\s*\{/, "selector", { accept: (m) => !/^[\d.]+%?$/.test(m[1]) && !/^(?:from|to)$/.test(m[1]) }),
  ],
});

const tomlProfile: Profile = {
  mode: "flat",
  rules: [R(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/, "table", { level: (m) => m[1].split(".").length - 1 })],
};
const iniProfile: Profile = {
  mode: "flat",
  rules: [R(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/, "section")],
};
const yamlProfile: Profile = {
  mode: "flat",
  rules: [
    R(/^([A-Za-z_][\w.-]*|"[^"]*"|'[^']*')\s*:(?:\s+(\S.*))?\s*$/, (m) => (m[2] && !/^[|>&!#]/.test(m[2]) ? "variable" : "section"), {
      name: (m) => m[1].replace(/^["']|["']$/g, ""),
    }),
  ],
};

// ------------------------------------------------------------------------------------------------ custom extractors

function markdown(lines: string[], out: OutlineSymbol[]): void {
  let fence = "";
  let start = 0;
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (let i = 1; i < lines.length && i < 200; i++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) {
        start = i + 1;
        break;
      }
    }
  }
  let prevText = false;
  for (let i = start; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = "";
      prevText = false;
      continue;
    }
    if (fence) continue;
    if (line.length > MAX_LINE_LENGTH) {
      prevText = false;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const name = tidy(atx[2]);
      if (name) out.push({ name, kind: "heading", line: i + 1, level: atx[1].length });
      prevText = false;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && prevText) {
      const prev = lines[i - 1];
      const name = tidy(prev);
      if (name) out.push({ name, kind: "heading", line: i, level: setext[1][0] === "=" ? 1 : 2 });
      prevText = false;
      continue;
    }
    prevText = line.trim() !== "" && !/^\s*(?:[-*+]\s|\d+[.)]\s|>|\||<)/.test(line) && !/^\s{4,}/.test(line);
  }
}

function html(lines: string[], out: OutlineSymbol[]): void {
  let inComment = false;
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    let line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue;
    if (inComment) {
      const e = line.indexOf("-->");
      if (e < 0) continue;
      line = line.slice(e + 3);
      inComment = false;
    }
    line = line.replace(/<!--.*?-->/g, " ");
    const c = line.indexOf("<!--");
    if (c >= 0) {
      inComment = true;
      line = line.slice(0, c);
    }
    const hm = /<h([1-6])\b[^>]*>(.*?)<\/h\1\s*>/i.exec(line);
    if (hm) {
      const name = tidy(hm[2].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " "));
      if (name) {
        out.push({ name, kind: "heading", line: i + 1, level: Number(hm[1]) });
        continue;
      }
    }
    for (const m of line.matchAll(/<[a-z][\w:-]*\b[^>]*?\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
      out.push({ name: tidy("#" + (m[1] ?? m[2])), kind: "selector", line: i + 1, level: 0 });
    }
  }
}

function diff(lines: string[], out: OutlineSymbol[]): void {
  const git = lines.some((l) => l.startsWith("diff --git "));
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const l = lines[i];
    if (l.length > MAX_LINE_LENGTH) continue;
    const m = git ? /^diff --git a\/.+? b\/(.+)$/.exec(l) : /^\+\+\+ (?:b\/)?([^\t]+)/.exec(l);
    if (m) out.push({ name: tidy(m[1]), kind: "section", line: i + 1, level: 0 });
  }
}

function vue(lines: string[], out: OutlineSymbol[]): void {
  const ts = jsProfile;
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const m = /^<(template|script|style)\b[^>]*>?/.exec(lines[i]);
    if (!m) continue;
    out.push({ name: tidy(m[0].replace(/>$/, "")), kind: "section", line: i + 1, level: 0 });
    if (m[1] === "script") {
      let end = i + 1;
      while (end < lines.length && !/^<\/script>/.test(lines[end])) end++;
      run(lines.slice(i + 1, end), ts, out, i + 1);
      i = end;
    }
  }
}

// ------------------------------------------------------------------------------------------------ registry

const none: Profile = { mode: "flat", rules: [] };
const jsLike = jsProfile;
const javaLike = javaProfile;
const css = cssLike(false, false);
const scss = cssLike(true, false);
const less = cssLike(false, true);

const profiles: Record<string, Profile> = {
  javascript: jsLike,
  typescript: jsLike,
  python: pyProfile,
  rust: rustProfile,
  go: goProfile,
  c: cProfile,
  cpp: cProfile,
  objectivec: objcProfile,
  csharp: csProfile,
  java: javaLike,
  groovy: javaLike,
  dart: dartProfile,
  kotlin: kotlinProfile,
  swift: swiftProfile,
  php: phpProfile,
  ruby: rubyProfile,
  lua: luaProfile,
  perl: perlProfile,
  scala: scalaProfile,
  julia: juliaProfile,
  r: rProfile,
  haskell: haskellProfile,
  ocaml: ocamlProfile,
  fsharp: fsharpProfile,
  erlang: erlangProfile,
  clojure: clojureProfile,
  lisp: lispProfile,
  fortran: fortranProfile,
  pascal: pascalProfile,
  vb: vbProfile,
  sql: sqlProfile,
  shell: shellProfile,
  powershell: psProfile,
  dockerfile: dockerfileProfile,
  makefile: makefileProfile,
  cmake: cmakeProfile,
  nginx: nginxProfile,
  protobuf: protoProfile,
  latex: latexProfile,
  graphql: graphqlProfile,
  batch: batchProfile,
  css,
  scss,
  less,
  toml: tomlProfile,
  ini: iniProfile,
  yaml: yamlProfile,
  markdown: { ...none, custom: markdown },
  html: { ...none, custom: html },
  vue: { ...none, custom: vue },
  diff: { ...none, custom: diff },
};

/** True when the language id has an outline extractor. */
export function hasSymbols(langId: string): boolean {
  return langId in profiles;
}

/** Symbols of `text` in document order. Unknown languages (plaintext, json, xml, log) yield an empty list. */
export function extractSymbols(text: string, langId: string): OutlineSymbol[] {
  const p = profiles[langId];
  if (!p || text === "") return [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.charCodeAt(l.length - 1) === 13) lines[i] = l.slice(0, -1);
  }
  const out: OutlineSymbol[] = [];
  if (p.custom) p.custom(lines, out);
  else run(lines, p, out);
  return out;
}

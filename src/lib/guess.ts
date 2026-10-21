// Guesses a language from the text itself, for tabs that have no file name (pasted code).
// Cheap, deterministic heuristics: structural checks first, then weighted pattern scores.

import { detectFromShebang } from "./languages";

type Rule = [RegExp, number];

const RULES: Record<string, Rule[]> = {
  python: [
    [/^\s*def \w+\(.*\)\s*(->\s*[\w[\], .]+)?:\s*$/m, 4],
    [/^\s*(from [\w.]+ import |import [\w.]+( as \w+)?\s*$)/m, 3],
    [/^\s*if __name__ == ["']__main__["']\s*:/m, 5],
    [/^\s*(elif .*:|except( \w+)?.*:|class \w+(\(.*\))?:)\s*$/m, 3],
    [/\bself\.\w+/, 2],
    [/^\s*print\(/m, 1],
  ],
  rust: [
    [/^\s*(pub(\([\w:]+\))? )?fn \w+(<.*>)?\(.*\)/m, 4],
    [/\blet mut \w+/, 3],
    [/^\s*use (std|crate|super)::/m, 4],
    [/\b(println|format|vec|panic|assert_eq)!\(/, 3],
    [/^\s*(impl|trait|enum|struct|mod)\b.*[{;]\s*$/m, 2],
    [/->\s*(Result|Option|Vec|String|&)/, 2],
  ],
  go: [
    [/^package \w+\s*$/m, 5],
    [/^func (\(\w+ \*?\w+\) )?\w+\(.*\).*\{\s*$/m, 4],
    [/\w+ := /, 2],
    [/\bfmt\.\w+\(/, 3],
    [/^import \(\s*$/m, 3],
  ],
  csharp: [
    [/^using System(\.\w+)*;/m, 5],
    [/^\s*namespace [\w.]+/m, 3],
    [/\bConsole\.(WriteLine|ReadLine)\(/, 4],
    [/\b(public|private|internal) (static )?(async )?(void|string|int|Task)\b/, 2],
    [/\bstatic (void|int) Main\(/, 4],
  ],
  java: [
    [/\bSystem\.out\.print(ln)?\(/, 5],
    [/^import java(x)?\.[\w.*]+;/m, 5],
    [/\bpublic static void main\(String/, 5],
    [/^\s*(public|private|protected) (final )?(abstract )?class \w+/m, 3],
    [/@Override\b/, 3],
  ],
  cpp: [
    [/^\s*#include\s*<(iostream|vector|string|map|memory|algorithm|set)>/m, 5],
    [/\bstd::\w+/, 3],
    [/\b(cout|cin|endl)\b/, 3],
    [/^\s*using namespace \w+;/m, 4],
    [/^\s*template\s*<.*>/m, 4],
    [/^\s*class \w+\s*(:\s*(public|private) \w+)?\s*\{/m, 2],
  ],
  c: [
    [/^\s*#include\s*<(stdio|stdlib|string|stdint|stddef|math)\.h>/m, 5],
    [/^\s*#include\s*"[\w./]+\.h"/m, 3],
    [/\b(int|void) main\s*\(.*\)\s*\{?/, 3],
    [/\bprintf\s*\(/, 2],
    [/^\s*#(define|ifdef|ifndef|endif)\b/m, 2],
  ],
  typescript: [
    [/^\s*(export )?(interface|type) \w+(<.*>)?\s*(=|\{)/m, 5],
    [/:\s*(string|number|boolean|void|unknown|any|never)\b(\[\])?\s*[,;)=\n{]/, 3],
    [/\bas (const|string|number|unknown|any)\b/, 3],
    [/\)\s*:\s*(Promise<|void|string|number|boolean)/, 3],
    [/^\s*import type\b/m, 5],
    [/<\w+(,\s*\w+)*>\(/, 1],
  ],
  javascript: [
    [/^\s*(const|let|var) \w+(\s*=|\s*,|;)/m, 3],
    [/\bfunction\s*\w*\s*\(.*\)\s*\{/, 3],
    [/=>\s*[{(\w]/, 2],
    [/\bconsole\.(log|error|warn)\(/, 3],
    [/\brequire\(["'][^"']+["']\)/, 4],
    [/^\s*(import .+ from ["'].+["'];?|export (default|const|function|class) )/m, 3],
    [/\b(document|window)\.\w+/, 2],
    [/\bmodule\.exports\b/, 4],
  ],
  sql: [
    [/\bselect\b[\s\S]{1,400}\bfrom\b/i, 4],
    [/\b(insert\s+into|create\s+table|alter\s+table|drop\s+table|delete\s+from)\b/i, 5],
    [/\bupdate\s+\w+\s+set\b/i, 5],
    [/\b(where|group\s+by|order\s+by|inner\s+join|left\s+join)\b/i, 1],
  ],
  powershell: [
    [/\b(Get|Set|New|Remove|Write|Invoke|Import)-[A-Z]\w+/, 4],
    [/^\s*\$\w+\s*=/m, 2],
    [/^\s*param\s*\(/im, 4],
    [/\s-(eq|ne|gt|lt|like|match|and|or)\s/, 2],
    [/\bWrite-Host\b/, 4],
  ],
  shell: [
    [/^\s*(if \[.*\]; then|fi|esac|done)\s*$/m, 3],
    [/\$\([^)]*\)|\$\{\w+[^}]*\}/, 2],
    [/^\s*(echo|export|source|cd|grep|sudo|apt|npm|chmod) /m, 2],
    [/^\s*\w+=\S+\s*$/m, 1],
    [/\s(&&|\|\|)\s|\s2>&1\b/, 2],
  ],
  css: [
    [/^\s*[.#@]?[\w:->\s,.*#[\]="']+\{\s*$/m, 1],
    [/^\s*[a-z-]+\s*:\s*[^;{}]+;\s*$/m, 2],
    [/^\s*@(media|import|font-face|keyframes|charset)\b/m, 4],
    [/\b(margin|padding|display|color|background(-color)?|font-size|border)\s*:/, 2],
  ],
  yaml: [
    [/^---\s*$/m, 2],
    [/^[\w.-]+:\s+\S.*$/m, 1],
    [/^\s*-\s+[\w.-]+:\s+\S/m, 2],
    [/^[\w.-]+:\s*$/m, 1],
  ],
  toml: [
    [/^\[[\w.\-"]+\]\s*$/m, 2],
    [/^\[\[[\w.-]+\]\]\s*$/m, 4],
    [/^[\w.-]+\s*=\s*("[^"\n]*"|'[^'\n]*'|\d+|true|false|\[.*\])\s*$/m, 2],
  ],
  ini: [
    [/^\[[^\]\n]+\]\s*$/m, 2],
    [/^[\w. -]+=[^\n]*$/m, 1],
    [/^\s*;.*$/m, 2],
  ],
  markdown: [
    [/^#{1,6} \S.*$/m, 3],
    [/^#{2,6} \S.*$/m, 2],
    [/^```[\w-]*\s*$/m, 4],
    [/\[[^\]\n]+\]\([^)\n]+\)/, 3],
    [/^\s*([-*+]|\d+\.) \S.*$/m, 1],
    [/(\*\*[^*\n]+\*\*|__[^_\n]+__)/, 2],
    [/^>\s+\S/m, 1],
  ],
  log: [
    [/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m, 3],
    [/\b(INFO|WARN(ING)?|ERROR|DEBUG|TRACE|FATAL)\b/, 2],
  ],
};

const THRESHOLD = 4;

function score(text: string, rules: Rule[]): number {
  let s = 0;
  for (const [re, w] of rules) if (re.test(text)) s += w;
  return s;
}

/** Returns a language id for `text`, or null when nothing is convincing. Only looks at the first ~20 KB. */
export function guessLanguage(input: string): string | null {
  const text = input.length > 20000 ? input.slice(0, 20000) : input;
  const trimmed = text.trim();
  if (trimmed.length < 6) return null;

  const firstLine = trimmed.split("\n", 1)[0];
  const shebang = detectFromShebang(firstLine);
  if (shebang) return shebang.id;

  if (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed) && input.length < 1_000_000) {
    try {
      JSON.parse(input);
      return "json";
    } catch {
      /* not JSON; fall through */
    }
  }
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed) || (/<\/(div|body|head|p|span|ul|a|script|section)>/i.test(trimmed) && /^<\w/.test(trimmed))) return "html";
  if (/^<\?xml\b/.test(trimmed) || /^<svg[\s>]/.test(trimmed)) return "xml";
  if (/^<([A-Za-z][\w:.-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(trimmed)) return "xml";
  if (/^diff --git |^--- .+\n\+\+\+ .+\n@@ /m.test(trimmed)) return "diff";

  const scores: [string, number][] = Object.entries(RULES).map(([id, rules]) => [id, score(text, rules)]);
  // A TypeScript snippet is also valid-looking JavaScript; the type syntax decides.
  const byId = Object.fromEntries(scores);
  if (byId.typescript >= THRESHOLD) byId.javascript = 0;
  else byId.typescript = 0;
  // C++ includes C's patterns; C needs C-only evidence.
  if (byId.cpp >= THRESHOLD) byId.c = 0;
  // YAML: most non-empty lines are `key:` / `key: value` / list items.
  const lines = text.split("\n").filter((l) => l.trim());
  const yamlish = lines.filter((l) => /^\s*(-\s+)?[\w.-]+:(\s|$)/.test(l) || /^\s*-\s+\S/.test(l)).length;
  if (lines.length >= 3 && yamlish / lines.length >= 0.6) byId.yaml += 4;
  // INI vs TOML: TOML has typed values and `#` comments; INI has `;` comments and bare words.
  const iniEvidence = /^\s*;/m.test(text) || /^[\w. -]+=\s*(?!true\b|false\b)[A-Za-z][^\n"']*$/m.test(text);
  if (iniEvidence) byId.toml = 0;
  if (byId.toml >= THRESHOLD) byId.ini = 0;
  if (byId.ini > 0 && byId.toml < THRESHOLD && /^\s*;/m.test(text)) byId.ini += 1;
  if (byId.yaml > 0 && /[;{}]\s*$/m.test(text) && !/^---/.test(trimmed)) byId.yaml = 0;
  if (byId.css > 0 && /\b(function|const|let|var|def|import)\b/.test(text)) byId.css = 0;
  if (byId.shell > 0 && byId.powershell >= THRESHOLD) byId.shell = 0;
  // Markdown is permissive; code rules win when they are strong.
  const ranked = Object.entries(byId).sort((a, b) => b[1] - a[1]);
  const [bestId, best] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  if (best < THRESHOLD) return null;
  if (bestId === "markdown" && second >= THRESHOLD && second >= best - 1) return ranked[1][0];
  if (best - second < 1 && !(bestId === "yaml" || bestId === "ini")) return null;
  return bestId;
}

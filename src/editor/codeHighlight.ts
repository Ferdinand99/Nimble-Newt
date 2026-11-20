// Syntax highlighting for code blocks outside the editor (the Markdown view), with the editor's own
// grammars and colours: the language is loaded on demand like in a tab, the tree is coloured with the
// editor's HighlightStyle, so code looks the same in both places and follows the theme.

import { Language, LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { highlightCode } from "@lezer/highlight";
import { LANGUAGES, type LanguageDef } from "../lib/languages";
import { highlightStyle } from "./theme";

/** Names used after ``` that are neither a language id, a language name nor a file extension. */
const ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  console: "shell",
  "shell-session": "shell",
  shellsession: "shell",
  golang: "go",
  json5: "json",
  node: "javascript",
  py3: "python",
  python3: "python",
  rb: "ruby",
  ps: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  md: "markdown",
  html5: "html",
  svg: "xml",
  docker: "dockerfile",
};

/** The editor language for a fence's info word ("ts", "TypeScript", "rust", "c++"), or null. */
export function languageForFence(word: string): LanguageDef | null {
  const w = word.trim().toLowerCase();
  if (!w) return null;
  const id = ALIASES[w] ?? w;
  return (
    LANGUAGES.find((l) => l.id === id) ??
    LANGUAGES.find((l) => l.name.toLowerCase() === id) ??
    LANGUAGES.find((l) => l.extensions.includes(id)) ??
    null
  );
}

function findLanguage(ext: Extension): Language | null {
  if (ext instanceof Language) return ext;
  if (ext instanceof LanguageSupport) return ext.language;
  if (Array.isArray(ext)) {
    for (const e of ext) {
      const l = findLanguage(e);
      if (l) return l;
    }
  }
  return null;
}

const grammars = new Map<string, Promise<Language | null>>();
function grammar(def: LanguageDef): Promise<Language | null> {
  let p = grammars.get(def.id);
  if (!p) {
    p = def.load().then(findLanguage, () => null);
    grammars.set(def.id, p);
  }
  return p;
}

/** Code longer than this stays plain: colouring it would hold up the view for little gain. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

export type Run = [text: string, classes: string];

/** Highlighted runs of `code` in `lang` (null when the language is unknown or the code too long). */
export async function highlightRuns(code: string, lang: string): Promise<Run[] | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const def = languageForFence(lang);
  if (!def || def.id === "plaintext") return null;
  const language = await grammar(def);
  if (!language) return null;
  const runs: Run[] = [];
  highlightCode(code, language.parser.parse(code), highlightStyle, (text, classes) => runs.push([text, classes]), () => runs.push(["\n", ""]));
  return runs;
}

/** Replaces the text of `el` with highlighted spans. Text is set as text, never parsed as HTML. */
export function applyRuns(el: HTMLElement, runs: Run[]): void {
  const frag = document.createDocumentFragment();
  for (const [text, classes] of runs) {
    if (!classes) frag.append(text);
    else {
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = text;
      frag.append(span);
    }
  }
  el.replaceChildren(frag);
}

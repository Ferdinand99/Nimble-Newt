// Markdown to HTML for the Markdown view: CommonMark plus the GitHub extensions (tables, task lists,
// strikethrough, autolinks). The output is NOT safe yet: raw HTML from the file passes through, so it
// must always go through `sanitizeMarkdown` (mdSanitize.ts) before it reaches the page.

import MarkdownIt, { type MarkdownIt as Md, type StateCore as CoreState, type Token } from "markdown-it";
import { slugify } from "./mdLinks";

/** A fence's language, as given after the backticks: the first word, limited to safe characters. */
export function fenceLanguage(info: string): string {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,40}$/.test(word) ? word.toLowerCase() : "";
}

/** `[ ]` / `[x]` at the start of a list item becomes a disabled checkbox (GitHub task lists). */
function taskLists(state: CoreState): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const first = inline.children?.[0];
    if (!first || first.type !== "text") continue;
    const m = /^\[([ xX])\](?=\s|$)/.exec(first.content);
    if (!m) continue;
    first.content = first.content.slice(m[0].length).replace(/^\s/, "");
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
    inline.children!.unshift(box);
    const item = tokens[i - 2];
    item.attrJoin("class", "task-list-item");
    for (let j = i - 3; j >= 0; j--) {
      const t = tokens[j];
      if ((t.type === "bullet_list_open" || t.type === "ordered_list_open") && t.level === item.level - 1) {
        if (!String(t.attrGet("class") ?? "").includes("contains-task-list")) t.attrJoin("class", "contains-task-list");
        break;
      }
    }
  }
}

/** Ids on headings, so `#links` work; repeated titles get -1, -2, … like on GitHub. */
function headingIds(state: CoreState): void {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== "heading_open") continue;
    const text = (tokens[i + 1].children ?? []).filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("");
    const base = slugify(text);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    tokens[i].attrSet("id", n ? `${base}-${n}` : base);
  }
}


let instance: Md | null = null;

export function markdownIt(): Md {
  if (instance) return instance;
  const md = new MarkdownIt("default", { html: true, linkify: true, typographer: false, breaks: false });
  // GitHub links "www.example.com" without a scheme; markdown-it only does that with fuzzy links on.
  md.linkify.set({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false });
  md.core.ruler.after("inline", "nn-task-lists", taskLists);
  md.core.ruler.push("nn-heading-ids", headingIds);
  const escape = md.utils.escapeHtml;
  // Code blocks carry their language for the highlighter, which runs on the DOM after sanitising.
  md.renderer.rules.fence = (tokens: Token[], idx: number) => {
    const t = tokens[idx];
    const lang = fenceLanguage(t.info);
    const line = t.attrGet("data-line");
    const cls = lang ? ` class="language-${escape(lang)}" data-lang="${escape(lang)}"` : "";
    return `<pre${line === null ? "" : ` data-line="${line}"`}><code${cls}>${escape(t.content)}</code></pre>\n`;
  };
  instance = md;
  return md;
}

/** A piece of the rendered document: a run of top-level blocks starting at source line `line`. */
export interface Chunk {
  /** Unsanitised HTML. `data-line` attributes in it are relative to `line`. */
  html: string;
  /** First source line of the chunk, 0-based. */
  line: number;
}

/** FNV-1a over a range of source lines; decides where chunks end. */
function hashLines(lines: string[], from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let l = from; l < to && l < lines.length; l++) {
    const s = lines[l];
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 10, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Renders Markdown as a list of chunks. Chunk ends depend on the content of the blocks only (a hash of
 * each top-level block), and line numbers inside a chunk are relative to its start, so an edit
 * changes the HTML of the chunk it is in and leaves the others byte for byte equal: the view only
 * sanitises and replaces what changed. With `single`, the whole document is one chunk.
 */
export function renderChunks(src: string, single = false): Chunk[] {
  const md = markdownIt();
  const env = {};
  const tokens = md.parse(src, env);
  const lines = single ? [] : src.split("\n");
  const chunks: Chunk[] = [];
  let start = 0;
  let blocks = 0;
  const flush = (end: number) => {
    const part = tokens.slice(start, end);
    const base = single ? 0 : (part.find((t) => t.map)?.map?.[0] ?? 0);
    for (const t of part) {
      if (t.map && (t.nesting === 1 || t.type === "hr" || t.type === "code_block" || t.type === "fence")) t.attrSet("data-line", String(t.map[0] - base));
    }
    chunks.push({ html: md.renderer.render(part, md.options, env), line: base });
    start = end;
    blocks = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A top-level block ends at its closing token, or is a single token (a fence, a rule, an HTML block).
    if (t.level !== 0 || t.nesting === 1) continue;
    blocks++;
    if (single) continue;
    const map = tokens[t.nesting === 0 ? i : findOpen(tokens, i)].map;
    const h = map ? hashLines(lines, map[0], map[1]) : 0;
    if ((blocks >= 4 && (h & 15) === 0) || blocks >= 64) flush(i + 1);
  }
  if (start < tokens.length || chunks.length === 0) flush(tokens.length);
  return chunks;
}

/** The opening token of the top-level block that closes at `close`. */
function findOpen(tokens: Token[], close: number): number {
  for (let j = close - 1; j >= 0; j--) if (tokens[j].level === 0 && tokens[j].nesting === 1) return j;
  return close;
}

/** Renders Markdown to (unsanitised) HTML, as one piece. */
export function renderMarkdown(src: string): string {
  return renderChunks(src, true)[0].html;
}

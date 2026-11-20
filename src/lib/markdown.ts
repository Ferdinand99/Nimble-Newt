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

/** The wrapper of a large list or table whose items or rows are spread over several chunks. */
type Wrap =
  | { kind: "list"; open: Token; close: Token; start: number }
  | { kind: "table"; open: Token; close: Token; head: Token[]; bodyOpen: Token; bodyClose: Token };

/** A unit chunks are made of: a top-level block, or one item or row of a large list or table. */
interface Piece {
  tokens: Token[];
  map: [number, number] | null;
  wrap?: Wrap;
  /** Position of the item or row in its list or table. */
  index: number;
}

/** Lists and tables with more tokens than this are split between items or rows. */
const SPLIT_TOKENS = 400;

function clone(t: Token): Token {
  const c = Object.assign(Object.create(Object.getPrototypeOf(t) as object) as Token, t);
  c.attrs = t.attrs ? t.attrs.map(([k, v]) => [k, v] as [string, string]) : null;
  return c;
}

/** Index of the token that closes the one opened at `open` (same level, nesting -1). */
function closeOf(tokens: Token[], open: number): number {
  const level = tokens[open].level;
  for (let j = open + 1; j < tokens.length; j++) if (tokens[j].level === level && tokens[j].nesting === -1) return j;
  return tokens.length - 1;
}

/** The children at `level` between `from` and `to` that open with `type`, as [open, close] ranges. */
function children(tokens: Token[], from: number, to: number, type: string): [number, number][] {
  const out: [number, number][] = [];
  for (let k = from; k < to; k++) {
    if (tokens[k].type === type && tokens[k].nesting === 1) {
      const c = closeOf(tokens, k);
      out.push([k, c]);
      k = c;
    }
  }
  return out;
}

function pieces(tokens: Token[], split: boolean): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.nesting !== 1) {
      out.push({ tokens: [t], map: t.map, index: 0 });
      continue;
    }
    const j = closeOf(tokens, i);
    const big = split && j - i > SPLIT_TOKENS;
    if (big && (t.type === "bullet_list_open" || t.type === "ordered_list_open")) {
      const wrap: Wrap = { kind: "list", open: t, close: tokens[j], start: Number(t.attrGet("start") ?? 1) };
      children(tokens, i + 1, j, "list_item_open").forEach(([a, b], index) => out.push({ tokens: tokens.slice(a, b + 1), map: tokens[a].map, wrap, index }));
    } else if (big && t.type === "table_open") {
      const [head] = children(tokens, i + 1, j, "thead_open");
      const [body] = children(tokens, i + 1, j, "tbody_open");
      if (!body) {
        out.push({ tokens: tokens.slice(i, j + 1), map: t.map, index: 0 });
      } else {
        const wrap: Wrap = {
          kind: "table",
          open: t,
          close: tokens[j],
          head: head ? tokens.slice(head[0], head[1] + 1) : [],
          bodyOpen: tokens[body[0]],
          bodyClose: tokens[body[1]],
        };
        children(tokens, body[0] + 1, body[1], "tr_open").forEach(([a, b], index) => out.push({ tokens: tokens.slice(a, b + 1), map: tokens[a].map, wrap, index }));
      }
    } else out.push({ tokens: tokens.slice(i, j + 1), map: t.map, index: 0 });
    i = j;
  }
  return out;
}

/** The tokens of one chunk: its pieces, with the list or table around runs of items or rows. */
function assemble(run: Piece[]): Token[] {
  const out: Token[] = [];
  let open: Wrap | undefined;
  const close = () => {
    if (open?.kind === "table") out.push(open.bodyClose, open.close);
    else if (open) out.push(open.close);
    open = undefined;
  };
  for (const p of run) {
    if (p.wrap !== open) {
      close();
      if (p.wrap) {
        const w = p.wrap;
        const head = clone(w.open);
        if (p.index > 0) head.map = null; // a continuation has no source line of its own
        if (w.kind === "list") {
          if (w.open.type === "ordered_list_open" && p.index > 0) head.attrSet("start", String(w.start + p.index));
          head.attrJoin("class", "md-split-list");
          out.push(head);
        } else {
          // All parts of a split table share fixed column widths, so the columns line up.
          head.attrJoin("class", "md-split-table");
          out.push(head);
          if (p.index === 0) out.push(...w.head);
          out.push(w.bodyOpen);
        }
        open = w;
      }
    }
    out.push(...p.tokens);
  }
  close();
  return out;
}

/**
 * Renders Markdown as a list of chunks. Chunk ends depend on the content of the blocks only (a hash of
 * each top-level block, or of each item or row of a large list or table), and line numbers inside a
 * chunk are relative to its start, so an edit changes the HTML of the chunk it is in and leaves the
 * others byte for byte equal: the view only sanitises and replaces what changed. A large list or
 * table is spread over several chunks (an ordered list continues with `start`, a table repeats no
 * header). With `single`, the whole document is one chunk.
 */
export function renderChunks(src: string, single = false): Chunk[] {
  const md = markdownIt();
  const env = {};
  const tokens = md.parse(src, env);
  const lines = single ? [] : src.split("\n");
  const chunks: Chunk[] = [];
  const flush = (run: Piece[]) => {
    const part = assemble(run);
    const base = single ? 0 : (part.find((t) => t.map)?.map?.[0] ?? 0);
    for (const t of part) {
      if (t.map && (t.nesting === 1 || t.type === "hr" || t.type === "code_block" || t.type === "fence")) t.attrSet("data-line", String(t.map[0] - base));
    }
    chunks.push({ html: md.renderer.render(part, md.options, env), line: base });
  };
  let run: Piece[] = [];
  for (const p of pieces(tokens, !single)) {
    run.push(p);
    if (single) continue;
    const h = p.map ? hashLines(lines, p.map[0], p.map[1]) : 0;
    if ((run.length >= 4 && (h & 15) === 0) || run.length >= 64) {
      flush(run);
      run = [];
    }
  }
  if (run.length || chunks.length === 0) flush(run);
  return chunks;
}

/** Renders Markdown to (unsanitised) HTML, as one piece. */
export function renderMarkdown(src: string): string {
  return renderChunks(src, true)[0].html;
}

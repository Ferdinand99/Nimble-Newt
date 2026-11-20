// The Markdown view: Markdown tabs can be shown as the editor only (Edit), the editor with the rendered
// document beside it (Split, updated while typing, scrolling together) or the rendered document only
// (Read). Each tab remembers its view; the session stores it.
//
// Safety: the HTML from markdown-it always goes through `sanitizeMarkdown` first. Nothing in the
// rendered document loads by itself: local images are read by the backend (only from the document's
// folder), remote images are downloaded by the backend after the user chose "Show images" for that
// document, and every click on a link is handled here. The webview's CSP (img-src 'self' data:) is
// unchanged and is the last line of defence.
//
// The renderer and sanitiser (markdown-it, DOMPurify) load on first use, not at start-up.

import { EditorView } from "@codemirror/view";
import { readOnlyEffect } from "../editor/setup";
import { t } from "../lib/i18n";
import { api, errorMessage } from "../lib/api";
import { h } from "../lib/dom";
import { dirname } from "../lib/logic";
import { resolveRelative } from "../lib/mdLinks";
import { effectiveMdView, isMarkdownDoc, nextMdView, renderDelay, type MdAction, type MdView } from "../lib/mdView";
import { toast } from "../ui/toast";
import { workspace, type Doc } from "./workspace";
import "../styles/markdown.css";

interface DocState {
  /** The user chose "Show images" for this document (not stored: asked again after a restart). */
  remoteAllowed: boolean;
  /** Scroll position of the read view, kept while switching tabs. */
  scrollTop: number | null;
}
const states = new WeakMap<Doc, DocState>();
const stateOf = (d: Doc): DocState => {
  let s = states.get(d);
  if (!s) states.set(d, (s = { remoteAllowed: false, scrollTop: null }));
  return s;
};

type Lib = typeof import("./markdownLib");
type Chunk = import("./markdownLib").Chunk;
let lib: Promise<Lib> | null = null;
const loadLib = (): Promise<Lib> => (lib ??= import("./markdownLib"));

interface Pane {
  root: HTMLElement;
  bar: HTMLElement;
  barText: HTMLElement;
  body: HTMLElement;
}
let pane: Pane | null = null;
interface ShownChunk {
  html: string;
  el: HTMLElement;
}
/** What the view currently shows: the tab, the exact text (CodeMirror's Text is immutable) and its chunks. */
let shown: { doc: Doc; text: unknown; chunks: ShownChunk[] } | null = null;
let shownView: MdView = "edit";
let renderTimer: number | undefined;
let lastRenderMs = 0;
let renderSeq = 0;
/** The editor's top line when the view was opened, for placing the first render. */
let openedAtLine = 0;

const col = (): HTMLElement => document.getElementById("editor")!.parentElement!;
/** Not `view.hasFocus`, which is false while the window itself is not focused. */
const editorHasFocus = (): boolean => !!document.getElementById("editor")?.contains(document.activeElement);

// ---- layout ------------------------------------------------------------------------------------------------

function ensurePane(): Pane {
  if (pane) return pane;
  const barText = h("span", { class: "md-bar-text" });
  const show = h("button", { class: "btn btn-sm", type: "button", onclick: () => allowRemoteImages() }, t("markdown.showImages"));
  const bar = h("div", { class: "md-bar", role: "status", hidden: true }, barText, show);
  const body = h("article", { class: "md-body", tabIndex: 0, "aria-label": t("markdown.preview") });
  const root = h("section", { class: "md-preview", hidden: true }, bar, body);
  body.addEventListener("click", onClick);
  body.addEventListener("auxclick", (e) => {
    if ((e.target as Element).closest("a")) e.preventDefault();
  });
  body.addEventListener("scroll", onPreviewScroll, { passive: true });
  body.addEventListener("load", () => (blocks = null), true); // an image changed the layout
  new ResizeObserver(() => (blocks = null)).observe(body);
  col().append(root);
  pane = { root, bar, barText, body };
  // The read view is not editable: focus that lands in the hidden editor (a click that WebKit does not
  // move to the button, a command that focuses the editor) goes to the rendered view instead.
  document.getElementById("editor")!.addEventListener("focusin", () => {
    if (shownView === "read" && pane && !pane.root.hidden) pane.body.focus({ preventScroll: true });
  });
  workspace.view.scrollDOM.addEventListener("scroll", onEditorScroll, { passive: true });
  return pane;
}

/** Applies the active tab's view to the layout and renders when needed. */
function apply(): void {
  const d = workspace.active;
  const view = effectiveMdView(d);
  const c = col();
  const before = shownView;
  if (before === "read" && shown && pane) {
    if (shown.doc !== d) stateOf(shown.doc).scrollTop = pane.body.scrollTop;
    // Leaving the read view of the same tab: the editor continues where the reader was.
    else if (view !== "read") scrollEditorToLine(lineForPreviewTop(pane.body.scrollTop));
  }
  if (view !== "edit" && shown?.doc !== d) openedAtLine = editorTopLine();
  setEditorReadOnly(view === "read");
  c.classList.toggle("md-split", view === "split");
  c.classList.toggle("md-read", view === "read");
  shownView = view;
  if (view === "edit") {
    if (pane) pane.root.hidden = true;
    clearTimeout(renderTimer);
    shown = null;
    if (before !== "edit") workspace.view.requestMeasure();
    return;
  }
  // The editor's own split (a second editor) and the Markdown view share the space: one at a time.
  if (c.classList.contains("split")) void import("./split").then((m) => m.closeSplit());
  const p = ensurePane();
  p.root.hidden = false;
  if (before === "read" || view === "read") workspace.view.requestMeasure();
  if (shown?.doc !== d) {
    shown = null;
    void render(true);
  } else if (before !== view) {
    blocks = null;
    if (view === "split") syncFromEditor();
  }
  if (view === "read" && (document.activeElement === document.body || editorHasFocus())) p.body.focus({ preventScroll: true });
}

/** The hidden editor of the read view must not take any input (WebKit even types into an unfocused one). */
function setEditorReadOnly(on: boolean): void {
  const v = workspace.view;
  if (v.state.facet(EditorView.editable) === !on) return;
  v.dispatch({ effects: readOnlyEffect(on) });
}

export function setView(d: Doc, view: MdView): void {
  if (!isMarkdownDoc(d)) return;
  workspace.setMdView(d, view);
}

/** Runs one of the Markdown view commands on the active tab. */
export function mdCommand(action: MdAction): void {
  const d = workspace.active;
  if (!d || !isMarkdownDoc(d)) return void toast(t("markdown.notMarkdown"), "info");
  const next = nextMdView(d.mdView, action);
  setView(d, next);
  if (next === "edit") workspace.focus();
}

// ---- rendering ---------------------------------------------------------------------------------------------

function scheduleRender(): void {
  const d = workspace.active;
  if (!d || effectiveMdView(d) === "edit") return;
  if (shown?.doc === d && shown.text === workspace.view.state.doc) return;
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void render(false), renderDelay(workspace.view.state.doc.length, lastRenderMs));
}

async function render(fresh: boolean): Promise<void> {
  clearTimeout(renderTimer);
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  const m = await loadLib();
  const d = workspace.active;
  if (!alive() || !d || !pane || effectiveMdView(d) === "edit") return;
  const text = workspace.view.state.doc;
  const started = performance.now();
  let chunks: Chunk[];
  try {
    chunks = await m.renderChunksAsync(text.toString());
  } catch (e) {
    if (alive() && pane) {
      shown = null;
      pane.body.replaceChildren(h("p", { class: "md-error" }, t("markdown.renderFailed", { error: errorMessage(e) })));
    }
    return;
  }
  if (!alive() || workspace.active !== d || effectiveMdView(d) === "edit" || !pane) return;
  const body = pane.body;
  // Chunks equal to what is shown keep their elements (and loaded images); only the changed middle is
  // sanitised again, a few chunks at a time so that the window stays responsive.
  const prev = shown?.doc === d ? shown.chunks : [];
  if (!prev.length) body.replaceChildren();
  let head = 0;
  while (head < prev.length && head < chunks.length && prev[head].html === chunks[head].html) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < chunks.length - head && prev[prev.length - 1 - tail].html === chunks[chunks.length - 1 - tail].html) tail++;
  const made: ShownChunk[] = [];
  let slice = performance.now();
  for (let i = head; i < chunks.length - tail; i++) {
    const el = h("div", { class: "md-chunk" });
    el.append(m.sanitizeMarkdown(chunks[i].html).fragment);
    made.push({ html: chunks[i].html, el });
    // The first render fills the view as it goes; later ones swap the changed part in at once.
    if (!prev.length) body.append(el);
    if (performance.now() - slice > 12) {
      await m.pause();
      if (!alive() || !pane) return;
      slice = performance.now();
    }
  }
  if (prev.length) {
    for (const old of prev.slice(head, prev.length - tail)) old.el.remove();
    body.insertBefore(fragmentOf(made), tail ? prev[prev.length - tail].el : null);
  }
  const all = [...prev.slice(0, head), ...made, ...prev.slice(prev.length - tail)];
  all.forEach((c, i) => (c.el.dataset.base = String(chunks[i].line)));
  shown = { doc: d, text, chunks: all };
  lastRenderMs = performance.now() - started;
  blocks = null;
  decorate(d, made.map((c) => c.el), m);
  if (shownView === "split") syncFromEditor();
  else if (fresh) setPreviewScroll(stateOf(d).scrollTop ?? previewTopForLine(openedAtLine));
}

function fragmentOf(chunks: ShownChunk[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of chunks) f.append(c.el);
  return f;
}

/** After a render, for the new chunks: link titles, images and code colours. */
function decorate(d: Doc, roots: HTMLElement[], m: Lib): void {
  const st = stateOf(d);
  for (const root of roots) {
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a[data-md-link]")) {
      const kind = a.dataset.mdLink;
      if (kind === "blocked") {
        a.title = t("markdown.linkBlocked");
        a.classList.add("md-link-blocked");
      } else if (kind === "external" && !a.title) a.title = a.dataset.mdHref ?? "";
    }
    for (const img of root.querySelectorAll<HTMLImageElement>("img[data-md-blocked]")) placeholder(img, t("markdown.imageBlocked"));
    loadLocalImages(d, root);
    if (st.remoteAllowed) loadRemoteImages(root);
    else for (const img of root.querySelectorAll<HTMLImageElement>("img[data-md-remote]")) placeholder(img, t("markdown.imageRemote"));
  }
  if (pane) {
    const remote = pane.body.querySelectorAll("img[data-md-remote]").length;
    pane.bar.hidden = !remote || st.remoteAllowed;
    pane.barText.textContent = t("markdown.remoteBlocked", { n: remote });
  }
  void m.highlightBlocks(roots, () => shown?.doc === d && roots.every((r) => r.isConnected)).then(() => (blocks = null));
}

function placeholder(img: HTMLImageElement, why: string): void {
  img.classList.add("md-img-placeholder");
  img.title = img.alt ? `${img.alt} — ${why}` : why;
  if (!img.alt) img.alt = why;
}

// ---- images ------------------------------------------------------------------------------------------------

/** data: URLs of images already read, so typing does not read them again. Bounded by size. */
const imageCache = new Map<string, Promise<string>>();
const imageSizes = new Map<string, number>();
const CACHE_BYTES = 64 * 1024 * 1024;

function cached(key: string, load: () => Promise<string>): Promise<string> {
  let p = imageCache.get(key);
  if (p) {
    imageCache.delete(key); // keep the most recently used at the end
    imageCache.set(key, p);
    return p;
  }
  p = load();
  imageCache.set(key, p);
  p.then(
    (url) => {
      imageSizes.set(key, url.length);
      let total = 0;
      for (const n of imageSizes.values()) total += n;
      for (const k of imageCache.keys()) {
        if (total <= CACHE_BYTES || k === key) break;
        total -= imageSizes.get(k) ?? 0;
        imageCache.delete(k);
        imageSizes.delete(k);
      }
    },
    () => imageCache.delete(key),
  );
  return p;
}

function dropLocalImages(): void {
  for (const k of [...imageCache.keys()]) if (k.startsWith("L|")) {
    imageCache.delete(k);
    imageSizes.delete(k);
  }
}

function loadLocalImages(d: Doc, root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-md-local]")) {
    const src = img.dataset.mdLocal!;
    if (!d.path) {
      placeholder(img, t("markdown.imageNeedsSave"));
      continue;
    }
    const docPath = d.path;
    void cached(`L|${dirname(docPath)}|${src}`, () => api.mdLocalImage(docPath, src)).then(
      (url) => {
        if (img.isConnected) img.src = url;
      },
      () => placeholder(img, t("markdown.imageMissing", { src })),
    );
  }
}

/** Remote images download through the backend, four at a time. */
function loadRemoteImages(root: ParentNode): void {
  const imgs = [...root.querySelectorAll<HTMLImageElement>("img[data-md-remote]")];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < imgs.length) {
      const img = imgs[next++];
      if (!img.isConnected) continue;
      const url = img.dataset.mdRemote!;
      img.classList.add("md-img-loading");
      try {
        const data = await cached(`R|${url}`, () => api.mdRemoteImage(url));
        if (img.isConnected) {
          img.classList.remove("md-img-loading", "md-img-placeholder");
          img.src = data;
        }
      } catch (e) {
        img.classList.remove("md-img-loading");
        placeholder(img, t("markdown.imageFailed", { error: errorMessage(e) }));
      }
    }
  };
  for (let i = 0; i < 4; i++) void worker();
}

function allowRemoteImages(): void {
  const d = workspace.active;
  if (!d || !pane) return;
  stateOf(d).remoteAllowed = true;
  pane.bar.hidden = true;
  for (const img of pane.body.querySelectorAll<HTMLImageElement>("img[data-md-remote]")) img.classList.remove("md-img-placeholder");
  loadRemoteImages(pane.body);
}

// ---- links -------------------------------------------------------------------------------------------------

function onClick(e: MouseEvent): void {
  const a = (e.target as Element).closest?.("a");
  if (!a || !pane?.body.contains(a)) return;
  // Never let the webview navigate: every link is handled here or not at all.
  e.preventDefault();
  const d = workspace.active;
  const kind = a.dataset.mdLink;
  const target = a.dataset.mdHref ?? "";
  if (kind === "anchor") {
    const el = pane.body.querySelector(`#${CSS.escape(`user-content-${target}`)}`) ?? pane.body.querySelector(`[name="${CSS.escape(`user-content-${target}`)}"]`);
    if (el) el.scrollIntoView({ block: "start" });
  } else if (kind === "external") {
    api.openExternal(target).catch((err) => toast(errorMessage(err), "error"));
  } else if (kind === "markdown") {
    if (!d?.path) return void toast(t("markdown.linkNeedsSave"), "info");
    const rel = target.split("#")[0];
    const path = resolveRelative(d.path, rel);
    if (!path) return void toast(t("markdown.linkBlocked"), "info");
    void workspace.openPaths([path]);
  } else if (kind === "blocked") {
    toast(t("markdown.linkBlocked"), "info");
  }
}

// ---- scrolling together ------------------------------------------------------------------------------------

/** Source line (0-based) and position in the rendered view of each block, sorted, both increasing. */
let blocks: { line: number; top: number }[] | null = null;
let driver: "editor" | "preview" | null = null;
let driverUntil = 0;
let frame = 0;

function blockMap(): { line: number; top: number }[] {
  if (blocks) return blocks;
  const body = pane!.body;
  const base = body.getBoundingClientRect().top - body.scrollTop;
  const out: { line: number; top: number }[] = [{ line: 0, top: 0 }];
  for (const chunk of shown?.chunks ?? []) {
    const first = Number(chunk.el.dataset.base);
    for (const el of chunk.el.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = first + Number(el.dataset.line);
      if (!Number.isFinite(line)) continue;
      const top = el.getBoundingClientRect().top - base;
      const last = out[out.length - 1];
      if (line > last.line && top > last.top) out.push({ line, top });
    }
  }
  out.push({ line: workspace.view.state.doc.lines, top: Math.max(out[out.length - 1].top + 1, body.scrollHeight) });
  return (blocks = out);
}

/** The editor's top visible line, 0-based, with the fraction of it scrolled past. */
function editorTopLine(): number {
  const v = workspace.view;
  const top = v.scrollDOM.scrollTop;
  const block = v.lineBlockAtHeight(Math.max(0, top - v.documentPadding.top));
  const line = v.state.doc.lineAt(block.from).number - 1;
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (top - v.documentPadding.top - block.top) / block.height)) : 0;
  return line + frac;
}

function previewTopForLine(lineF: number): number {
  const map = blockMap();
  for (let i = map.length - 2; i >= 0; i--) {
    const a = map[i];
    if (lineF >= a.line) {
      const b = map[i + 1];
      return a.top + ((lineF - a.line) / Math.max(1, b.line - a.line)) * (b.top - a.top);
    }
  }
  return 0;
}

function lineForPreviewTop(top: number): number {
  const map = blockMap();
  for (let i = map.length - 2; i >= 0; i--) {
    const a = map[i];
    if (top >= a.top) {
      const b = map[i + 1];
      return a.line + Math.min(1, (top - a.top) / Math.max(1, b.top - a.top)) * (b.line - a.line);
    }
  }
  return 0;
}

function setPreviewScroll(top: number): void {
  if (!pane) return;
  driver = "editor";
  driverUntil = performance.now() + 120;
  pane.body.scrollTop = top;
}

function syncFromEditor(): void {
  if (!pane || shownView !== "split" || !shown) return;
  setPreviewScroll(previewTopForLine(editorTopLine()));
}

function onEditorScroll(): void {
  if (shownView !== "split" || !shown) return;
  if (driver === "preview" && performance.now() < driverUntil) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(syncFromEditor);
}

function onPreviewScroll(): void {
  if (shownView !== "split" || !shown || !pane) return;
  if (driver === "editor" && performance.now() < driverUntil) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (pane) scrollEditorToLine(lineForPreviewTop(pane.body.scrollTop));
  });
}

function scrollEditorToLine(lineF: number): void {
  const v = workspace.view;
  const n = Math.max(1, Math.min(v.state.doc.lines, Math.floor(lineF) + 1));
  const block = v.lineBlockAt(v.state.doc.line(n).from);
  driver = "preview";
  driverUntil = performance.now() + 120;
  v.scrollDOM.scrollTop = block.top + v.documentPadding.top + (lineF - Math.floor(lineF)) * block.height;
}

// ---- wiring ------------------------------------------------------------------------------------------------

workspace.focusTarget = () => (pane && shownView === "read" && !pane.root.hidden ? pane.body : null);

workspace.on((kind) => {
  if (kind === "active" || kind === "view" || kind === "tabs") {
    if (kind === "view") {
      // A view chosen by the user starts where the editor is, and re-reads local images (they may have changed).
      dropLocalImages();
      if (workspace.active) stateOf(workspace.active).scrollTop = null;
    }
    apply();
  } else if (kind === "doc") {
    // A language change can make a tab Markdown (or stop it being one).
    if (effectiveMdView(workspace.active) !== shownView) apply();
    else scheduleRender();
  }
});

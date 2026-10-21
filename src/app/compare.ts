import { getChunks, goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { editorExtensions } from "../editor/setup";
import { api, errorMessage, type Comparison, type DiffOptions, type Hunk } from "../lib/api";
import { debounce, h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { basename } from "../lib/logic";
import { quickPick } from "../ui/palette";
import { toast } from "../ui/toast";
import { workspace, type Doc } from "./workspace";
import "../styles/compare.css";

/** Above this many characters on either side the comparison runs in Rust and is shown as a hunk list. */
const LARGE_CHARS = 2_000_000;

interface Session {
  root: HTMLElement;
  destroy(): void;
  /** Applies pane edits to the tabs, then tears the view down. */
  close(): void;
  next?(): void;
  prev?(): void;
}
let current: Session | null = null;

export const isComparing = (): boolean => current !== null;
export function closeCompare(): void {
  current?.close();
}
export const nextDifference = (): void => current?.next?.();
export const previousDifference = (): void => current?.prev?.();

workspace.on((kind) => {
  if (kind === "active" && current) closeCompare();
});

function mount(titleText: string): { root: HTMLElement; bar: HTMLElement; body: HTMLElement; stats: HTMLElement } {
  const editorHost = document.getElementById("editor")!;
  const col = editorHost.parentElement!;
  const stats = h("span", { class: "compare-stats", "aria-live": "polite" });
  const bar = h("div", { class: "compare-bar" }, h("span", { class: "compare-title", title: titleText }, titleText), stats);
  const body = h("div", { class: "compare-body" });
  const root = h("section", { class: "compare", "aria-label": t("compare.title") }, bar, body);
  col.append(root);
  editorHost.style.visibility = "hidden";
  return { root, bar, body, stats };
}

function unmount(root: HTMLElement): void {
  root.remove();
  document.getElementById("editor")!.style.visibility = "";
  workspace.focus();
}

const button = (label: string, ic: string, onClick: () => void): HTMLButtonElement =>
  h("button", { class: "btn btn-sm", type: "button", onclick: onClick }, icon(ic), h("span", {}, label));

/** Compares two open tabs side by side. Edits in either pane go straight into the tab. */
export async function compareTabs(a: Doc, b: Doc, opts: { plain?: boolean } = {}): Promise<void> {
  closeCompare();
  if (!(await workspace.ensureLoaded(a)) || !(await workspace.ensureLoaded(b))) return;
  const ta = workspace.textOf(a);
  const tb = workspace.textOf(b);
  if (!opts.plain && (ta.length > LARGE_CHARS || tb.length > LARGE_CHARS)) return compareLarge(a.title, b.title, ta, tb, a, b);

  const [la, lb] = await Promise.all([workspace.languageExtensionFor(a), workspace.languageExtensionFor(b)]);
  const m = mount(`${a.title}  ↔  ${b.title}`);
  m.root.classList.toggle("plain", !!opts.plain);
  let direction: "a-to-b" | "b-to-a" = "a-to-b";

  const syncA = debounce(() => workspace.applyText(a, view.a.state.doc.toString()), 250);
  const syncB = debounce(() => workspace.applyText(b, view.b.state.doc.toString()), 250);
  const refreshStats = debounce(() => {
    const n = getChunks(view.b.state)?.chunks.length ?? 0;
    m.stats.textContent = n === 0 ? t("compare.identical") : t("compare.differences", { n });
  }, 120);
  const listen = (sync: () => void) =>
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        sync();
        refreshStats();
      }
    });

  const view = new MergeView({
    a: { doc: ta, extensions: [editorExtensions(workspace.viewOptions(a.indent), la), listen(syncA)] },
    b: { doc: tb, extensions: [editorExtensions(workspace.viewOptions(b.indent), lb), listen(syncB)] },
    parent: m.body,
    revertControls: opts.plain ? undefined : direction,
    highlightChanges: !opts.plain,
    gutter: !opts.plain,
    collapseUnchanged: opts.plain ? undefined : { margin: 3, minSize: 6 },
    diffConfig: { scanLimit: 500, timeout: 1500 },
  });

  const dirBtn = button(t("compare.moveRight"), "arrow-down", () => {
    direction = direction === "a-to-b" ? "b-to-a" : "a-to-b";
    view.reconfigure({ revertControls: direction });
    dirBtn.lastElementChild!.textContent = direction === "a-to-b" ? t("compare.moveRight") : t("compare.moveLeft");
  });
  const next = () => {
    goToNextChunk({ state: view.b.state, dispatch: (tr) => view.b.dispatch(tr) });
    view.b.focus();
  };
  const prev = () => {
    goToPreviousChunk({ state: view.b.state, dispatch: (tr) => view.b.dispatch(tr) });
    view.b.focus();
  };
  m.bar.append(
    ...(opts.plain ? [] : [button(t("compare.previous"), "arrow-up", prev), button(t("compare.next"), "arrow-down", next), dirBtn]),
    h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: closeCompare }, t(opts.plain ? "split.closeTabs" : "compare.close")),
  );
  if (opts.plain) m.stats.textContent = "";
  else refreshStats();

  const destroy = () => {
    syncA.flush();
    syncB.flush();
    view.destroy();
    unmount(m.root);
    current = null;
  };
  current = { root: m.root, destroy, close: destroy, next, prev };
}

// ---- large comparisons ---------------------------------------------------------------

interface HunkSource {
  title: string;
  comparison: Comparison;
  preview(side: "a" | "b", start: number, len: number): Promise<string[]>;
  jump?(side: "a" | "b", line: number): void | Promise<void>;
}

function showHunks(src: HunkSource): void {
  closeCompare();
  const m = mount(src.title);
  const c = src.comparison;
  m.stats.textContent = c.identical ? t("compare.identical") : t("compare.largeSummary", { hunks: c.hunks.length, added: c.addedLines, removed: c.removedLines }) + (c.timedOut ? ` ${t("compare.timedOut")}` : "");
  m.bar.append(h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: closeCompare }, t("compare.close")));

  const list = h("ul", { class: "hunk-list", role: "listbox", "aria-label": t("compare.hunks") });
  const titleA = h("div", { class: "hunk-side-title" });
  const titleB = h("div", { class: "hunk-side-title" });
  const sideA = h("pre", { class: "hunk-side" }, titleA);
  const sideB = h("pre", { class: "hunk-side" }, titleB);
  m.body.append(h("div", { class: "hunks" }, list, h("div", { class: "hunk-preview" }, sideA, sideB)));

  const KIND = { added: t("compare.added"), removed: t("compare.removed"), changed: t("compare.changed") };
  let selected: HTMLElement | null = null;
  const choose = async (hunk: Hunk, li: HTMLElement) => {
    selected?.removeAttribute("aria-current");
    li.setAttribute("aria-current", "true");
    selected = li;
    titleA.textContent = `${t("compare.sideA")} · ${t("compare.lines", { from: hunk.aStart + 1, to: hunk.aStart + hunk.aLen })}`;
    titleB.textContent = `${t("compare.sideB")} · ${t("compare.lines", { from: hunk.bStart + 1, to: hunk.bStart + hunk.bLen })}`;
    const [a, b] = await Promise.all([src.preview("a", hunk.aStart, Math.min(hunk.aLen, 200)), src.preview("b", hunk.bStart, Math.min(hunk.bLen, 200))]);
    sideA.replaceChildren(titleA, a.join("\n") || t("compare.nothing"));
    sideB.replaceChildren(titleB, b.join("\n") || t("compare.nothing"));
  };
  const MAX_ROWS = 3000;
  c.hunks.slice(0, MAX_ROWS).forEach((hk, i) => {
    const btn = h("button", { class: "hunk-item", type: "button", role: "option" },
      h("span", { class: `hunk-kind ${hk.kind}` }, KIND[hk.kind]), " ", h("span", { class: "muted" }, `A ${hk.aStart + 1} · B ${hk.bStart + 1}`));
    const li = h("li", {}, btn);
    btn.addEventListener("click", () => void choose(hk, btn));
    btn.addEventListener("dblclick", () => void src.jump?.(hk.kind === "added" ? "b" : "a", (hk.kind === "added" ? hk.bStart : hk.aStart) + 1));
    list.append(li);
    if (i === 0) void choose(hk, btn);
  });
  if (c.hunks.length > MAX_ROWS) list.append(h("li", { class: "muted", style: "padding:8px 10px" }, t("compare.moreHidden", { n: c.hunks.length - MAX_ROWS })));
  current = { root: m.root, destroy: () => unmount(m.root), close: () => { unmount(m.root); current = null; } };
}

async function compareLarge(titleA: string, titleB: string, ta: string, tb: string, a?: Doc, b?: Doc): Promise<void> {
  toast(t("compare.largeStart"), "info");
  try {
    const options: DiffOptions = { whitespace: "exact", ignoreCase: false, timeoutMs: 20000 };
    const comparison = await api.compareText(ta, tb, options);
    const la = ta.split("\n");
    const lb = tb.split("\n");
    showHunks({
      title: `${titleA}  ↔  ${titleB}  (${t("compare.largeMode")})`,
      comparison,
      preview: async (side, start, len) => (side === "a" ? la : lb).slice(start, start + len),
      jump: async (side, line) => {
        const d = side === "a" ? a : b;
        closeCompare();
        if (d) {
          await workspace.activate(d.id);
          workspace.goTo(line, 0);
        }
      },
    });
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

/** Compares the active tab with another open tab chosen from a list. */
export async function compareWithTab(): Promise<void> {
  const a = workspace.active;
  if (!a) return;
  const others = workspace.docs.filter((d) => d !== a);
  if (!others.length) return void toast(t("compare.needTwo"), "info");
  const id = await quickPick(others.map((d) => ({ label: d.title, detail: d.path ?? "", value: d.id })), t("compare.pickTab"));
  const b = others.find((d) => d.id === id);
  if (b) await compareTabs(a, b);
}

/** Shows the active tab next to another open tab (no diff markers); edits go straight into the tabs. */
export async function showTabsSideBySide(): Promise<void> {
  const a = workspace.active;
  if (!a) return;
  const others = workspace.docs.filter((d) => d !== a);
  if (!others.length) return void toast(t("compare.needTwo"), "info");
  const id = await quickPick(others.map((d) => ({ label: d.title, detail: d.path ?? "", value: d.id })), t("split.pickTab"));
  const b = others.find((d) => d.id === id);
  if (b) await compareTabs(a, b, { plain: true });
}

/** Compares the active tab with a file chosen on disk (it is opened as a tab). */
export async function compareWithFile(): Promise<void> {
  const a = workspace.active;
  if (!a) return;
  const sel = await openDialog({ multiple: false, directory: false, title: t("compare.pickFile") });
  if (typeof sel !== "string") return;
  await workspace.openPaths([sel]);
  const b = workspace.docs.find((d) => d.path === sel);
  const aStill = workspace.docs.find((d) => d.id === a.id);
  if (b && aStill && b !== aStill) await compareTabs(aStill, b);
}

/** Compares two files on disk without opening them (for very large files); the work happens in Rust. */
export async function compareTwoFiles(): Promise<void> {
  const pick = async (title: string) => {
    const s = await openDialog({ multiple: false, directory: false, title });
    return typeof s === "string" ? s : null;
  };
  const pa = await pick(t("compare.pickFirst"));
  if (!pa) return;
  const pb = await pick(t("compare.pickSecond"));
  if (!pb) return;
  toast(t("compare.largeStart"), "info");
  try {
    const r = await api.compareFiles(pa, pb, { whitespace: "exact", ignoreCase: false, timeoutMs: 60000 });
    showHunks({
      title: `${basename(pa)}  ↔  ${basename(pb)}  (${t("compare.largeMode")})`,
      comparison: r.comparison,
      preview: (side, start, len) => api.compareLines(r.id, side, start, len),
      jump: async (side, line) => {
        closeCompare();
        await workspace.openPaths([side === "a" ? pa : pb], { line, column: 0 });
      },
    });
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

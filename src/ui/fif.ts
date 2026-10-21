import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { workspace } from "../app/workspace";
import { api, errorMessage, type SearchOptions, type SearchReport } from "../lib/api";
import { debounce, h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { basename, dirname } from "../lib/logic";
import { confirmSheet } from "./dialog";
import { toast } from "./toast";

const MAX_ROWS = 1500;

let built = false;
let root = "";
let seq = 0;
let report: SearchReport | null = null;
let replaceMode = false;
const flags = { caseSensitive: false, wholeWord: false, regex: false, gitignore: true };
const unchecked = new Set<string>();

let queryIn: HTMLInputElement, replaceIn: HTMLInputElement, includeIn: HTMLInputElement, excludeIn: HTMLInputElement;
let rootBtn: HTMLButtonElement, summary: HTMLElement, results: HTMLElement, replaceRow: HTMLElement, replaceBtn: HTMLButtonElement;
let panel: HTMLElement;

function options(): SearchOptions {
  return {
    root,
    query: queryIn.value,
    regex: flags.regex,
    caseSensitive: flags.caseSensitive,
    wholeWord: flags.wholeWord,
    include: includeIn.value,
    exclude: excludeIn.value,
    respectGitignore: flags.gitignore,
    includeHidden: false,
  };
}

const run = debounce(async () => {
  const q = queryIn.value;
  if (!q || !root) {
    report = null;
    results.replaceChildren();
    summary.textContent = root ? "" : t("fif.chooseFolder");
    replaceBtn.disabled = true;
    return;
  }
  const mine = ++seq;
  summary.textContent = t("fif.searching");
  try {
    const r = await api.searchFolder(options(), replaceMode ? replaceIn.value : null);
    if (mine !== seq) return;
    report = r;
    unchecked.clear();
    renderResults();
  } catch (e) {
    if (mine !== seq) return;
    report = null;
    results.replaceChildren();
    summary.textContent = errorMessage(e);
    replaceBtn.disabled = true;
  }
}, 300);

function renderResults(): void {
  const r = report;
  results.replaceChildren();
  if (!r) return;
  const extra = r.filesSkippedBinary ? t("fif.skippedBinary", { n: r.filesSkippedBinary }) : "";
  summary.textContent = (r.totalMatches === 0 ? t("fif.noMatches") : t("fif.summary", { matches: r.totalMatches, files: r.files.length })) + (r.truncated ? ` ${t("fif.truncated")}` : "") + extra;
  let rows = 0;
  for (const f of r.files) {
    const li = h("li", {});
    const head = h("div", { class: "fif-file" });
    if (replaceMode) {
      const cb = h("input", { class: "fif-check", type: "checkbox", checked: !unchecked.has(f.path), "aria-label": t("fif.includeFile", { name: basename(f.path) }) });
      cb.addEventListener("change", () => {
        if (cb.checked) unchecked.delete(f.path);
        else unchecked.add(f.path);
        updateReplaceButton();
      });
      head.append(cb);
    }
    const rel = root && f.path.startsWith(root) ? f.path.slice(root.length).replace(/^[\\/]/, "") : f.path;
    head.append(icon("file", "icon-sm"), h("span", {}, basename(rel), " ", h("span", { class: "dir" }, dirname(rel))), h("span", { class: "count" }, String(f.matches.length)));
    li.append(head);
    for (const m of f.matches) {
      if (rows++ >= MAX_ROWS) break;
      const text = h("span", {}, m.preview.slice(0, m.previewOffset), h("mark", {}, m.preview.slice(m.previewOffset, m.previewOffset + m.length)), m.preview.slice(m.previewOffset + m.length));
      const btn = h("button", { class: "fif-match", type: "button", title: `${f.path}:${m.line}` }, h("span", { class: "ln" }, String(m.line)), text);
      btn.addEventListener("click", async () => {
        await workspace.openPaths([f.path]);
        workspace.selectRange(m.line, m.column, m.length);
      });
      li.append(btn);
      if (replaceMode && m.replaced !== null) {
        li.append(h("div", { class: "fif-match" }, h("span", { class: "ln" }, "→"), h("ins", {}, m.replaced)));
      }
    }
    results.append(li);
    if (rows >= MAX_ROWS) {
      results.append(h("li", { class: "fif-summary", style: "padding:8px 12px" }, t("fif.moreHidden")));
      break;
    }
  }
  updateReplaceButton();
}

function selectedFiles(): string[] {
  return (report?.files ?? []).map((f) => f.path).filter((p) => !unchecked.has(p));
}

function updateReplaceButton(): void {
  const n = selectedFiles().length;
  replaceBtn.disabled = n === 0 || !replaceMode;
  replaceBtn.textContent = t("fif.replaceIn", { n });
}

async function doReplace(): Promise<void> {
  const files = selectedFiles();
  if (!report || !files.length) return;
  const matches = report.files.filter((f) => files.includes(f.path)).reduce((n, f) => n + f.matches.length, 0);
  const ok = await confirmSheet(t("fif.confirmTitle"), t("fif.confirmMessage", { matches, files: files.length }), t("fif.confirmOk"), true);
  if (!ok) return;
  try {
    const r = await api.replaceInFolder(options(), replaceIn.value, files);
    toast(t("fif.replaced", { n: r.replacements, files: r.filesChanged }), r.errors.length ? "warning" : "success");
    for (const e of r.errors) toast(e, "error");
    await workspace.checkExternal();
    run();
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

function toggleBtn(labelKey: string, ic: string, key: keyof typeof flags): HTMLButtonElement {
  const b = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: t(labelKey), "aria-label": t(labelKey), "aria-pressed": String(flags[key]) }, icon(ic));
  b.addEventListener("click", () => {
    flags[key] = !flags[key];
    b.setAttribute("aria-pressed", String(flags[key]));
    run();
  });
  return b;
}

function build(): void {
  panel = document.getElementById("fif")!;
  queryIn = h("input", { class: "input", type: "text", placeholder: t("fif.find"), "aria-label": t("fif.find"), spellcheck: false });
  replaceIn = h("input", { class: "input", type: "text", placeholder: t("fif.replaceWith"), "aria-label": t("fif.replaceWith"), spellcheck: false });
  includeIn = h("input", { class: "input mono", type: "text", placeholder: t("fif.include"), "aria-label": t("fif.include"), spellcheck: false });
  excludeIn = h("input", { class: "input mono", type: "text", placeholder: t("fif.exclude"), "aria-label": t("fif.exclude"), spellcheck: false });
  rootBtn = h("button", { class: "btn btn-sm", type: "button", title: t("fif.chooseFolder") }, icon("folder"), h("span", {}, ""));
  summary = h("div", { class: "fif-summary", "aria-live": "polite" });
  results = h("ul", { class: "fif-results" });
  replaceBtn = h("button", { class: "btn btn-sm btn-danger", type: "button", disabled: true }, t("fif.replaceIn", { n: 0 }));
  const modeBtn = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: t("find.toggleReplace"), "aria-label": t("find.toggleReplace"), "aria-pressed": "false" }, icon("replace"));
  const close = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("common.close") }, icon("x"));
  replaceRow = h("div", { class: "find-row" }, replaceIn, replaceBtn);
  replaceRow.hidden = true;

  const form = h("div", { class: "fif-form" },
    h("div", { class: "find-row" }, modeBtn, queryIn, toggleBtn("find.matchCase", "case", "caseSensitive"), toggleBtn("find.wholeWord", "word", "wholeWord"), toggleBtn("find.regex", "regex", "regex"), toggleBtn("fif.useGitignore", "eye", "gitignore"), close),
    replaceRow,
    h("div", { class: "find-row" }, rootBtn, includeIn, excludeIn),
    summary,
  );
  panel.append(form, results);

  modeBtn.addEventListener("click", () => {
    replaceMode = !replaceMode;
    modeBtn.setAttribute("aria-pressed", String(replaceMode));
    replaceRow.hidden = !replaceMode;
    if (replaceMode) replaceIn.focus();
    run();
  });
  close.addEventListener("click", closeFindInFiles);
  rootBtn.addEventListener("click", () => void chooseRoot());
  replaceBtn.addEventListener("click", () => void doReplace());
  for (const el of [queryIn, includeIn, excludeIn]) el.addEventListener("input", run);
  replaceIn.addEventListener("input", () => replaceMode && run());
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFindInFiles();
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target !== replaceIn) {
      run.cancel();
      run();
      run.flush();
    }
  });
  built = true;
}

function setRoot(path: string): void {
  root = path;
  rootBtn.lastElementChild!.textContent = path ? basename(path) : t("fif.chooseFolder");
  rootBtn.title = path || t("fif.chooseFolder");
}

async function chooseRoot(): Promise<void> {
  const sel = await openDialog({ directory: true, multiple: false, defaultPath: root || undefined, title: t("fif.chooseFolder") });
  if (typeof sel === "string") {
    setRoot(sel);
    run();
  }
}

export function openFindInFiles(withReplace = false): void {
  if (!built) build();
  panel.hidden = false;
  if (!root) {
    const p = workspace.active?.path;
    setRoot(p ? dirname(p) : "");
  }
  if (withReplace && !replaceMode) (panel.querySelector('[aria-label="' + t("find.toggleReplace") + '"]') as HTMLElement | null)?.click();
  const sel = workspace.view.state.sliceDoc(workspace.view.state.selection.main.from, workspace.view.state.selection.main.to);
  if (sel && !sel.includes("\n")) queryIn.value = sel;
  if (!root) void chooseRoot();
  queryIn.focus();
  queryIn.select();
  if (queryIn.value) run();
}

export function closeFindInFiles(): void {
  if (!built) return;
  panel.hidden = true;
  workspace.focus();
}

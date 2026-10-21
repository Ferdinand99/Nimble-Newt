import { copyLineDown, deleteLine, moveLineDown, moveLineUp, redo, selectAll, toggleBlockComment, toggleComment, undo } from "@codemirror/commands";
import { findNext, findPrevious, openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { addCursorAbove, addCursorBelow } from "../editor/commands";
import { requestReplaceRow } from "../editor/findpanel";
import { ENCODINGS, EOLS } from "../lib/api";
import { isMac } from "../lib/dom";
import { t } from "../lib/i18n";
import { dirname, formatShortcut } from "../lib/logic";
import { FONT_MAX, FONT_MIN, settings } from "../lib/settings";
import { promptNumber } from "../ui/dialog";
import { openFindInFiles } from "../ui/fif";
import { showMenu } from "../ui/menu";
import { quickPick } from "../ui/palette";
import { openSettings } from "../ui/settings";
import { toast } from "../ui/toast";
import { accelFor, COMMAND_DEFS } from "./commandDefs";
import { checkForUpdates } from "./updater";
import { workspace } from "./workspace";
import { LANGUAGES } from "../lib/languages";

const view = (): EditorView => workspace.view;
const cm = (cmd: (v: EditorView) => boolean) => () => {
  cmd(view());
  workspace.focus();
};

function transformSelection(fn: (s: string) => string): void {
  const v = view();
  v.dispatch(v.state.changeByRange((r) => {
    if (r.empty) return { range: r };
    const text = fn(v.state.sliceDoc(r.from, r.to));
    return { changes: { from: r.from, to: r.to, insert: text }, range: { from: r.from, to: r.from + text.length } as never };
  }));
}

function sortLines(): void {
  const v = view();
  const st = v.state;
  const m = st.selection.main;
  const from = st.doc.lineAt(m.empty ? 0 : m.from).from;
  const to = st.doc.lineAt(m.empty ? st.doc.length : m.to).to;
  const lines = st.sliceDoc(from, to).split("\n");
  lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  v.dispatch({ changes: { from, to, insert: lines.join("\n") } });
}

function trimTrailing(): void {
  const v = view();
  const changes: { from: number; to: number }[] = [];
  for (let i = 1; i <= v.state.doc.lines; i++) {
    const l = v.state.doc.line(i);
    const trimmed = l.text.replace(/[ \t]+$/, "");
    if (trimmed.length !== l.text.length) changes.push({ from: l.from + trimmed.length, to: l.to });
  }
  if (changes.length) v.dispatch({ changes });
  toast(t("toast.trimmed", { n: changes.length }), "info");
}

function zoom(delta: number | null): void {
  settings.set({ fontSize: delta === null ? 14 : Math.max(FONT_MIN, Math.min(FONT_MAX, settings.value.fontSize + delta)) });
}

async function quickOpen(): Promise<void> {
  const paths = [...new Set([...workspace.docs.map((d) => d.path).filter((p): p is string => !!p), ...workspace.recent])];
  if (!paths.length) {
    toast(t("palette.noRecent"), "info");
    return;
  }
  const p = await quickPick(paths.map((p) => ({ label: p.split(/[\\/]/).pop() ?? p, detail: dirname(p), value: p })), t("palette.quickOpen"));
  if (p) await workspace.openPaths([p]);
}

async function gotoLine(): Promise<void> {
  const n = await promptNumber(t("cmd.edit.gotoLine"), t("status.lineRange", { max: view().state.doc.lines }), 1, view().state.doc.lines);
  if (n !== null) workspace.goTo(n, 0);
}

async function pick<T extends string>(title: string, values: readonly T[], label: (v: T) => string, apply: (v: T) => void): Promise<void> {
  const v = await quickPick(values.map((x) => ({ label: label(x), value: x })), title);
  if (v) apply(v);
}

const active = () => workspace.active;

const handlers: Record<string, () => void | Promise<void>> = {
  "file.new": () => void workspace.newDoc(),
  "file.open": () => workspace.openDialog(),
  "file.quickOpen": quickOpen,
  "file.save": () => void (active() && workspace.save(active()!)),
  "file.saveAs": () => void (active() && workspace.saveAs(active()!)),
  "file.saveAll": () => void workspace.saveAll(),
  "file.close": () => void (active() && workspace.close(active()!.id)),
  "file.closeOthers": () => void (active() && workspace.closeOthers(active()!.id)),
  "file.reopenClosed": () => workspace.reopenClosed(),
  "edit.undo": cm(undo),
  "edit.redo": cm(redo),
  "edit.selectAll": cm(selectAll),
  "edit.find": () => { requestReplaceRow(false); openSearchPanel(view()); },
  "edit.replace": () => { requestReplaceRow(true); openSearchPanel(view()); },
  "edit.findNext": cm(findNext),
  "edit.findPrev": cm(findPrevious),
  "edit.findInFiles": () => openFindInFiles(),
  "edit.gotoLine": gotoLine,
  "edit.duplicateLine": cm(copyLineDown),
  "edit.deleteLine": cm(deleteLine),
  "edit.moveLineUp": cm(moveLineUp),
  "edit.moveLineDown": cm(moveLineDown),
  "edit.toggleComment": cm(toggleComment),
  "edit.toggleBlockComment": cm(toggleBlockComment),
  "edit.selectNext": cm(selectNextOccurrence),
  "edit.addCursorAbove": cm(addCursorAbove),
  "edit.addCursorBelow": cm(addCursorBelow),
  "edit.upperCase": () => transformSelection((s) => s.toUpperCase()),
  "edit.lowerCase": () => transformSelection((s) => s.toLowerCase()),
  "edit.trimTrailing": trimTrailing,
  "edit.sortLines": sortLines,
  "view.palette": () => openPalette(),
  "view.wrap": () => settings.set({ wordWrap: !settings.value.wordWrap }),
  "view.whitespace": () => settings.set({ showWhitespace: !settings.value.showWhitespace }),
  "view.zoomIn": () => zoom(1),
  "view.zoomOut": () => zoom(-1),
  "view.zoomReset": () => zoom(null),
  "view.nextTab": () => workspace.nextTab(1),
  "view.prevTab": () => workspace.nextTab(-1),
  "view.themeSystem": () => settings.set({ theme: "system" }),
  "view.themeLight": () => settings.set({ theme: "light" }),
  "view.themeDark": () => settings.set({ theme: "dark" }),
  "doc.language": () => pick(t("status.selectLanguage"), LANGUAGES.map((l) => l.id), (id) => LANGUAGES.find((l) => l.id === id)!.name, (id) => void (active() && workspace.setLanguage(active()!, id))),
  "doc.encoding": () => pick(t("cmd.doc.encoding"), ENCODINGS, (e) => e, (e) => active() && workspace.setEncoding(active()!, e)),
  "doc.eol": () => pick(t("cmd.doc.eol"), EOLS, (e) => t(`eol.${e}`), (e) => active() && workspace.setEol(active()!, e)),
  "doc.indent": () => {
    const d = active();
    if (!d) return;
    showMenu([2, 4, 8].flatMap((n) => [
      { label: t("status.spaces", { n }), run: () => workspace.setIndent(d, { useTabs: false, size: n }) },
      { label: t("status.tabs", { n }), run: () => workspace.setIndent(d, { useTabs: true, size: n }) },
    ]), { x: window.innerWidth / 2 - 90, y: window.innerHeight / 3 });
  },
  "app.settings": openSettings,
  "app.checkUpdates": () => checkForUpdates(true),
  "app.about": () => void toast("Nimble Newt — MIT License — github.com/Ferdinand99/Nimble-Newt", "info", 6000),
};

let lastRun = { id: "", at: 0 };

/**
 * Runs a command by id. The native menu and the webview can both deliver the same shortcut;
 * an identical id arriving within 80 ms is the same keypress and is ignored.
 */
export function runCommand(id: string): void {
  const now = performance.now();
  if (lastRun.id === id && now - lastRun.at < 80) return;
  lastRun = { id, at: now };
  const h = handlers[id];
  if (!h) return;
  void Promise.resolve(h()).catch((e) => toast(String(e), "error"));
}

export async function openPalette(): Promise<void> {
  const items = COMMAND_DEFS.filter((c) => c.id !== "view.palette").map((c) => {
    const accel = accelFor(c, isMac);
    return { label: t(`cmd.${c.id}`), shortcut: accel ? formatShortcut(accel, isMac) : undefined, value: c.id };
  });
  const id = await quickPick(items, t("palette.placeholder"));
  if (id) {
    // Let the palette close and return focus first so commands act on the editor.
    await new Promise((r) => setTimeout(r, 0));
    runCommand(id);
  }
}

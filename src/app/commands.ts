import { copyLineDown, deleteLine, moveLineDown, moveLineUp, redo, selectAll, toggleBlockComment, toggleComment, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { findNext, findPrevious, getSearchQuery, openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { addBookmarkLines, bookmarkedLines, bookmarkedText, clearBookmarks, invertBookmarks, jumpBookmark, removeLines, toggleBookmarkAt } from "../editor/bookmarks";
import { addCursorAbove, addCursorBelow } from "../editor/commands";
import { clearHighlights, textToHighlight, toggleHighlight } from "../editor/highlights";
import { recorder } from "../editor/macroRecorder";
import { requestReplaceRow } from "../editor/findpanel";
import { EOLS } from "../lib/api";
import { pickEncoding } from "../ui/encodingPick";
import { isMac } from "../lib/dom";
import { t } from "../lib/i18n";
import { dirname, formatShortcut } from "../lib/logic";
import { FONT_MAX, FONT_MIN, settings } from "../lib/settings";
import { askColumnEdit } from "../ui/columnEdit";
import { lineOpHandlers } from "./lineOpsCommands";
import { togglePanel } from "./panels";
import { promptNumber } from "../ui/dialog";
import { openFindInFiles } from "../ui/fif";
import { showMenu } from "../ui/menu";
import { quickPick } from "../ui/palette";
import { openSettings } from "../ui/settings";
import { toast } from "../ui/toast";
import { accelFor, COMMAND_DEFS, MACRO_COMMANDS } from "./commandDefs";
import * as macros from "./macros";
import { checkForUpdates } from "./updater";
import { workspace } from "./workspace";
import { LANGUAGES } from "../lib/languages";

const view = (): EditorView => workspace.view;
const cm = (cmd: (v: EditorView) => boolean) => () => {
  cmd(view());
  workspace.focus();
};

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

/** Column edit: inserts text or a number sequence at every cursor / column-selection line. */
async function columnEdit(): Promise<void> {
  const v = view();
  const ranges = v.state.selection.ranges;
  const values = await askColumnEdit(ranges.length);
  if (!values) return;
  v.dispatch(
    v.state.changeByRange((r) => {
      const insert = values[ranges.indexOf(r)] ?? "";
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
    }),
    { userEvent: "input" },
  );
  workspace.focus();
}

async function copyBookmarked(cut: boolean): Promise<void> {
  const v = view();
  const lines = bookmarkedLines(v.state);
  if (!lines.length) return void toast(t("bookmark.none"), "info");
  await navigator.clipboard.writeText(bookmarkedText(v.state));
  if (cut) removeLines(v, true);
  toast(t(cut ? "bookmark.removed" : "bookmark.copied", { n: lines.length }), "success");
}

function bookmarkRemove(removeMarked: boolean): void {
  const v = view();
  if (!bookmarkedLines(v.state).length) return void toast(t("bookmark.none"), "info");
  toast(t("bookmark.removed", { n: removeLines(v, removeMarked) }), "info");
}

function bookmarkFromSearch(): void {
  const v = view();
  const q = getSearchQuery(v.state);
  if (!q.search || !q.valid) return void toast(t("bookmark.noQuery"), "info");
  const lines = new Set<number>();
  const cursor = q.getCursor(v.state);
  for (let r = cursor.next(); !r.done && lines.size < 50000; r = cursor.next()) lines.add(v.state.doc.lineAt(r.value.from).number);
  addBookmarkLines(v, [...lines]);
  toast(t("bookmark.added", { n: lines.size }), "success");
}

const highlight = (color: number) => () => {
  const text = textToHighlight(view());
  if (!toggleHighlight(view(), text, color)) toast(t("highlight.nothing"), "info");
};

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
  "edit.columnEdit": columnEdit,
  "edit.trimTrailing": trimTrailing,
  ...lineOpHandlers,
  "view.palette": () => openPalette(),
  "view.wrap": () => settings.set({ wordWrap: !settings.value.wordWrap }),
  "view.completion": () => settings.set({ wordCompletion: !settings.value.wordCompletion }),
  "view.whitespace": () => settings.set({ showWhitespace: !settings.value.showWhitespace }),
  "view.zoomIn": () => zoom(1),
  "view.zoomOut": () => zoom(-1),
  "view.zoomReset": () => zoom(null),
  "view.outline": () => togglePanel("outline"),
  "view.nextTab": () => workspace.nextTab(1),
  "view.prevTab": () => workspace.nextTab(-1),
  "view.themeSystem": () => settings.set({ theme: "system" }),
  "view.themeLight": () => settings.set({ theme: "light" }),
  "view.themeDark": () => settings.set({ theme: "dark" }),
  "doc.follow": () => void (active() && workspace.toggleFollow(active()!)),
  "doc.language": () => pick(t("status.selectLanguage"), LANGUAGES.map((l) => l.id), (id) => LANGUAGES.find((l) => l.id === id)!.name, (id) => void (active() && workspace.setLanguage(active()!, id))),
  "doc.encoding": async () => {
    const d = active();
    const e = d && (await pickEncoding(t("cmd.doc.encoding"), d.encoding));
    if (d && e) workspace.setEncoding(d, e);
  },
  "doc.reopenEncoding": async () => {
    const d = active();
    const e = d?.path && (await pickEncoding(t("cmd.doc.reopenEncoding"), d.encoding));
    if (d && e) await workspace.reopenWithEncoding(d, e);
  },
  "doc.eol": () => pick(t("cmd.doc.eol"), EOLS, (e) => t(`eol.${e}`), (e) => active() && workspace.setEol(active()!, e)),
  "doc.indent": () => {
    const d = active();
    if (!d) return;
    showMenu([2, 4, 8].flatMap((n) => [
      { label: t("status.spaces", { n }), run: () => workspace.setIndent(d, { useTabs: false, size: n }) },
      { label: t("status.tabs", { n }), run: () => workspace.setIndent(d, { useTabs: true, size: n }) },
    ]), { x: window.innerWidth / 2 - 90, y: window.innerHeight / 3 });
  },
  "macro.record": () => macros.toggleRecording(),
  "macro.play": macros.playLast,
  "macro.playMany": macros.playMany,
  "macro.playToEnd": macros.playToEnd,
  "macro.save": macros.saveLast,
  "macro.runSaved": macros.runSaved,
  "macro.deleteSaved": macros.deleteSaved,
  "bookmark.toggle": () => toggleBookmarkAt(view()),
  "bookmark.next": () => void (jumpBookmark(view(), 1) || toast(t("bookmark.none"), "info")),
  "bookmark.prev": () => void (jumpBookmark(view(), -1) || toast(t("bookmark.none"), "info")),
  "bookmark.clear": () => clearBookmarks(view()),
  "bookmark.invert": () => invertBookmarks(view()),
  "bookmark.copy": () => copyBookmarked(false),
  "bookmark.cut": () => copyBookmarked(true),
  "bookmark.delete": () => bookmarkRemove(true),
  "bookmark.deleteUnmarked": () => bookmarkRemove(false),
  "bookmark.fromSearch": bookmarkFromSearch,
  "highlight.1": highlight(1),
  "highlight.2": highlight(2),
  "highlight.3": highlight(3),
  "highlight.4": highlight(4),
  "highlight.5": highlight(5),
  "highlight.clear": () => clearHighlights(view()),
  "compare.withTab": async () => (await import("./compare")).compareWithTab(),
  "compare.withFile": async () => (await import("./compare")).compareWithFile(),
  "compare.files": async () => (await import("./compare")).compareTwoFiles(),
  "compare.close": async () => (await import("./compare")).closeCompare(),
  "compare.next": async () => (await import("./compare")).nextDifference(),
  "compare.prev": async () => (await import("./compare")).previousDifference(),
  ...Object.fromEntries(COMMAND_DEFS.filter((c) => c.id.startsWith("tools.") && c.id !== "tools.panel").map((c) => c.id).map((id) => [id, () => import("./toolsCommands").then((m) => m.runTool(id))])),
  "tools.panel": () => togglePanel("tools"),
  "lang.userLanguages": async () => (await import("../ui/userLanguages")).openLanguagesSheet(),
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
  if (recorder.recording && !recorder.playing && MACRO_COMMANDS.has(id)) recorder.push({ t: "cmd", c: id });
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

/** Runs a command for macro playback: no de-duplication and no recording. */
macros.initMacros((id) => {
  const h = handlers[id];
  if (!h) return false;
  void Promise.resolve(h()).catch(() => {});
  return true;
});

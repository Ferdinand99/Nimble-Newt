import { EditorSelection, EditorState, Text, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { bookmarkedLines, setBookmarkEffect } from "../editor/bookmarks";
import { compartments, languageExtension, makeState, onEditorUpdate, reconfigureEffects, setMinimapExtension, type ViewOptions } from "../editor/setup";
import { api, errorMessage, type Encoding, type Eol, type LargeOpened, type OpenedFile, type RestoredTab } from "../lib/api";
import { debounce, h } from "../lib/dom";
import { t } from "../lib/i18n";
import { guessLanguage } from "../lib/guess";
import { detectFromShebang, detectLanguage, getLanguage, type LanguageDef } from "../lib/languages";
import { basename, detectIndent, nextUntitledName, pushRecent, type Indent } from "../lib/logic";
import { expectedMtime, isConflict } from "../lib/saveConflict";
import { settings } from "../lib/settings";
import { confirmSheet, openSheet } from "../ui/dialog";
import type { LargeViewer } from "../ui/largeView";
import { toast } from "../ui/toast";

export interface Doc {
  id: string;
  path: string | null;
  title: string;
  encoding: Encoding;
  eol: Eol;
  langId: string;
  langManual: boolean;
  indent: Indent;
  /** `null` until a lazily restored clean tab is first shown. */
  state: EditorState | null;
  /** Content equal to what is on disk; `null` for tabs that were never saved. */
  savedDoc: Text | null;
  savedMtime: number | null;
  /** Set when only metadata (encoding, line ending, external edit) makes the tab differ from disk. */
  forceDirty: boolean;
  missing: boolean;
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
  optionsVersion: number;
  /** The document last written to the session store as an unsaved buffer. */
  written: Text | null;
  /** Bookmarked lines, kept here while the tab's editor state is not loaded. */
  bookmarks: number[];
  /** Reload automatically when the file grows or changes on disk, and stay at the end (like `tail -f`). */
  follow: boolean;
  /** Set for files opened in the read-only large-file viewer instead of the editor. */
  large: { opened: LargeOpened; viewer: LargeViewer | null } | null;
}

export type ChangeKind = "tabs" | "active" | "doc" | "selection" | "settings";
type Listener = (kind: ChangeKind) => void;

const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "");
export const toText = (s: string): Text => Text.of(s.split(/\r\n?|\n/));

const langCache = new Map<string, Promise<Extension>>();
function loadLanguage(def: LanguageDef): Promise<Extension> {
  let p = langCache.get(def.id);
  if (!p) {
    p = def.load().then((ext) => languageExtension(def, ext));
    langCache.set(def.id, p);
  }
  return p;
}

export class Workspace {
  docs: Doc[] = [];
  activeId: string | null = null;
  view!: EditorView;
  recent: string[] = [];
  private closed: { path: string }[] = [];
  private listeners = new Set<Listener>();
  private optionsVersion = 1;
  private checking = false;
  private followTimer: number | undefined;
  private following = false;
  private lastSelectionPersist = 0;

  readonly persist = debounce(() => void this.persistNow(), 500);
  /** Re-guesses the language of an untitled tab shortly after typing or pasting stops. */
  private readonly guess = debounce(() => void this.autoDetect(), 400);

  on(fn: Listener): void {
    this.listeners.add(fn);
  }
  emit(kind: ChangeKind): void {
    for (const l of this.listeners) l(kind);
  }

  get active(): Doc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  viewOptions(indent?: Indent): ViewOptions {
    const s = settings.value;
    return {
      wrap: s.wordWrap,
      whitespace: s.showWhitespace,
      completion: s.wordCompletion,
      minimap: s.minimap,
      indent: indent ?? { useTabs: !s.insertSpaces, size: s.tabSize },
    };
  }

  mount(parent: HTMLElement): void {
    this.view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
    onEditorUpdate((u) => this.onUpdate(u));
    this.view.scrollDOM.addEventListener("scroll", () => this.persist(), { passive: true });
    settings.onChange((_s, changed) => {
      if (changed.includes("minimap") && settings.value.minimap) {
        void this.ensureMinimap();
        return;
      }
      if (changed.some((k) => k === "wordWrap" || k === "showWhitespace" || k === "wordCompletion" || k === "minimap" || k === "tabSize" || k === "insertSpaces")) {
        this.optionsVersion++;
        this.applyOptions(this.active);
        this.emit("settings");
      }
    });
  }

  /** Loads the minimap code on first use and switches it on for the open tabs. */
  async ensureMinimap(): Promise<void> {
    const m = await import("../editor/minimap");
    setMinimapExtension(m.minimap());
    this.optionsVersion++;
    this.applyOptions(this.active);
    this.emit("settings");
  }

  // ---- state helpers ------------------------------------------------------

  /** Current editor state of a doc (the live one for the active tab). */
  stateOf(doc: Doc): EditorState | null {
    if (doc.large) return null;
    return doc.id === this.activeId ? this.view.state : doc.state;
  }

  textOf(doc: Doc): string {
    return this.stateOf(doc)?.doc.toString() ?? "";
  }

  isDirty(doc: Doc): boolean {
    if (doc.large) return false;
    if (doc.forceDirty) return true;
    const st = this.stateOf(doc);
    if (!st) return false;
    if (!doc.savedDoc) return st.doc.length > 0;
    return !st.doc.eq(doc.savedDoc);
  }

  private updateState(doc: Doc, spec: TransactionSpec): void {
    if (doc.id === this.activeId) this.view.dispatch(spec);
    else if (doc.state) doc.state = doc.state.update(spec).state;
  }

  private applyOptions(doc: Doc | null): void {
    if (!doc) return;
    this.updateState(doc, { effects: reconfigureEffects(this.viewOptions(doc.indent)) });
    doc.optionsVersion = this.optionsVersion;
  }

  private onUpdate(u: ViewUpdate): void {
    // Secondary editors (comparison panes) share the extension set but are not the active tab.
    if (u.view !== this.view) return;
    const doc = this.active;
    if (!doc) return;
    if (u.docChanged) {
      doc.missing = false;
      this.emit("doc");
      this.persist();
      if (!doc.path && !doc.langManual) this.guess();
    } else if (u.selectionSet) {
      this.emit("selection");
      if (Date.now() - this.lastSelectionPersist > 1000) {
        this.lastSelectionPersist = Date.now();
        this.persist();
      }
    }
  }

  // ---- creating documents ---------------------------------------------------

  private buildDoc(p: Partial<Doc> & { text: string }): Doc {
    const s = settings.value;
    const path = p.path ?? null;
    const indent = p.indent ?? detectIndent(p.text) ?? { useTabs: !s.insertSpaces, size: s.tabSize };
    let def = p.langId ? getLanguage(p.langId) : detectLanguage(path);
    if (!p.langId && def.id === "plaintext") {
      const nl = p.text.indexOf("\n");
      def = detectFromShebang(nl < 0 ? p.text : p.text.slice(0, nl)) ?? def;
      // Tabs without a file name: guess from the content (never overrides a language chosen by hand).
      if (!path && def.id === "plaintext") def = getLanguage(guessLanguage(p.text));
    }
    const state = makeState(p.text, this.viewOptions(indent), [], p.anchor !== undefined ? { anchor: p.anchor, head: p.head ?? p.anchor } : undefined);
    const doc: Doc = {
      id: p.id ?? newId(),
      path,
      title: p.title ?? (path ? basename(path) : nextUntitledName(this.docs.map((d) => d.title), t("tab.untitled"))),
      encoding: p.encoding ?? s.defaultEncoding,
      eol: p.eol ?? s.defaultEol,
      langId: def.id,
      langManual: p.langManual ?? false,
      indent,
      state,
      savedDoc: p.savedDoc !== undefined ? p.savedDoc : path ? state.doc : null,
      savedMtime: p.savedMtime ?? null,
      forceDirty: p.forceDirty ?? false,
      missing: false,
      anchor: p.anchor ?? 0,
      head: p.head ?? p.anchor ?? 0,
      scrollTop: p.scrollTop ?? 0,
      scrollLeft: p.scrollLeft ?? 0,
      optionsVersion: this.optionsVersion,
      written: null,
      bookmarks: p.bookmarks ?? [],
      follow: false,
      large: null,
    };
    if (doc.bookmarks.length) doc.state = state.update({ effects: setBookmarkEffect(doc.bookmarks) }).state;
    return doc;
  }

  newDoc(text = ""): Doc {
    const doc = this.buildDoc({ text, savedDoc: null });
    this.docs.push(doc);
    this.emit("tabs");
    void this.activate(doc.id);
    return doc;
  }

  async openPaths(paths: string[], at?: { line: number; column: number }, forceLarge = false): Promise<void> {
    let last: string | null = null;
    for (const path of paths) {
      const existing = this.docs.find((d) => d.path === path);
      if (existing) {
        last = existing.id;
        continue;
      }
      try {
        const meta = await api.fileMeta(path);
        let doc: Doc;
        if (meta.large || forceLarge) {
          doc = this.buildDoc({ text: "", path });
          doc.state = null;
          doc.savedDoc = null;
          if (!(await this.openLarge(doc))) continue;
        } else {
          const f = await api.openFile(path, settings.value.defaultEol);
          if (f.lossy) toast(t("toast.lossyOpen", { name: basename(path) }), "warning");
          doc = this.buildDoc({ text: f.text, path: f.path, encoding: f.encoding, eol: f.eol, savedMtime: f.mtimeMs });
        }
        // Replace a pristine "Untitled" tab instead of piling up empty tabs.
        const only = this.docs.length === 1 ? this.docs[0] : null;
        if (only && !only.path && !this.isDirty(only)) {
          const wasActive = only.id === this.activeId;
          this.docs = [];
          if (wasActive) this.activeId = null;
          void api.bufferDelete(only.id).catch(() => {});
        }
        this.docs.push(doc);
        last = doc.id;
        this.addRecent(path);
      } catch (e) {
        toast(`${basename(path)}: ${errorMessage(e)}`, "error");
      }
    }
    this.emit("tabs");
    if (last) {
      await this.activate(last);
      if (at) this.goTo(at.line, at.column);
    }
    this.persist();
  }

  async openDialog(): Promise<void> {
    const sel = await openDialog({ multiple: true, directory: false, title: t("dialog.open") });
    if (!sel) return;
    await this.openPaths(Array.isArray(sel) ? sel : [sel]);
  }

  private addRecent(path: string): void {
    this.recent = pushRecent(this.recent, path);
    void api.docWrite("recent", JSON.stringify(this.recent)).catch(() => {});
  }

  async loadRecent(): Promise<void> {
    try {
      const raw = await api.docRead("recent");
      const v = raw ? JSON.parse(raw) : [];
      this.recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      this.recent = [];
    }
  }

  // ---- activation -----------------------------------------------------------

  private captureView(): void {
    const doc = this.active;
    if (!doc || doc.large) return;
    doc.state = this.view.state;
    this.captureLive();
  }

  private captureLive(): void {
    const d = this.active;
    if (!d || d.large) return;
    const m = this.view.state.selection.main;
    d.anchor = m.anchor;
    d.head = m.head;
    d.scrollTop = this.view.scrollDOM.scrollTop;
    d.scrollLeft = this.view.scrollDOM.scrollLeft;
  }

  /** Makes sure a lazily restored tab has its editor state (reads the file when needed). */
  async ensureLoaded(doc: Doc): Promise<boolean> {
    if (doc.state || doc.large) return true;
    if (!doc.path) return false;
    try {
      if ((await api.fileMeta(doc.path)).large) return await this.openLarge(doc);
      const f = await api.openFile(doc.path, settings.value.defaultEol);
      doc.indent = detectIndent(f.text) ?? doc.indent;
      doc.state = makeState(f.text, this.viewOptions(doc.indent), [], { anchor: doc.anchor, head: doc.head });
      if (doc.bookmarks.length) doc.state = doc.state.update({ effects: setBookmarkEffect(doc.bookmarks) }).state;
      doc.savedDoc = doc.state.doc;
      doc.encoding = f.encoding;
      doc.eol = f.eol;
      doc.savedMtime = f.mtimeMs;
    } catch (e) {
      doc.missing = true;
      doc.state = makeState("", this.viewOptions(doc.indent));
      doc.savedDoc = doc.state.doc;
      toast(`${doc.title}: ${errorMessage(e)}`, "error");
    }
    return true;
  }

  async activate(id: string): Promise<void> {
    const next = this.docs.find((d) => d.id === id);
    if (!next) return;
    if (id !== this.activeId) this.captureView();
    if (!(await this.ensureLoaded(next))) return;
    this.activeId = id;
    if (next.large) {
      this.showLarge(next);
      this.emit("tabs");
      this.emit("active");
      this.updateWindowTitle();
      this.persist();
      return;
    }
    this.hideLarge();
    if (next.optionsVersion !== this.optionsVersion) {
      next.state = next.state!.update({ effects: reconfigureEffects(this.viewOptions(next.indent)) }).state;
      next.optionsVersion = this.optionsVersion;
    }
    this.view.setState(next.state!);
    const restoreScroll = () => {
      if (this.activeId !== id) return;
      this.view.scrollDOM.scrollTop = next.scrollTop;
      this.view.scrollDOM.scrollLeft = next.scrollLeft;
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
    this.emit("tabs");
    this.emit("active");
    this.updateWindowTitle();
    void this.ensureDocLanguage(next);
    this.persist();
  }

  /** Re-detects the language of open files, e.g. after custom languages were registered. */
  /** Turns "follow file" on or off for a tab. A followed file is reloaded when it changes and the view stays at its end. */
  toggleFollow(doc: Doc): void {
    if (!doc.path) {
      toast(t("follow.needsFile"), "info");
      return;
    }
    doc.follow = !doc.follow;
    if (doc.large) {
      doc.large.viewer?.setFollow(doc.follow);
      this.emit("doc");
      return;
    }
    if (doc.follow) {
      if (this.isDirty(doc)) {
        doc.follow = false;
        toast(t("follow.unsaved"), "warning");
        return;
      }
      this.scrollToEnd(doc);
      this.followTimer ??= window.setInterval(() => void this.followTick(), 1000);
    }
    if (!this.docs.some((d) => d.follow) && this.followTimer !== undefined) {
      clearInterval(this.followTimer);
      this.followTimer = undefined;
    }
    this.emit("doc");
  }

  private scrollToEnd(doc: Doc): void {
    if (doc.id !== this.activeId) return;
    const end = this.view.state.doc.length;
    this.view.dispatch({ selection: EditorSelection.cursor(end), effects: EditorView.scrollIntoView(end, { y: "end" }) });
  }

  private async followTick(): Promise<void> {
    if (this.following) return;
    this.following = true;
    try {
      const docs = this.docs.filter((d) => d.follow && d.path && d.state);
      if (!docs.length) return;
      const mtimes = await api.fileMtimes(docs.map((d) => d.path!));
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const m = mtimes[i];
        if (m === null || m === doc.savedMtime) continue;
        if (this.isDirty(doc)) {
          doc.follow = false;
          toast(t("follow.stoppedUnsaved", { name: doc.title }), "warning");
          this.emit("doc");
          continue;
        }
        try {
          this.replaceContents(doc, await api.openFile(doc.path!, settings.value.defaultEol));
          this.scrollToEnd(doc);
        } catch (e) {
          doc.follow = false;
          toast(`${doc.title}: ${errorMessage(e)}`, "error");
          this.emit("doc");
        }
      }
    } finally {
      this.following = false;
    }
  }

  async redetectLanguages(): Promise<void> {
    for (const d of this.docs) {
      if (!d.path || d.langManual) continue;
      const id = detectLanguage(d.path).id;
      if (id === d.langId) continue;
      d.langId = id;
      if (d.state || d.id === this.activeId) await this.ensureDocLanguage(d);
    }
    this.emit("doc");
  }

  private async autoDetect(): Promise<void> {
    const d = this.active;
    if (!d || d.path || d.langManual) return;
    const id = guessLanguage(this.textOf(d));
    if (id && id !== d.langId) await this.setLanguage(d, id, false);
  }

  // ---- large files -----------------------------------------------------------------

  private async openLarge(doc: Doc): Promise<boolean> {
    try {
      await import("../ui/largeView"); // load the viewer code before it is needed synchronously
      const opened = await api.lfOpen(doc.path!);
      doc.large = { opened, viewer: null };
      doc.encoding = opened.info.encoding;
      doc.eol = opened.info.eol;
      doc.langId = "plaintext";
      doc.state = null;
      return true;
    } catch (e) {
      toast(`${doc.title}: ${errorMessage(e)}`, "error");
      return false;
    }
  }

  /** The viewer of the active tab, when it is a large file. */
  largeViewer(): LargeViewer | null {
    return this.active?.large?.viewer ?? null;
  }

  private async showLarge(doc: Doc): Promise<void> {
    const { LargeViewer } = await import("../ui/largeView");
    this.hideLarge();
    const l = doc.large!;
    const host = document.getElementById("editor")!.parentElement!;
    l.viewer ??= new LargeViewer(host, l.opened, { onChange: () => this.emit("selection") });
    document.getElementById("editor")!.style.visibility = "hidden";
    l.viewer.setVisible(true);
    this.emit("selection");
  }

  private hideLarge(): void {
    for (const d of this.docs) d.large?.viewer?.setVisible(false);
    document.getElementById("editor")!.style.visibility = "";
  }

  private disposeLarge(doc: Doc): void {
    if (!doc.large) return;
    if (doc.large.viewer) doc.large.viewer.destroy();
    else void api.lfClose(doc.large.opened.id).catch(() => {});
    doc.large = null;
  }

  /** The language extension of a tab (loaded on demand), for editors other than the main one. */
  languageExtensionFor(doc: Doc): Promise<Extension> {
    return loadLanguage(getLanguage(doc.langId));
  }

  /** Replaces the whole content of a tab (one undoable change). No-op when the text is the same. */
  applyText(doc: Doc, text: string): void {
    const st = this.stateOf(doc);
    if (!st || st.doc.toString() === text) return;
    this.updateState(doc, { changes: { from: 0, to: st.doc.length, insert: text }, userEvent: "input.compare" });
    this.emit("tabs");
    this.updateWindowTitle();
    this.persist();
  }

  async ensureDocLanguage(doc: Doc): Promise<void> {
    const ext = await loadLanguage(getLanguage(doc.langId));
    if (!this.docs.includes(doc)) return;
    this.updateState(doc, { effects: compartments.language.reconfigure(ext) });
  }

  focus(): void {
    this.view.focus();
  }

  nextTab(dir: 1 | -1): void {
    if (this.docs.length < 2) return;
    const i = this.docs.findIndex((d) => d.id === this.activeId);
    void this.activate(this.docs[(i + dir + this.docs.length) % this.docs.length].id);
  }

  moveTab(from: number, to: number): void {
    const [d] = this.docs.splice(from, 1);
    this.docs.splice(to, 0, d);
    this.emit("tabs");
    this.persist();
  }

  updateWindowTitle(): void {
    const d = this.active;
    const title = d ? `${this.isDirty(d) ? "● " : ""}${d.title} — Nimble Newt` : "Nimble Newt";
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }

  goTo(line: number, column: number): void {
    const st = this.view.state;
    const l = st.doc.line(Math.max(1, Math.min(st.doc.lines, line)));
    const pos = l.from + Math.max(0, Math.min(l.length, column));
    this.view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    this.view.focus();
  }

  selectRange(line: number, column: number, length: number): void {
    const st = this.view.state;
    const l = st.doc.line(Math.max(1, Math.min(st.doc.lines, line)));
    const from = l.from + Math.min(l.length, column);
    this.view.dispatch({ selection: EditorSelection.range(from, Math.min(st.doc.length, from + length)), effects: EditorView.scrollIntoView(from, { y: "center" }) });
    this.view.focus();
  }

  // ---- saving ------------------------------------------------------------------

  /**
   * Saves a tab. Unless `skipCheck` is set, the backend refuses to overwrite a file that changed on disk
   * since it was opened; the user then chooses between overwriting and reloading.
   */
  async save(doc: Doc, skipCheck = false): Promise<boolean> {
    if (doc.large) {
      toast(t("large.readOnly"), "info");
      return true;
    }
    if (!doc.path) return this.saveAs(doc);
    const st = this.stateOf(doc);
    if (!st) return true;
    const snapshot = st.doc;
    try {
      const r = await api.saveFile(doc.path, snapshot.toString(), doc.encoding, doc.eol, expectedMtime(doc, skipCheck));
      doc.savedDoc = snapshot;
      doc.savedMtime = r.mtimeMs;
      doc.forceDirty = false;
      doc.missing = false;
      if (r.lossy) toast(t("toast.lossySave", { encoding: doc.encoding }), "warning");
      this.emit("tabs");
      this.updateWindowTitle();
      this.persist();
      return true;
    } catch (e) {
      if (isConflict(e)) return this.resolveSaveConflict(doc);
      toast(t("toast.saveFailed", { name: doc.title, error: errorMessage(e) }), "error");
      return false;
    }
  }

  private async resolveSaveConflict(doc: Doc): Promise<boolean> {
    const choice = await openSheet<"overwrite" | "reload" | "cancel">({
      title: t("conflict.title", { name: doc.title }),
      alert: true,
      body: h("p", {}, t("conflict.message")),
      dismissValue: "cancel",
      choices: [
        { value: "cancel", label: t("common.cancel") },
        { value: "reload", label: t("conflict.reload") },
        { value: "overwrite", label: t("conflict.overwrite"), kind: "danger" },
      ],
    });
    if (choice === "overwrite") return this.save(doc, true);
    if (choice === "reload") {
      try {
        this.replaceContents(doc, await api.openFile(doc.path!, settings.value.defaultEol));
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    }
    return false;
  }

  async saveAs(doc: Doc): Promise<boolean> {
    const path = await saveDialog({ title: t("dialog.saveAs"), defaultPath: doc.path ?? doc.title });
    if (!path) return false;
    const prev = { path: doc.path, title: doc.title };
    doc.path = path;
    doc.title = basename(path);
    if (!doc.langManual) {
      const def = detectLanguage(path);
      if (def.id !== doc.langId) await this.setLanguage(doc, def.id, false);
    }
    // A new path has nothing on disk to conflict with (the dialog already confirmed any overwrite).
    if (!(await this.save(doc, true))) {
      doc.path = prev.path;
      doc.title = prev.title;
      return false;
    }
    this.addRecent(path);
    this.emit("tabs");
    this.emit("active");
    this.updateWindowTitle();
    return true;
  }

  async saveAll(): Promise<boolean> {
    for (const d of [...this.docs]) if (this.isDirty(d) && !(await this.save(d))) return false;
    return true;
  }

  // ---- closing -------------------------------------------------------------------

  async close(id: string): Promise<boolean> {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return true;
    if (this.isDirty(doc)) {
      const choice = await openSheet<"save" | "discard" | "cancel">({
        title: t("close.title", { name: doc.title }),
        alert: true,
        body: h("p", {}, t("close.message")),
        dismissValue: "cancel",
        choices: [
          { value: "discard", label: t("close.discard"), kind: "danger" },
          { value: "cancel", label: t("common.cancel") },
          { value: "save", label: t("common.save"), kind: "primary" },
        ],
      });
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.save(doc))) return false;
    }
    this.removeDoc(doc);
    return true;
  }

  private removeDoc(doc: Doc): void {
    const i = this.docs.indexOf(doc);
    if (doc.path) {
      this.closed.push({ path: doc.path });
      if (this.closed.length > 20) this.closed.shift();
    }
    this.disposeLarge(doc);
    this.docs.splice(i, 1);
    void api.bufferDelete(doc.id).catch(() => {});
    if (doc.id === this.activeId) {
      this.activeId = null;
      if (this.docs.length === 0) this.newDoc();
      else void this.activate(this.docs[Math.min(i, this.docs.length - 1)].id);
    }
    this.emit("tabs");
    this.persist();
  }

  async closeMany(ids: string[]): Promise<boolean> {
    for (const id of ids) if (!(await this.close(id))) return false;
    return true;
  }

  closeOthers(id: string): Promise<boolean> {
    return this.closeMany(this.docs.filter((d) => d.id !== id).map((d) => d.id));
  }

  closeRightOf(id: string): Promise<boolean> {
    const i = this.docs.findIndex((d) => d.id === id);
    return this.closeMany(this.docs.slice(i + 1).map((d) => d.id));
  }

  async reopenClosed(): Promise<void> {
    const c = this.closed.pop();
    if (c) await this.openPaths([c.path]);
  }

  // ---- encoding, line endings, language ---------------------------------------------

  setEol(doc: Doc, eol: Eol): void {
    if (doc.eol === eol) return;
    doc.eol = eol;
    doc.forceDirty = true;
    this.emit("doc");
    this.emit("tabs");
    this.persist();
  }

  /** "Convert to": the text stays, the next save writes it in `enc`. */
  setEncoding(doc: Doc, enc: Encoding): void {
    if (doc.encoding === enc) return;
    doc.encoding = enc;
    doc.forceDirty = true;
    this.emit("doc");
    this.emit("tabs");
    this.persist();
  }

  /** "Reopen with": discards the text and decodes the file again. */
  async reopenWithEncoding(doc: Doc, enc: Encoding): Promise<void> {
    if (!doc.path) return;
    if (this.isDirty(doc) && !(await confirmSheet(t("reopen.title"), t("reopen.message"), t("reopen.confirm"), true))) return;
    try {
      this.replaceContents(doc, await api.openFileAs(doc.path, enc, settings.value.defaultEol));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  private replaceContents(doc: Doc, f: OpenedFile): void {
    const st = this.stateOf(doc);
    if (!st) return;
    this.updateState(doc, { changes: { from: 0, to: st.doc.length, insert: f.text }, selection: { anchor: Math.min(st.selection.main.head, f.text.length) } });
    doc.encoding = f.encoding;
    doc.eol = f.eol;
    doc.savedDoc = this.stateOf(doc)!.doc;
    doc.savedMtime = f.mtimeMs;
    doc.forceDirty = false;
    doc.missing = false;
    this.emit("tabs");
    this.emit("doc");
    this.updateWindowTitle();
    this.persist();
  }

  async setLanguage(doc: Doc, langId: string, manual = true): Promise<void> {
    doc.langId = langId;
    if (manual) doc.langManual = true;
    await this.ensureDocLanguage(doc);
    this.emit("doc");
    this.persist();
  }

  setIndent(doc: Doc, indent: Indent): void {
    doc.indent = indent;
    this.applyOptions(doc);
    this.emit("doc");
    this.persist();
  }

  // ---- external changes -----------------------------------------------------------------

  async checkExternal(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const cand = this.docs.filter((d) => d.path && d.state);
      if (!cand.length) return;
      const mtimes = await api.fileMtimes(cand.map((d) => d.path!));
      for (let i = 0; i < cand.length; i++) {
        const doc = cand[i];
        const m = mtimes[i];
        if (!this.docs.includes(doc)) continue;
        if (doc.follow && m !== null && !this.isDirty(doc)) continue; // the follow timer reloads it
        if (m === null) {
          if (!doc.missing) {
            doc.missing = true;
            doc.forceDirty = true;
            toast(t("toast.deleted", { name: doc.title }), "warning");
            this.emit("tabs");
          }
          continue;
        }
        if (m === doc.savedMtime && !doc.missing) continue;
        const dirty = this.isDirty(doc);
        const choice = await openSheet<"reload" | "keep">({
          title: t("external.title", { name: doc.title }),
          alert: true,
          body: h("p", {}, dirty ? t("external.messageDirty") : t("external.message")),
          dismissValue: "keep",
          choices: [
            { value: "keep", label: t("external.keep") },
            { value: "reload", label: t("external.reload"), kind: dirty ? "danger" : "primary" },
          ],
        });
        if (choice === "reload") {
          try {
            this.replaceContents(doc, await api.openFile(doc.path!, settings.value.defaultEol));
          } catch (e) {
            toast(errorMessage(e), "error");
          }
        } else {
          doc.savedMtime = m;
          doc.missing = false;
          doc.forceDirty = true;
          this.emit("tabs");
        }
      }
    } finally {
      this.checking = false;
    }
  }

  // ---- session -----------------------------------------------------------------------------

  /** Writes unsaved buffers and tab metadata. Only changed buffers are rewritten. */
  async persistNow(): Promise<void> {
    if (!settings.value.restoreSession) {
      await api.sessionSave({ tabs: [], active: null }).catch(() => {});
      return;
    }
    this.captureLive();
    try {
      for (const d of this.docs) {
        const st = this.stateOf(d);
        if (!st) continue;
        if (!d.path || this.isDirty(d)) {
          if (d.written !== st.doc) {
            await api.bufferWrite(d.id, st.doc.toString());
            d.written = st.doc;
          }
        } else if (d.written) {
          await api.bufferDelete(d.id);
          d.written = null;
        }
      }
      await api.sessionSave({
        active: this.activeId,
        tabs: this.docs.map((d) => ({
          id: d.id,
          path: d.path,
          title: d.title,
          encoding: d.encoding,
          eol: d.eol,
          language: d.langManual ? d.langId : null,
          dirty: this.isDirty(d),
          selectionAnchor: d.anchor,
          selectionHead: d.head,
          scrollTop: d.scrollTop,
          scrollLeft: d.scrollLeft,
          savedMtimeMs: d.savedMtime,
          bookmarks: this.stateOf(d) ? bookmarkedLines(this.stateOf(d)!) : d.bookmarks,
        })),
      });
    } catch (e) {
      console.error("session save failed", e);
    }
  }

  async flush(): Promise<void> {
    this.persist.cancel();
    await this.persistNow();
  }

  /** Rebuilds tabs from the session store. Clean file tabs are read lazily when first shown. */
  async restore(tabs: RestoredTab[], active: string | null): Promise<void> {
    const built = await Promise.all(
      tabs.map(async (m): Promise<Doc | null> => {
        const common = {
          id: m.id, path: m.path, title: m.title,
          encoding: m.encoding ?? settings.value.defaultEncoding,
          eol: m.eol ?? settings.value.defaultEol,
          langId: m.language ?? undefined, langManual: !!m.language,
          anchor: m.selectionAnchor, head: m.selectionHead,
          scrollTop: m.scrollTop, scrollLeft: m.scrollLeft, savedMtime: m.savedMtimeMs,
          bookmarks: m.bookmarks ?? [],
        };
        if (m.buffer !== null) {
          let savedDoc: Text | null = null;
          if (m.path) {
            try {
              savedDoc = toText((await api.openFile(m.path, "LF")).text);
            } catch {
              savedDoc = null;
            }
          }
          const doc = this.buildDoc({ ...common, text: m.buffer, savedDoc });
          doc.forceDirty = m.dirty && (!!m.path && (!savedDoc || doc.state!.doc.eq(savedDoc)));
          doc.missing = !!m.path && !savedDoc;
          doc.written = doc.state!.doc;
          return doc;
        }
        if (!m.path) return null;
        const doc = this.buildDoc({ ...common, text: "" });
        doc.state = null;
        doc.savedDoc = null;
        if (!m.language) doc.langId = detectLanguage(m.path).id;
        return doc;
      }),
    );
    this.docs = built.filter((d): d is Doc => d !== null);
    const target = this.docs.find((d) => d.id === active) ?? this.docs[0];
    this.emit("tabs");
    if (target) await this.activate(target.id);
  }
}

export const workspace = new Workspace();

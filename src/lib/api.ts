import { Channel, invoke } from "@tauri-apps/api/core";

/** An encoding label such as "UTF-8" or "Shift_JIS"; the full list comes from `api.listEncodings()`. */
export type Encoding = string;
export interface EncodingInfo {
  label: string;
  group: string;
}
export type Eol = "LF" | "CRLF" | "CR";
/** Offered directly in menus; everything else is reached through "Other…". */
export const COMMON_ENCODINGS: Encoding[] = ["UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE", "Windows-1252"];

let encodingList: Promise<EncodingInfo[]> | null = null;
/** All supported encodings (cached). */
export const listEncodings = (): Promise<EncodingInfo[]> => (encodingList ??= invoke<EncodingInfo[]>("list_encodings"));
export const EOLS: Eol[] = ["LF", "CRLF", "CR"];

export interface OpenedFile {
  path: string;
  text: string;
  encoding: Encoding;
  eol: Eol;
  lossy: boolean;
  mtimeMs: number;
  size: number;
}
export interface WriteResult {
  mtimeMs: number;
  lossy: boolean;
}
export interface TabMeta {
  id: string;
  path: string | null;
  title: string;
  encoding: Encoding | null;
  eol: Eol | null;
  language: string | null;
  dirty: boolean;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop: number;
  scrollLeft: number;
  savedMtimeMs: number | null;
  bookmarks?: number[];
}
export interface SessionMeta {
  tabs: TabMeta[];
  active: string | null;
}
export interface RestoredTab extends TabMeta {
  buffer: string | null;
}
export interface RestoredSession {
  tabs: RestoredTab[];
  active: string | null;
}

export interface SearchOptions {
  root: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  respectGitignore: boolean;
  includeHidden: boolean;
}
export interface Match {
  line: number;
  column: number;
  length: number;
  preview: string;
  previewOffset: number;
  replaced: string | null;
}
export interface FileMatches {
  path: string;
  mtimeMs: number;
  matches: Match[];
}
export interface SearchReport {
  files: FileMatches[];
  totalMatches: number;
  filesScanned: number;
  filesSkippedBinary: number;
  truncated: boolean;
}
export interface ReplaceReport {
  filesChanged: number;
  replacements: number;
  skipped: string[];
  errors: string[];
}

export interface UpdateInfo {
  version: string;
  notes: string;
  date: string | null;
}
export type UpdateErrorKind = "offline" | "invalidSignature" | "notConfigured" | "badManifest" | "other";
export interface UpdateFailure {
  kind: UpdateErrorKind;
  message: string;
}
export type DownloadEvent = { event: "progress"; chunk: number; total: number | null } | { event: "finished" };

export interface ExtManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  minAppVersion?: string | null;
  main: string;
  permissions: string[];
  contributes: { commands: { id: string; title: string }[]; menus?: unknown[] };
}
export interface InstalledExtension {
  manifest: ExtManifest;
  enabled: boolean;
  dir: string;
  builtin: boolean;
}

export interface Hunk {
  kind: "added" | "removed" | "changed";
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
}
export interface Comparison {
  hunks: Hunk[];
  aLines: number;
  bLines: number;
  addedLines: number;
  removedLines: number;
  identical: boolean;
  timedOut: boolean;
}
export interface DiffOptions {
  whitespace: "exact" | "trailing" | "edges" | "all";
  ignoreCase: boolean;
  timeoutMs: number;
}
export interface FileComparison {
  id: number;
  comparison: Comparison;
  eolA: Eol;
  eolB: Eol;
}

export interface LargeOpenInfo {
  path: string;
  size: number;
  encoding: Encoding;
  eol: Eol;
  bomLen: number;
}
export interface IndexStatus {
  indexedBytes: number;
  indexedLines: number;
  size: number;
  done: boolean;
  totalLines: number | null;
  reset: boolean;
}
export interface LargeOpened {
  id: number;
  info: LargeOpenInfo;
  status: IndexStatus;
}
export interface LineText {
  text: string;
  truncated: boolean;
  offset: number;
}
export interface LinesChunk {
  first: number;
  lines: LineText[];
  available: boolean;
  eof: boolean;
  totalLines: number | null;
}
export interface LargeQuery {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}
export interface LargeHit {
  line: number;
  column: number;
  length: number;
  byteOffset: number;
  preview: string;
  wrapped: boolean;
}

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";
export interface Digest {
  algorithm: HashAlgorithm;
  hex: string;
}

export interface FolderEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export const api = {
  listDir: (path: string, showHidden: boolean, respectGitignore = true) => invoke<FolderEntry[]>("list_dir", { path, showHidden, respectGitignore }),
  findFiles: (root: string, query: string, limit: number, showHidden: boolean, respectGitignore = true) => invoke<string[]>("find_files", { root, query, limit, showHidden, respectGitignore }),
  fileMeta: (path: string) => invoke<{ size: number; large: boolean }>("file_meta", { path }),
  lfOpen: (path: string, encoding: Encoding | null = null) => invoke<LargeOpened>("lf_open", { path, encoding }),
  lfStatus: (id: number) => invoke<IndexStatus>("lf_status", { id }),
  lfRead: (id: number, first: number, count: number, maxChars: number) => invoke<LinesChunk>("lf_read", { id, first, count, maxChars }),
  /** `op` names this search for `lfCancel`; ids are chosen by the caller (see `LargeOps`). */
  lfSearch: (id: number, query: LargeQuery, from: { line: number; column: number }, direction: "forward" | "backward", op: number) => invoke<LargeHit | null>("lf_search", { id, query, from, direction, op }),
  lfCount: (id: number, query: LargeQuery, op: number) => invoke<number>("lf_count", { id, query, op }),
  /** Cancels the search or count `op`; without `op` every one running on the file. */
  lfCancel: (id: number, op: number | null = null) => invoke<void>("lf_cancel", { id, op }),
  lfRefresh: (id: number) => invoke<IndexStatus>("lf_refresh", { id }),
  lfClose: (id: number) => invoke<void>("lf_close", { id }),
  hashText: (text: string, algorithms: HashAlgorithm[]) => invoke<Digest[]>("hash_text", { text, algorithms }),
  hashFile: (path: string, algorithms: HashAlgorithm[]) => invoke<Digest[]>("hash_file", { path, algorithms }),
  compareText: (a: string, b: string, options: DiffOptions) => invoke<Comparison>("compare_text", { a, b, options }),
  compareFiles: (a: string, b: string, options: DiffOptions) => invoke<FileComparison>("compare_files", { a, b, options }),
  compareLines: (id: number, side: "a" | "b", start: number, len: number) => invoke<string[]>("compare_lines", { id, side, start, len }),
  compareClose: (id: number) => invoke<void>("compare_close", { id }),
  openFile: (path: string, defaultEol: Eol) => invoke<OpenedFile>("open_file", { path, defaultEol }),
  openFileAs: (path: string, encoding: Encoding, defaultEol: Eol) => invoke<OpenedFile>("open_file_as", { path, encoding, defaultEol }),
  saveFile: (path: string, text: string, encoding: Encoding, eol: Eol, expectedMtimeMs: number | null, allowLossy = false) => invoke<WriteResult>("save_file", { path, text, encoding, eol, expectedMtimeMs, allowLossy }),
  fileMtimes: (paths: string[]) => invoke<(number | null)[]>("file_mtimes", { paths }),
  sessionLoad: () => invoke<RestoredSession>("session_load"),
  sessionSave: (meta: SessionMeta) => invoke<void>("session_save", { meta }),
  bufferWrite: (id: string, text: string) => invoke<void>("buffer_write", { id, text }),
  bufferDelete: (id: string) => invoke<void>("buffer_delete", { id }),
  docRead: (name: string) => invoke<string | null>("doc_read", { name }),
  docWrite: (name: string, json: string) => invoke<void>("doc_write", { name, json }),
  searchFolder: (options: SearchOptions, replacement: string | null) => invoke<SearchReport>("search_folder", { options, replacement }),
  replaceInFolder: (options: SearchOptions, replacement: string, targets: { path: string; mtimeMs: number }[]) => invoke<ReplaceReport>("replace_in_folder", { options, replacement, targets }),
  takePendingPaths: () => invoke<string[]>("take_pending_paths"),
  setExtensionMenu: (locale: string, items: { id: string; label: string }[]) => invoke<void>("set_extension_menu", { locale, items }),
  sandboxStage: (html: string) => invoke<string>("sandbox_stage", { html }),
  sandboxRelease: (id: string) => invoke<void>("sandbox_release", { id }),
  extList: () => invoke<{ extensions: InstalledExtension[]; problems: string[] }>("ext_list"),
  extInspect: (path: string) => invoke<ExtManifest>("ext_inspect", { path }),
  extInstall: (path: string, allowSame: boolean, expected: ExtManifest) => invoke<ExtManifest>("ext_install", { path, allowSame, expected }),
  extRemove: (id: string) => invoke<void>("ext_remove", { id }),
  extSetEnabled: (id: string, enabled: boolean) => invoke<void>("ext_set_enabled", { id, enabled }),
  extReadMain: (id: string) => invoke<string>("ext_read_main", { id }),
  extStorageGet: (id: string, key: string) => invoke<unknown>("ext_storage_get", { id, key }),
  extStorageSet: (id: string, key: string, value: string) => invoke<void>("ext_storage_set", { id, key, value }),
  extStorageRemove: (id: string, key: string) => invoke<void>("ext_storage_remove", { id, key }),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),
  appReady: (stages: Record<string, number>) => invoke<boolean>("app_ready", { frontendMs: performance.now(), stages }),
  selftestDone: (ok: boolean, message: string) => invoke<void>("selftest_done", { ok, message }),
  restartApp: () => invoke<void>("restart_app"),
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  installUpdate: (onEvent: (e: DownloadEvent) => void) => {
    const ch = new Channel<DownloadEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("install_update", { onEvent: ch });
  },
};

/** Tauri rejects with the Err value: a string, or the serialized UpdateFailure object. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

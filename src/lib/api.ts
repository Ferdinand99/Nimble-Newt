import { Channel, invoke } from "@tauri-apps/api/core";

export type Encoding = "UTF-8" | "UTF-8 BOM" | "UTF-16 LE" | "UTF-16 BE" | "Windows-1252";
export type Eol = "LF" | "CRLF" | "CR";
export const ENCODINGS: Encoding[] = ["UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE", "Windows-1252"];
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

export const api = {
  openFile: (path: string, defaultEol: Eol) => invoke<OpenedFile>("open_file", { path, defaultEol }),
  openFileAs: (path: string, encoding: Encoding, defaultEol: Eol) => invoke<OpenedFile>("open_file_as", { path, encoding, defaultEol }),
  saveFile: (path: string, text: string, encoding: Encoding, eol: Eol, expectedMtimeMs: number | null) => invoke<WriteResult>("save_file", { path, text, encoding, eol, expectedMtimeMs }),
  fileMtimes: (paths: string[]) => invoke<(number | null)[]>("file_mtimes", { paths }),
  sessionLoad: () => invoke<RestoredSession>("session_load"),
  sessionSave: (meta: SessionMeta) => invoke<void>("session_save", { meta }),
  bufferWrite: (id: string, text: string) => invoke<void>("buffer_write", { id, text }),
  bufferDelete: (id: string) => invoke<void>("buffer_delete", { id }),
  docRead: (name: string) => invoke<string | null>("doc_read", { name }),
  docWrite: (name: string, json: string) => invoke<void>("doc_write", { name, json }),
  searchFolder: (options: SearchOptions, replacement: string | null) => invoke<SearchReport>("search_folder", { options, replacement }),
  replaceInFolder: (options: SearchOptions, replacement: string, paths: string[]) => invoke<ReplaceReport>("replace_in_folder", { options, replacement, paths }),
  takePendingPaths: () => invoke<string[]>("take_pending_paths"),
  setLocale: (locale: string) => invoke<void>("set_locale", { locale }),
  appReady: (stages: Record<string, number>) => invoke<void>("app_ready", { frontendMs: performance.now(), stages }),
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

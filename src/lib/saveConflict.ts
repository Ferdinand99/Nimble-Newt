/** The modification time to send with a save so the backend can detect outside changes. */
export function expectedMtime(doc: { path: string | null; savedMtime: number | null }, skipCheck: boolean): number | null {
  if (skipCheck || !doc.path) return null;
  return doc.savedMtime;
}

/** True when the backend refused a save because the file changed on disk. */
export function isConflict(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { kind?: unknown }).kind === "conflict";
}

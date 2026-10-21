/** Tools that work on text in the editor can't run on a tab that shows a large file in the read-only viewer. */
const WORKS_WITHOUT_TEXT = new Set(["tools.panel", "tools.hashFile"]);

export function toolBlockedOnLarge(id: string, large: boolean): boolean {
  return large && !WORKS_WITHOUT_TEXT.has(id);
}

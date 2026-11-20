// The three ways a Markdown tab can be shown, and how the commands move between them.

export type MdView = "edit" | "split" | "read";
export const MD_VIEWS: readonly MdView[] = ["edit", "split", "read"];

/** Anything that is not a known view (an older session, a hand-edited file) is "edit". */
export function parseMdView(v: unknown): MdView {
  return v === "split" || v === "read" ? v : "edit";
}

export type MdAction = "toggleRead" | "toggleSplit" | "edit" | "split" | "read";

/**
 * The view after a command, like VS Code: Ctrl+Shift+V toggles the read view (from Split it goes to
 * Read), Ctrl+K V toggles the split view.
 */
export function nextMdView(current: MdView, action: MdAction): MdView {
  switch (action) {
    case "toggleRead":
      return current === "read" ? "edit" : "read";
    case "toggleSplit":
      return current === "split" ? "edit" : "split";
    default:
      return action;
  }
}

export interface MdDocLike {
  langId: string;
  large: unknown;
  mdView: MdView;
}

/** Markdown is whatever the language detection (or the user) calls "markdown": .md, .markdown, .mdx, … */
export function isMarkdownDoc(d: MdDocLike | null | undefined): d is MdDocLike {
  return !!d && !d.large && d.langId === "markdown";
}

/** The view a tab is shown in: its own choice for Markdown, always "edit" for anything else. */
export function effectiveMdView(d: MdDocLike | null | undefined): MdView {
  return isMarkdownDoc(d) ? d.mdView : "edit";
}

/** Commands that do not change the text, so they also run in the read view. */
const READ_OK = /^(file\.|view\.|app\.|lang\.|markdown\.|compare\.|doc\.(language|follow|encoding|reopenEncoding|eol)$|tools\.(panel|hashFile)$|macro\.record$)/;

export function allowedInReadView(commandId: string): boolean {
  return READ_OK.test(commandId);
}

/** How long to wait after typing before the view is rendered again: longer for long documents and slow renders. */
export function renderDelay(length: number, lastRenderMs: number): number {
  return Math.round(Math.min(1500, Math.max(120, length / 2000, lastRenderMs * 2)));
}

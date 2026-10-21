import { debounce } from "../lib/dom";
import { t } from "../lib/i18n";
import { createSidebar, type Sidebar } from "../ui/sidebar";
import { folderState, saveFolderState } from "./folderState";
import { workspace } from "./workspace";

type PanelId = "outline" | "tools";

let left: Sidebar | null = null;
let right: Sidebar | null = null;
let folderOpen = false;
let current: PanelId | null = null;
let outlineRefresh: (() => void) | null = null;

const refresh = debounce(() => outlineRefresh?.(), 400);
workspace.on((kind) => {
  if (current === "outline" && (kind === "doc" || kind === "active")) refresh();
});

function sidebar(): Sidebar {
  return (right ??= createSidebar("right", () => {
    current = null;
    outlineRefresh = null;
  }));
}

/** Shows or hides a panel. The outline (function list) opens in the right sidebar; its code loads on first use. */
export function togglePanel(id: PanelId): void {
  const sb = sidebar();
  if (current === id && sb.isOpen()) {
    sb.close();
    workspace.focus();
    return;
  }
  current = id;
  if (id === "tools") {
    sb.open(t("cmd.tools.panel"), (body) => {
      void import("../ui/toolsPanel").then(({ createToolsPanel }) => createToolsPanel(body));
    });
    return;
  }
  sb.open(t("outline.title"), (body) => {
    let destroy: (() => void) | undefined;
    void import("../ui/outline").then(({ createOutlinePanel }) => {
      if (current !== "outline") return;
      const panel = createOutlinePanel(body, {
        getText: () => workspace.view.state.doc.toString(),
        getLangId: () => workspace.active?.langId ?? "plaintext",
        onJump: (line) => workspace.goTo(line, 0),
        onEscape: () => workspace.focus(),
      });
      outlineRefresh = () => panel.refresh();
      panel.refresh();
      panel.focus();
      destroy = () => panel.destroy();
    });
    return () => {
      destroy?.();
      outlineRefresh = null;
    };
  });
}

function leftSidebar(): Sidebar {
  return (left ??= createSidebar("left", () => {
    folderOpen = false;
    saveFolderState({ open: false });
  }));
}

/** Shows or hides the folder (workspace) tree in the left sidebar. */
export function toggleFolder(open?: boolean): void {
  const sb = leftSidebar();
  const want = open ?? !(folderOpen && sb.isOpen());
  if (!want) {
    sb.close();
    workspace.focus();
    return;
  }
  folderOpen = true;
  saveFolderState({ open: true });
  sb.open(t("folder.title"), (body) => {
    let destroy: (() => void) | undefined;
    void import("../ui/folderPanel").then(({ createFolderPanel }) => {
      if (!folderOpen) return;
      destroy = createFolderPanel(body, () => {}).destroy;
    });
    return () => destroy?.();
  });
}

/** Opens the folder panel again after a restart when it was open last time. */
export function restoreFolderPanel(): void {
  if (folderState().open && folderState().root) toggleFolder(true);
}

/** Lets the user pick a folder: shows the panel, which asks for one when none is set. */
export function openFolder(): void {
  saveFolderState({ root: null });
  toggleFolder(true);
}

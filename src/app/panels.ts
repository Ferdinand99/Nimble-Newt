import { debounce } from "../lib/dom";
import { t } from "../lib/i18n";
import { createSidebar, type Sidebar } from "../ui/sidebar";
import { workspace } from "./workspace";

type PanelId = "outline" | "tools";

let right: Sidebar | null = null;
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

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { folderState, saveFolderState } from "../app/folderState";
import { workspace } from "../app/workspace";
import { api, errorMessage, type FolderEntry } from "../lib/api";
import { debounce, h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { basename } from "../lib/logic";
import { toast } from "./toast";
import "../styles/folder.css";

export interface FolderPanel {
  refresh(): void;
  destroy(): void;
}

/** File tree of the workspace folder, with a filename filter. Folders load lazily when expanded. */
export function createFolderPanel(host: HTMLElement, onRootChange: () => void): FolderPanel {
  const cache = new Map<string, FolderEntry[]>();
  const expanded = new Set(folderState().expanded);
  let filter = "";
  let seq = 0;

  const title = h("div", { class: "folder-title" });
  const filterIn = h("input", { class: "input", type: "search", placeholder: t("folder.filter"), "aria-label": t("folder.filter"), spellcheck: false, autocomplete: "off" });
  const tree = h("ul", { class: "folder-tree", role: "tree", "aria-label": t("folder.tree") });
  const empty = h("div", { class: "folder-empty" });
  const btn = (label: string, ic: string, fn: () => void, pressed?: boolean) => h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: label, "aria-label": label, "aria-pressed": pressed === undefined ? undefined : String(pressed), onclick: fn }, icon(ic));
  const hiddenBtn = btn(t("folder.showHidden"), "eye", () => {
    saveFolderState({ showHidden: !folderState().showHidden });
    hiddenBtn.setAttribute("aria-pressed", String(folderState().showHidden));
    cache.clear();
    void render();
  }, folderState().showHidden);
  const bar = h("div", { class: "folder-bar" }, title, btn(t("folder.open"), "folder", () => void chooseFolder()), btn(t("folder.refresh"), "refresh", () => refresh()), hiddenBtn);
  host.append(bar, h("div", { class: "folder-filter" }, filterIn), tree, empty);

  async function chooseFolder(): Promise<void> {
    const sel = await openDialog({ directory: true, multiple: false, defaultPath: folderState().root ?? undefined, title: t("folder.open") });
    if (typeof sel !== "string") return;
    expanded.clear();
    cache.clear();
    saveFolderState({ root: sel, expanded: [] });
    onRootChange();
    await render();
  }

  async function children(dir: string): Promise<FolderEntry[]> {
    let c = cache.get(dir);
    if (!c) {
      c = await api.listDir(dir, folderState().showHidden);
      cache.set(dir, c);
    }
    return c;
  }

  const persistExpanded = debounce(() => saveFolderState({ expanded: [...expanded] }), 400);

  function fileItem(e: FolderEntry, depth: number, label = e.name): HTMLElement {
    const li = h("li", { role: "none" }, h("button", { class: "folder-row", type: "button", role: "treeitem", "aria-level": String(depth + 1), style: `--depth:${depth}`, title: e.path, dataset: { path: e.path } }, icon("file", "icon-sm"), h("span", { class: "folder-name" }, label)));
    li.firstElementChild!.addEventListener("click", () => void workspace.openPaths([e.path]).then(() => workspace.focus()));
    return li;
  }

  async function dirItems(dir: string, depth: number, out: HTMLElement[], budget: { n: number }): Promise<void> {
    let list: FolderEntry[];
    try {
      list = await children(dir);
    } catch (e) {
      out.push(h("li", { class: "folder-error", style: `--depth:${depth}` }, errorMessage(e)));
      return;
    }
    for (const e of list) {
      if (budget.n-- <= 0) {
        out.push(h("li", { class: "folder-error", style: `--depth:${depth}` }, t("folder.tooMany")));
        return;
      }
      if (!e.isDir) {
        out.push(fileItem(e, depth));
        continue;
      }
      const open = expanded.has(e.path);
      const row = h("button", { class: "folder-row", type: "button", role: "treeitem", "aria-expanded": String(open), "aria-level": String(depth + 1), style: `--depth:${depth}`, title: e.path, dataset: { path: e.path } }, icon(open ? "chevron-down" : "chevron-right", "icon-sm folder-chev"), icon("folder", "icon-sm"), h("span", { class: "folder-name" }, e.name));
      row.addEventListener("click", () => {
        if (expanded.has(e.path)) expanded.delete(e.path);
        else expanded.add(e.path);
        persistExpanded();
        void render();
      });
      out.push(h("li", { role: "none" }, row));
      if (open) await dirItems(e.path, depth + 1, out, budget);
    }
  }

  async function render(): Promise<void> {
    const mine = ++seq;
    const root = folderState().root;
    title.textContent = root ? basename(root) : t("folder.title");
    title.title = root ?? "";
    empty.textContent = "";
    if (!root) {
      tree.replaceChildren();
      empty.textContent = t("folder.none");
      return;
    }
    const items: HTMLElement[] = [];
    if (filter.trim()) {
      try {
        const files = await api.findFiles(root, filter, 200, folderState().showHidden);
        if (mine !== seq) return;
        for (const p of files) {
          const rel = p.slice(root.length).replace(/^[\\/]/, "");
          items.push(fileItem({ name: basename(p), path: p, isDir: false, size: 0 }, 0, rel));
        }
        if (!files.length) empty.textContent = t("folder.noMatches");
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    } else {
      await dirItems(root, 0, items, { n: 3000 });
    }
    if (mine !== seq) return;
    tree.replaceChildren(...items);
    markActive();
  }

  function markActive(): void {
    const p = workspace.active?.path;
    tree.querySelectorAll<HTMLElement>("[data-path]").forEach((el) => {
      if (el.dataset.path === p) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    });
  }

  function refresh(): void {
    cache.clear();
    void render();
  }

  filterIn.addEventListener("input", debounce(() => {
    filter = filterIn.value;
    void render();
  }, 200));
  tree.addEventListener("keydown", (e) => {
    const rows = [...tree.querySelectorAll<HTMLElement>(".folder-row")];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => rows[clamp(n)]?.focus();
    const clamp = (n: number) => Math.max(0, Math.min(rows.length - 1, n));
    const open = rows[i]?.getAttribute("aria-expanded");
    const act: Record<string, (() => void) | undefined> = {
      ArrowDown: () => go(i + 1),
      ArrowUp: () => go(i - 1),
      ArrowRight: open === "false" ? () => rows[i].click() : undefined,
      ArrowLeft: open === "true" ? () => rows[i].click() : undefined,
      Escape: () => workspace.focus(),
    };
    const fn = act[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
  const onActive = (k: string) => {
    if (k === "active" || k === "tabs") markActive();
  };
  workspace.on(onActive);
  const onFocus = () => refresh();
  window.addEventListener("focus", onFocus);
  void render();
  if (!folderState().root) void chooseFolder();
  return {
    refresh,
    destroy() {
      window.removeEventListener("focus", onFocus);
    },
  };
}

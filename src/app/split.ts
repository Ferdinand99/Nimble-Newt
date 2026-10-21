import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { editorExtensions } from "../editor/setup";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import "../styles/split.css";
import { workspace } from "./workspace";

/**
 * Split view: a second editor showing the active tab, with its own scroll position and cursor.
 * Edits made in either pane go into the same document; the second pane follows the active tab.
 */
interface Pane {
  view: EditorView;
  wrap: HTMLElement;
  handle: HTMLElement;
  orientation: "right" | "below";
}
let pane: Pane | null = null;
let forwarding = false;
let boundId: string | null = null;

export const isSplit = (): boolean => pane !== null;

async function extensionsFor() {
  const d = workspace.active!;
  const lang = await workspace.languageExtensionFor(d);
  return editorExtensions(workspace.viewOptions(d.indent), lang);
}

async function stateFor(): Promise<EditorState> {
  const d = workspace.active!;
  return EditorState.create({ doc: workspace.view.state.doc, extensions: await extensionsFor(), selection: { anchor: Math.min(d.anchor, workspace.view.state.doc.length) } });
}

/** Called for every change in the main editor: apply it to the second pane too. */
function mirror(u: ViewUpdate): void {
  if (!pane || forwarding || !u.docChanged) return;
  pane.view.dispatch({ changes: u.changes, annotations: Transaction.remote.of(true) });
}

async function rebind(): Promise<void> {
  if (forwarding) return; // the pane is in the middle of applying its own edit
  if (!pane || !workspace.active || workspace.active.large) {
    if (pane && workspace.active?.large) closeSplit();
    return;
  }
  if (boundId === workspace.active.id) {
    // Same tab: only reconcile when the text diverged (for example after a reload from disk).
    const main = workspace.view.state.doc;
    if (!pane.view.state.doc.eq(main)) pane.view.dispatch({ changes: { from: 0, to: pane.view.state.doc.length, insert: main }, annotations: Transaction.remote.of(true) });
    return;
  }
  boundId = workspace.active.id;
  pane.view.setState(await stateFor());
}

export async function openSplit(orientation: "right" | "below" = "right"): Promise<void> {
  if (!workspace.active || workspace.active.large) return;
  if (pane) {
    pane.orientation = orientation;
    layoutPane();
    return;
  }
  const col = document.getElementById("editor")!.parentElement!;
  const wrap = h("div", { class: "split-pane", "aria-label": t("split.pane") });
  const handle = h("div", { class: "split-handle", role: "separator", tabIndex: 0, "aria-label": t("split.resize") });
  const view = new EditorView({
    state: await stateFor(),
    parent: wrap,
    // Edits typed here are applied to the real document first, so history, dirty state and the session see them.
    dispatchTransactions(trs, v) {
      for (const tr of trs) {
        if (tr.docChanged && !tr.annotation(Transaction.remote)) {
          forwarding = true;
          try {
            workspace.view.dispatch({ changes: tr.changes, userEvent: tr.annotation(Transaction.userEvent) ?? "input" });
          } finally {
            forwarding = false;
          }
        }
      }
      v.update(trs);
    },
  });
  boundId = workspace.active.id;
  pane = { view, wrap, handle, orientation };
  col.classList.add("split");
  col.append(handle, wrap);
  wireHandle(col, handle);
  layoutPane();
  workspace.attachSecondary(view, mirror);
}

function layoutPane(): void {
  if (!pane) return;
  const col = pane.wrap.parentElement!;
  col.classList.toggle("split-below", pane.orientation === "below");
  col.style.setProperty("--split", "50%");
}

function wireHandle(col: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = col.getBoundingClientRect();
      const below = col.classList.contains("split-below");
      const f = below ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
      col.style.setProperty("--split", `${Math.max(15, Math.min(85, f * 100))}%`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

export function closeSplit(): void {
  if (!pane) return;
  const col = pane.wrap.parentElement!;
  workspace.detachSecondary();
  pane.view.destroy();
  pane.wrap.remove();
  pane.handle.remove();
  col.classList.remove("split", "split-below");
  col.style.removeProperty("--split");
  pane = null;
  boundId = null;
  workspace.focus();
}

export const toggleSplit = (orientation: "right" | "below"): Promise<void> | void => (pane && pane.orientation === orientation ? closeSplit() : openSplit(orientation));

workspace.on((kind) => {
  if (pane && (kind === "active" || kind === "doc" || kind === "tabs")) void rebind();
  if (pane && kind === "settings" && workspace.active) {
    void extensionsFor().then(() => {
      /* options are applied when the pane is rebuilt on the next tab switch */
    });
  }
});

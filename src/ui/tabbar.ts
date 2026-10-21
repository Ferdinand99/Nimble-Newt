import { workspace, type Doc } from "../app/workspace";
import { h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { basename, dirname, dropIndex } from "../lib/logic";
import { showMenu } from "./menu";
import { toast } from "./toast";

const DRAG_THRESHOLD = 5;

export function initTabbar(): void {
  const host = document.getElementById("tabs")!;
  const newBtn = document.getElementById("new-tab")!;
  newBtn.setAttribute("aria-label", t("cmd.file.new"));
  newBtn.title = t("cmd.file.new");
  newBtn.addEventListener("click", () => workspace.newDoc());

  const render = () => {
    const dupes = new Map<string, number>();
    for (const d of workspace.docs) dupes.set(d.title, (dupes.get(d.title) ?? 0) + 1);
    host.replaceChildren(...workspace.docs.map((d) => tabEl(d, (dupes.get(d.title) ?? 0) > 1)));
    host.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const tabEl = (d: Doc, dup: boolean): HTMLElement => {
    const dirty = workspace.isDirty(d);
    const selected = d.id === workspace.activeId;
    const name = dup && d.path ? `${d.title} — ${basename(dirname(d.path))}` : d.title;
    const el = h("div", {
      class: `tab${dirty ? " dirty" : ""}${d.missing ? " missing" : ""}`,
      role: "tab",
      id: `tab-${d.id}`,
      tabIndex: selected ? 0 : -1,
      "aria-selected": String(selected),
      title: d.path ?? d.title,
      dataset: { id: d.id },
    },
      h("span", { class: `tab-title${d.path ? "" : " untitled"}` }, name),
      dirty ? h("span", { class: "tab-dirty", "aria-label": t("tab.modified") }) : null,
      h("button", { class: "tab-close", type: "button", tabIndex: -1, "aria-label": t("tab.close"), onclick: (e: Event) => { e.stopPropagation(); void workspace.close(d.id); } }, icon("x")),
    );
    el.addEventListener("pointerdown", (e) => onPointerDown(e, el, d));
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) void workspace.close(d.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(
        [
          { label: t("cmd.file.close"), run: () => void workspace.close(d.id) },
          { label: t("cmd.file.closeOthers"), run: () => void workspace.closeOthers(d.id) },
          { label: t("tab.closeRight"), run: () => void workspace.closeRightOf(d.id) },
          { separator: true, label: "" },
          { label: t("tab.copyPath"), run: () => d.path && void navigator.clipboard.writeText(d.path).then(() => toast(t("toast.pathCopied"), "success")) },
        ],
        { x: e.clientX, y: e.clientY },
      );
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void workspace.activate(d.id).then(() => workspace.focus());
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const tabs = [...host.children] as HTMLElement[];
        const n = tabs[(tabs.indexOf(el) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
        n.focus();
      }
    });
    return el;
  };

  /** Pointer-based reordering (HTML5 drag-and-drop is unavailable while native file drops are enabled). */
  const onPointerDown = (e: PointerEvent, el: HTMLElement, d: Doc) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    const startX = e.clientX;
    const tabs = [...host.children] as HTMLElement[];
    const from = tabs.indexOf(el);
    const rects = tabs.map((t) => t.getBoundingClientRect());
    let dragging = false;
    let target = from;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        el.classList.add("dragging");
        el.setPointerCapture(e.pointerId);
        tabs.forEach((t) => t !== el && t.classList.add("shifting"));
      }
      el.style.transform = `translateX(${dx}px)`;
      const others = rects.filter((_, i) => i !== from).map((r) => r.left + r.width / 2);
      const x = rects[from].left + rects[from].width / 2 + dx;
      target = dropIndex(others, x);
      const w = rects[from].width + 2;
      tabs.forEach((t, i) => {
        if (t === el) return;
        const idx = i < from ? i : i - 1; // index among the others
        t.style.transform = idx >= target && i < from ? `translateX(${w}px)` : idx < target && i > from ? `translateX(${-w}px)` : "";
      });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!dragging) {
        if (d.id !== workspace.activeId) void workspace.activate(d.id);
      } else {
        el.classList.remove("dragging");
        tabs.forEach((t) => {
          t.style.transform = "";
          t.classList.remove("shifting");
        });
        if (target !== from) workspace.moveTab(from, target);
        else render();
        workspace.focus();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  host.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) host.scrollLeft += e.deltaY;
  }, { passive: true });

  workspace.on((kind) => {
    if (kind === "tabs" || kind === "active" || kind === "doc") {
      // Cheap path: only refresh the dirty marker while typing.
      if (kind === "doc") {
        const a = workspace.active;
        const el = a && host.querySelector<HTMLElement>(`[data-id="${a.id}"]`);
        if (el && el.classList.contains("dirty") === workspace.isDirty(a)) {
          workspace.updateWindowTitle();
          return;
        }
      }
      render();
      workspace.updateWindowTitle();
    }
  });
  render();
}

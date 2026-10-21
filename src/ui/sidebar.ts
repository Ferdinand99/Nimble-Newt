import { h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { clamp } from "../lib/logic";

export interface Sidebar {
  /** Shows the sidebar with `title` and the content built by `render`. */
  open(title: string, render: (body: HTMLElement) => void | (() => void)): void;
  close(): void;
  isOpen(): boolean;
  readonly el: HTMLElement;
}

const WIDTH_KEY = (side: string) => `nimble.side.${side}`;

function loadWidth(side: string): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY(side)));
    return Number.isFinite(v) && v >= 160 ? v : null;
  } catch {
    return null;
  }
}

/** A resizable panel to the left or right of the editor. Content is supplied lazily by the caller. */
export function createSidebar(side: "left" | "right", onClose?: () => void): Sidebar {
  const el = document.getElementById(`side-${side}`)!;
  const w = loadWidth(side);
  if (w) el.style.setProperty("--side-w", `${w}px`);
  let cleanup: void | (() => void);

  const resize = h("div", { class: "side-resize", role: "separator", "aria-orientation": "vertical", "aria-label": t("side.resize"), tabIndex: 0 });
  const setWidth = (px: number) => {
    const v = clamp(Math.round(px), 160, Math.round(window.innerWidth * 0.6));
    el.style.setProperty("--side-w", `${v}px`);
    try {
      localStorage.setItem(WIDTH_KEY(side), String(v));
    } catch {
      /* a convenience only */
    }
  };
  resize.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    resize.classList.add("active");
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setWidth(side === "left" ? ev.clientX - r.left : r.right - ev.clientX);
    };
    const up = () => {
      resize.classList.remove("active");
      resize.removeEventListener("pointermove", move);
      resize.removeEventListener("pointerup", up);
    };
    resize.addEventListener("pointermove", move);
    resize.addEventListener("pointerup", up);
  });
  resize.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    setWidth(el.getBoundingClientRect().width + dir * 16);
  });

  const api: Sidebar = {
    el,
    isOpen: () => !el.hidden,
    open(title, render) {
      cleanup?.();
      const body = h("div", { class: "side-body" });
      const close = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("common.close"), onclick: () => api.close() }, icon("x"));
      el.replaceChildren(h("div", { class: "side-head" }, h("span", {}, title), close), body, resize);
      el.hidden = false;
      cleanup = render(body);
    },
    close() {
      if (el.hidden) return;
      cleanup?.();
      cleanup = undefined;
      el.hidden = true;
      el.replaceChildren();
      onClose?.();
    },
  };
  return api;
}

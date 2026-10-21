import { h } from "../lib/dom";

export interface MenuEntry {
  label: string;
  run?: () => void;
  checked?: boolean;
  separator?: boolean;
}

let openMenu: { el: HTMLElement; off: () => void } | null = null;

export function closeMenu(): void {
  openMenu?.off();
  openMenu = null;
}

/** Shows a small popover menu anchored above/below `anchor` (or at a point). */
export function showMenu(entries: MenuEntry[], anchor: HTMLElement | { x: number; y: number }): void {
  closeMenu();
  const el = h("ul", { class: "menu", role: "menu" });
  for (const e of entries) {
    if (e.separator) {
      el.append(h("li", { class: "menu-sep", role: "separator" }));
      continue;
    }
    const btn = h("button", {
      class: "menu-item",
      type: "button",
      role: "menuitem",
      "aria-checked": e.checked === undefined ? undefined : String(e.checked),
      onclick: () => {
        closeMenu();
        e.run?.();
      },
    }, h("span", {}, e.label));
    el.append(h("li", {}, btn));
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  let x: number;
  let y: number;
  if ("x" in anchor) {
    x = anchor.x;
    y = anchor.y;
  } else {
    const a = anchor.getBoundingClientRect();
    x = a.left;
    y = a.top - r.height - 4;
    if (y < 8) y = a.bottom + 4;
  }
  x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const buttons = [...el.querySelectorAll<HTMLButtonElement>(".menu-item")];
  buttons[Math.max(0, entries.filter((e) => !e.separator).findIndex((e) => e.checked))]?.focus();
  const onDown = (ev: Event) => {
    if (!el.contains(ev.target as Node)) closeMenu();
  };
  const onKey = (ev: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeMenu();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
  openMenu = {
    el,
    off: () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", closeMenu);
      el.remove();
    },
  };
}

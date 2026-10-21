import { h, icon } from "../lib/dom";

export type ToastKind = "info" | "success" | "warning" | "error";
const ICONS: Record<ToastKind, string> = { info: "info", success: "check-circle", warning: "alert", error: "alert-circle" };

export function toast(message: string, kind: ToastKind = "info", ms = kind === "error" ? 7000 : 3500): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: `toast status-${kind}` }, icon(ICONS[kind]), h("span", { class: "toast-text" }, message));
  host.append(el);
  while (host.children.length > 4) host.firstElementChild?.remove();
  window.setTimeout(() => {
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 250);
  }, ms);
}

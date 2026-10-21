import { h, icon } from "../lib/dom";
import { t } from "../lib/i18n";

export interface Choice<T> {
  value: T;
  label: string;
  kind?: "primary" | "danger" | "plain";
}

/** Opens a modal sheet. Resolves when closed; `Escape` and the backdrop resolve with `dismissValue`. */
export function openSheet<T>(opts: {
  title: string;
  body: Node | Node[];
  choices?: Choice<T>[];
  dismissValue: T;
  alert?: boolean;
  closable?: boolean;
  onOpen?: (dlg: HTMLDialogElement, close: (v: T) => void) => void;
}): Promise<T> {
  return new Promise((resolve) => {
    let result = opts.dismissValue;
    const dlg = h("dialog", { class: `sheet${opts.alert ? " sheet-alert" : ""}`, "aria-labelledby": "sheet-title" });
    const close = (v: T) => {
      result = v;
      dlg.close();
    };
    const head = h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title", id: "sheet-title" }, opts.title));
    if (opts.closable !== false && !opts.alert) {
      head.append(h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("common.close"), onclick: () => close(opts.dismissValue) }, icon("x")));
    }
    const body = h("div", { class: "sheet-body" });
    body.append(...(Array.isArray(opts.body) ? opts.body : [opts.body]));
    dlg.append(head, body);
    if (opts.choices?.length) {
      const foot = h("div", { class: "sheet-foot" });
      opts.choices.forEach((c, i) => {
        const cls = c.kind === "primary" ? "btn btn-primary" : c.kind === "danger" ? "btn btn-danger" : "btn";
        foot.append(h("button", { class: cls, type: "button", autofocus: i === opts.choices!.length - 1 || undefined, onclick: () => close(c.value) }, c.label));
      });
      dlg.append(foot);
    }
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg && opts.closable !== false) close(opts.dismissValue);
    });
    document.body.append(dlg);
    dlg.showModal();
    opts.onOpen?.(dlg, close);
  });
}

export function confirmSheet(title: string, message: string, ok: string, danger = false): Promise<boolean> {
  return openSheet<boolean>({
    title,
    alert: true,
    body: h("p", {}, message),
    dismissValue: false,
    choices: [
      { value: false, label: t("common.cancel") },
      { value: true, label: ok, kind: danger ? "danger" : "primary" },
    ],
  });
}

/** Asks for an integer in [min, max]; resolves `null` when cancelled. */
export function promptNumber(title: string, placeholder: string, min: number, max: number): Promise<number | null> {
  const input = h("input", { class: "input", type: "number", min: String(min), max: String(max), placeholder, "aria-label": title });
  return openSheet<number | null>({
    title,
    alert: true,
    body: input,
    dismissValue: null,
    choices: [
      { value: null, label: t("common.cancel") },
      { value: -1, label: t("common.ok"), kind: "primary" },
    ],
    onOpen: (dlg, close) => {
      input.focus();
      const submit = () => {
        const n = Number.parseInt(input.value, 10);
        close(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      // The primary button resolves -1; turn that into the typed value.
      dlg.querySelector(".btn-primary")?.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        submit();
      }, true);
    },
  });
}

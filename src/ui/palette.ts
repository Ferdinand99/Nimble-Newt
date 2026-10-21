import { fuzzyFilter } from "../lib/logic";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";

export interface PickItem<T> {
  label: string;
  detail?: string;
  shortcut?: string;
  value: T;
}

function highlight(label: string, positions: number[]): Node[] {
  if (!positions.length) return [document.createTextNode(label)];
  const set = new Set(positions);
  const out: Node[] = [];
  let run = "";
  let marked = false;
  const flush = () => {
    if (!run) return;
    out.push(marked ? h("mark", {}, run) : document.createTextNode(run));
    run = "";
  };
  [...label].forEach((ch, i) => {
    const m = set.has(i);
    if (m !== marked) {
      flush();
      marked = m;
    }
    run += ch;
  });
  flush();
  return out;
}

/** Quick-pick list with fuzzy filtering; used by the command palette, quick open and all pickers. */
export function quickPick<T>(items: PickItem<T>[], placeholder: string, opts: { initial?: string; selected?: T } = {}): Promise<T | null> {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "palette", "aria-label": placeholder });
    const input = h("input", { class: "palette-input", type: "text", placeholder, role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list", autocomplete: "off", spellcheck: false, value: opts.initial ?? "" });
    const list = h("ul", { class: "palette-list", id: "palette-list", role: "listbox" });
    dlg.append(input, list);
    let shown: { item: PickItem<T>; positions: number[] }[] = [];
    let index = 0;
    let result: T | null = null;

    const render = () => {
      shown = fuzzyFilter(items, input.value.trim(), (i) => i.label).slice(0, 200);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren();
      if (!shown.length) list.append(h("li", { class: "palette-empty" }, t("palette.noResults")));
      shown.forEach((r, i) => {
        const li = h("li", { class: "palette-item", role: "option", id: `pi-${i}`, "aria-selected": String(i === index) },
          h("span", { class: "palette-label" }, ...highlight(r.item.label, r.positions)),
          r.item.shortcut ? h("kbd", {}, r.item.shortcut) : r.item.detail ? h("span", { class: "palette-detail" }, r.item.detail) : null);
        li.addEventListener("pointermove", () => select(i, false));
        li.addEventListener("click", () => choose(i));
        list.append(li);
      });
      input.setAttribute("aria-activedescendant", shown.length ? `pi-${index}` : "");
    };
    const select = (i: number, scroll = true) => {
      if (!shown.length) return;
      index = (i + shown.length) % shown.length;
      list.querySelectorAll("[aria-selected]").forEach((el, n) => el.setAttribute("aria-selected", String(n === index)));
      input.setAttribute("aria-activedescendant", `pi-${index}`);
      if (scroll) list.children[index]?.scrollIntoView({ block: "nearest" });
    };
    const choose = (i: number) => {
      if (!shown[i]) return;
      result = shown[i].item.value;
      dlg.close();
    };
    input.addEventListener("input", () => {
      index = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      const keys: Record<string, () => void> = {
        ArrowDown: () => select(index + 1),
        ArrowUp: () => select(index - 1),
        Enter: () => choose(index),
        PageDown: () => select(Math.min(shown.length - 1, index + 8)),
        PageUp: () => select(Math.max(0, index - 8)),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    if (opts.selected !== undefined) index = Math.max(0, items.findIndex((i) => i.value === opts.selected));
    render();
    dlg.showModal();
    input.focus();
    input.select();
    list.children[index]?.scrollIntoView({ block: "nearest" });
  });
}

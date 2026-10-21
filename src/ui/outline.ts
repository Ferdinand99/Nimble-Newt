import { h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { extractSymbols, hasSymbols, type OutlineSymbol, type SymbolKind } from "../lib/symbols";
import "../styles/outline.css";

export interface OutlineOptions {
  getText(): string;
  getLangId(): string;
  /** Called with a 1-based line when a symbol is chosen. */
  onJump(line: number): void;
  /** Called when Escape is pressed with an empty filter: give focus back to the editor. */
  onEscape?(): void;
}

export interface OutlinePanel {
  /** Re-reads the document and redraws (keeps the filter). Call it debounced after edits and on tab or language changes. */
  refresh(): void;
  /** Focuses the filter field. */
  focus(): void;
  destroy(): void;
}

const ICONS: Record<SymbolKind, string> = {
  function: "bolt",
  method: "bolt",
  class: "folder",
  struct: "folder",
  enum: "sort",
  interface: "link",
  trait: "link",
  module: "folder",
  type: "tag",
  heading: "menu",
  constant: "dot",
  section: "sliders",
  selector: "tag",
  table: "file",
  variable: "dot",
};

export function createOutlinePanel(host: HTMLElement, opts: OutlineOptions): OutlinePanel {
  let symbols: OutlineSymbol[] = [];
  let shown: OutlineSymbol[] = [];
  let active = 0;
  let filter = "";
  const uid = `outline-${Math.random().toString(36).slice(2, 8)}`;

  const input = h("input", {
    class: "input outline-filter",
    type: "search",
    placeholder: t("outline.filter"),
    "aria-label": t("outline.filter"),
    "aria-controls": `${uid}-list`,
    autocomplete: "off",
    spellcheck: false,
  });
  const list = h("ul", { class: "outline-list", id: `${uid}-list`, role: "listbox", "aria-label": t("outline.title") });
  const empty = h("p", { class: "outline-empty", role: "status" });
  const root = h("div", { class: "outline" }, h("div", { class: "outline-head" }, input), list, empty);
  host.append(root);

  function match(s: OutlineSymbol): boolean {
    return !filter || s.name.toLowerCase().includes(filter);
  }

  function setActive(i: number, scroll = true): void {
    if (shown.length === 0) {
      active = 0;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = Math.max(0, Math.min(shown.length - 1, i));
    list.querySelector('[aria-selected="true"]')?.setAttribute("aria-selected", "false");
    const el = list.children[active] as HTMLElement | undefined;
    if (!el) return;
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  function render(): void {
    shown = symbols.filter(match);
    list.replaceChildren(
      ...shown.map((s, i) =>
        h(
          "li",
          {
            class: `outline-item k-${s.kind}`,
            id: `${uid}-${i}`,
            role: "option",
            "aria-selected": "false",
            title: `${t(`outline.kind.${s.kind}`)} · ${t("outline.line", { n: s.line })}`,
            style: `--lvl:${s.level ?? 0}`,
            onClick: () => opts.onJump(s.line),
            onMouseMove: () => {
              if (active !== i) setActive(i, false);
            },
          },
          icon(ICONS[s.kind], "outline-icon"),
          h("span", { class: "outline-name" }, s.name),
          h("span", { class: "outline-line" }, String(s.line)),
        ),
      ),
    );
    const lang = opts.getLangId();
    if (shown.length > 0) empty.textContent = "";
    else if (!hasSymbols(lang)) empty.textContent = t("outline.unsupported");
    else empty.textContent = symbols.length === 0 ? t("outline.empty") : t("outline.noMatch");
    empty.hidden = shown.length > 0;
    setActive(Math.min(active, shown.length - 1), false);
  }

  const onInput = (): void => {
    filter = input.value.trim().toLowerCase();
    active = 0;
    render();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") setActive(active + 1);
    else if (e.key === "ArrowUp") setActive(active - 1);
    else if (e.key === "PageDown") setActive(active + 8);
    else if (e.key === "PageUp") setActive(active - 8);
    else if (e.key === "Home" && e.ctrlKey) setActive(0);
    else if (e.key === "End" && e.ctrlKey) setActive(shown.length - 1);
    else if (e.key === "Enter") {
      const s = shown[active];
      if (s) opts.onJump(s.line);
    } else if (e.key === "Escape") {
      if (input.value) {
        input.value = "";
        onInput();
      } else opts.onEscape?.();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);

  return {
    refresh() {
      symbols = extractSymbols(opts.getText(), opts.getLangId());
      render();
    },
    focus() {
      input.focus();
      input.select();
    },
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKey);
      root.remove();
    },
  };
}

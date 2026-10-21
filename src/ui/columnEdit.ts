import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import { parseSeqOptions, sequence, type SeqField } from "../lib/numberSequence";
import { openSheet } from "./dialog";

/** Asks what to insert at every cursor / column-selection line: fixed text or a number sequence. */
export async function askColumnEdit(count: number): Promise<string[] | null> {
  const mode = { v: "text" as "text" | "number" };
  const text = h("input", { class: "input", type: "text", "aria-label": t("ce.text"), spellcheck: false });
  const field = (id: string, label: string, value: string, extra: Record<string, unknown> = {}) => {
    const input = h("input", { class: "input mono", type: "text", id: `ce-${id}`, value, inputMode: "numeric", ...extra });
    return { input, row: h("div", { class: "list-row" }, h("label", { class: "list-row-label", for: `ce-${id}` }, label), input) };
  };
  const start = field("start", t("ce.start"), "1");
  const step = field("step", t("ce.step"), "1");
  const repeat = field("repeat", t("ce.repeat"), "1");
  const pad = field("pad", t("ce.pad"), "0");
  const base = h("select", { class: "input", style: "width:auto", "aria-label": t("ce.base") }, ...[10, 16, 8, 2].map((b) => h("option", { value: String(b) }, { 10: t("ce.dec"), 16: t("ce.hex"), 8: t("ce.oct"), 2: t("ce.bin") }[b])));
  const padChar = h("select", { class: "input", style: "width:auto", "aria-label": t("ce.padChar") }, h("option", { value: "0" }, "0"), h("option", { value: " " }, t("ce.space")));
  const preview = h("div", { class: "list-row-hint", "aria-live": "polite" });
  const error = h("div", { class: "list-row-hint", style: "color:var(--bad-text)", role: "alert" });

  const seg = h("div", { class: "segmented", role: "group", "aria-label": t("ce.mode") });
  const numberBox = h("ul", { class: "inset-list" }, start.row, step.row, repeat.row, pad.row,
    h("li", { class: "list-row" }, h("span", { class: "list-row-label" }, t("ce.base")), base),
    h("li", { class: "list-row" }, h("span", { class: "list-row-label" }, t("ce.padChar")), padChar));
  const textBox = h("ul", { class: "inset-list" }, h("li", { class: "list-row" }, text));
  const parse = () =>
    parseSeqOptions({ count: String(Math.max(1, count)), start: start.input.value, step: step.input.value, repeat: repeat.input.value, base: base.value, pad: pad.input.value, padChar: padChar.value });
  const refresh = () => {
    textBox.hidden = mode.v !== "text";
    numberBox.hidden = mode.v !== "number";
    seg.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String((i === 0) === (mode.v === "text"))));
    error.textContent = "";
    preview.textContent = "";
    if (mode.v !== "number") return;
    const p = parse();
    if (!p.ok) {
      error.textContent = t(`ce.err.${p.error}`, { field: t(`ce.f.${p.field}`) });
      return;
    }
    preview.textContent = sequence(Math.min(4, p.count), p.options).join(", ") + (count > 4 ? ", …" : "");
  };
  for (const [m, label] of [["text", t("ce.modeText")], ["number", t("ce.modeNumber")]] as const) {
    seg.append(h("button", { type: "button", onclick: () => { mode.v = m; refresh(); } }, label));
  }
  for (const el of [start.input, step.input, repeat.input, pad.input, base, padChar]) el.addEventListener("input", refresh);

  const body = [h("p", {}, t("ce.intro", { n: count })), h("div", {}, seg), h("div", { style: "height:10px" }), textBox, numberBox, preview, error];
  refresh();
  const ok = await openSheet<boolean>({
    title: t("cmd.edit.columnEdit"),
    body,
    dismissValue: false,
    choices: [
      { value: false, label: t("common.cancel") },
      { value: true, label: t("common.apply"), kind: "primary" },
    ],
    onOpen: () => (mode.v === "text" ? text : start.input).focus(),
  });
  if (!ok) return null;
  if (mode.v === "text") return Array.from({ length: count }, () => text.value);
  const p = parse();
  if (!p.ok) return null;
  return sequence(count, p.options);
}

export type { SeqField };

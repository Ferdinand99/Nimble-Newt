import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { changeCase, collapseBlankLines, joinLines, keepOnlyDuplicates, numberLines, prefixLines, removeDuplicateLines, removeEmptyLines, reverseLines, shuffleLines, sortLines, splitLines, suffixLines, trimLines, type CaseMode } from "../lib/lineOps";
import { t } from "../lib/i18n";
import { promptNumber, promptText } from "../ui/dialog";
import { toast } from "../ui/toast";
import { workspace } from "./workspace";

type LinesFn = (lines: string[]) => string[];

/** Applies `fn` to the lines of the selection (or the whole document when nothing is selected). */
function onLines(fn: LinesFn): void {
  const v: EditorView = workspace.focusedView();
  const st = v.state;
  const m = st.selection.main;
  const from = m.empty ? 0 : st.doc.lineAt(m.from).from;
  // A selection that ends at the very start of a line does not include that line.
  const endPos = !m.empty && m.to > m.from && st.doc.lineAt(m.to).from === m.to ? m.to - 1 : m.to;
  const to = m.empty ? st.doc.length : st.doc.lineAt(endPos).to;
  const before = st.sliceDoc(from, to);
  const after = fn(before.split("\n")).join("\n");
  if (after === before) return void toast(t("lineop.noText"), "info");
  v.dispatch({ changes: { from, to, insert: after }, userEvent: "input.lineops" });
  toast(t("lineop.done", { n: before.split("\n").length }), "info");
  workspace.focus();
}

/** Applies `fn` to each selected range (text transformations such as case changes). */
function onSelection(fn: (s: string) => string): void {
  const v = workspace.focusedView();
  if (v.state.selection.ranges.every((r) => r.empty)) return void toast(t("lineop.selectFirst"), "info");
  v.dispatch(
    v.state.changeByRange((r) => {
      if (r.empty) return { range: r };
      const out = fn(v.state.sliceDoc(r.from, r.to));
      return { changes: { from: r.from, to: r.to, insert: out }, range: EditorSelection.range(r.from, r.from + out.length) };
    }),
    { userEvent: "input.lineops" },
  );
  workspace.focus();
}

const locale = () => (document.documentElement.lang === "nb" ? "nb" : undefined);
const caseOp = (mode: CaseMode) => () => onSelection((s) => changeCase(s, mode));

export const lineOpHandlers: Record<string, () => void | Promise<void>> = {
  "lineop.sortAsc": () => onLines((l) => sortLines(l, { order: "asc", caseSensitive: true, locale: locale() })),
  "lineop.sortDesc": () => onLines((l) => sortLines(l, { order: "desc", caseSensitive: true, locale: locale() })),
  "lineop.sortAscCI": () => onLines((l) => sortLines(l, { order: "asc", caseSensitive: false, locale: locale() })),
  "lineop.sortNumeric": () => onLines((l) => sortLines(l, { order: "asc", numeric: true, locale: locale() })),
  "lineop.sortNumericDesc": () => onLines((l) => sortLines(l, { order: "desc", numeric: true, locale: locale() })),
  "lineop.reverse": () => onLines((l) => reverseLines(l)),
  "lineop.shuffle": () => onLines((l) => shuffleLines(l)),
  "lineop.dedupe": () => onLines((l) => removeDuplicateLines(l, { mode: "all", caseSensitive: true })),
  "lineop.dedupeConsecutive": () => onLines((l) => removeDuplicateLines(l, { mode: "consecutive", caseSensitive: true })),
  "lineop.keepDuplicates": () => onLines((l) => keepOnlyDuplicates(l)),
  "lineop.removeEmpty": () => onLines((l) => removeEmptyLines(l)),
  "lineop.removeBlank": () => onLines((l) => removeEmptyLines(l, { blankToo: true })),
  "lineop.collapseBlank": () => onLines((l) => collapseBlankLines(l)),
  "lineop.trimLeading": () => onLines((l) => trimLines(l, "leading")),
  "lineop.trimBoth": () => onLines((l) => trimLines(l, "both")),
  "lineop.join": () => onLines((l) => [joinLines(l)]),
  "lineop.splitAt": async () => {
    const n = await promptNumber(t("lineop.splitWidth"), t("lineop.splitRange"), 10, 1000);
    if (n !== null) onLines((l) => splitLines(l.join("\n"), { width: n }));
  },
  "lineop.numberLines": () => onLines((l) => numberLines(l, { start: 1, step: 1, separator: " " })),
  "lineop.prefix": async () => {
    const s = await promptText(t("lineop.prefixTitle"), t("lineop.textPlaceholder"));
    if (s) onLines((l) => prefixLines(l, s));
  },
  "lineop.suffix": async () => {
    const s = await promptText(t("lineop.suffixTitle"), t("lineop.textPlaceholder"));
    if (s) onLines((l) => suffixLines(l, s));
  },
  "edit.upperCase": () => onSelection((s) => s.toUpperCase()),
  "edit.lowerCase": () => onSelection((s) => s.toLowerCase()),
  "lineop.titleCase": caseOp("title"),
  "lineop.sentenceCase": caseOp("sentence"),
  "lineop.invertCase": caseOp("invert"),
  "lineop.camelCase": caseOp("camel"),
  "lineop.snakeCase": caseOp("snake"),
  "lineop.kebabCase": caseOp("kebab"),
  "lineop.pascalCase": caseOp("pascal"),
};

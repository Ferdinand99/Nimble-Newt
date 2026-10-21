import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, deleteLine, history, indentWithTab, insertBlankLine, moveLineDown, moveLineUp, copyLineDown, toggleComment, toggleBlockComment, undo, redo } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, search, selectNextOccurrence } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import type { LanguageDef } from "../lib/languages";
import { addCursorAbove, addCursorBelow, columnSelect } from "./commands";
import { createFindPanel } from "./findpanel";
import { highlighting } from "./theme";
import { whitespace } from "./whitespace";

export interface ViewOptions {
  wrap: boolean;
  whitespace: boolean;
  indent: { useTabs: boolean; size: number };
}

export const compartments = {
  language: new Compartment(),
  wrap: new Compartment(),
  whitespace: new Compartment(),
  indent: new Compartment(),
};

let updateHandler: (u: import("@codemirror/view").ViewUpdate) => void = () => {};
export function onEditorUpdate(fn: typeof updateHandler): void {
  updateHandler = fn;
}

const editorKeymap = keymap.of([
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Mod-/", run: toggleComment, preventDefault: true },
  { key: "Mod-Shift-a", run: toggleBlockComment, preventDefault: true },
  { key: "Alt-ArrowUp", run: moveLineUp, preventDefault: true },
  { key: "Alt-ArrowDown", run: moveLineDown, preventDefault: true },
  { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true },
  { key: "Mod-Shift-k", run: deleteLine, preventDefault: true },
  { key: "Mod-Enter", run: insertBlankLine, preventDefault: true },
  { key: "Mod-Alt-ArrowUp", run: addCursorAbove, preventDefault: true },
  { key: "Mod-Alt-ArrowDown", run: addCursorBelow, preventDefault: true },
  { key: "Alt-Shift-ArrowUp", run: columnSelect(0, -1), preventDefault: true },
  { key: "Alt-Shift-ArrowDown", run: columnSelect(0, 1), preventDefault: true },
  { key: "Alt-Shift-ArrowLeft", run: columnSelect(-1, 0), preventDefault: true },
  { key: "Alt-Shift-ArrowRight", run: columnSelect(1, 0), preventDefault: true },
  indentWithTab,
]);

const base: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  highlighting,
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  rectangularSelection(),
  crosshairCursor(),
  search({ top: true, createPanel: createFindPanel }),
  editorKeymap,
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...foldKeymap]),
  EditorView.updateListener.of((u) => updateHandler(u)),
  EditorView.contentAttributes.of({ "aria-label": "Editor", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
];

export function indentExtension(i: ViewOptions["indent"]): Extension {
  return [EditorState.tabSize.of(i.size), indentUnit.of(i.useTabs ? "\t" : " ".repeat(i.size))];
}

export function languageExtension(def: LanguageDef, support: Extension): Extension {
  const tokens = def.comment ? { commentTokens: { line: def.comment.line, block: def.comment.block && { open: def.comment.block[0], close: def.comment.block[1] } } } : null;
  return [support, tokens ? EditorState.languageData.of(() => [tokens]) : []];
}

export function dynamicExtensions(o: ViewOptions, lang: Extension = []): Extension[] {
  return [
    compartments.language.of(lang),
    compartments.wrap.of(o.wrap ? EditorView.lineWrapping : []),
    compartments.whitespace.of(o.whitespace ? whitespace : []),
    compartments.indent.of(indentExtension(o.indent)),
  ];
}

export function makeState(doc: string | Text, o: ViewOptions, lang: Extension = [], selection?: { anchor: number; head: number }): EditorState {
  const length = typeof doc === "string" ? doc.length : doc.length;
  const sel = selection ? EditorSelection.single(Math.min(selection.anchor, length), Math.min(selection.head, length)) : undefined;
  return EditorState.create({ doc, selection: sel, extensions: [base, dynamicExtensions(o, lang)] });
}

export function reconfigureEffects(o: ViewOptions) {
  return [
    compartments.wrap.reconfigure(o.wrap ? EditorView.lineWrapping : []),
    compartments.whitespace.reconfigure(o.whitespace ? whitespace : []),
    compartments.indent.reconfigure(indentExtension(o.indent)),
  ];
}

export { undo, redo };
export type { LanguageSupport };

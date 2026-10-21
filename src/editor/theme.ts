import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Colours are CSS variables (see --syn-* in style.css) so the editor follows light/dark and contrast settings.
const style = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: [t.tagName, t.angleBracket, t.invalid], color: "var(--syn-tag)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: "var(--syn-property)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-operator)" },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], color: "var(--syn-meta)" },
  { tag: t.heading, color: "var(--brand)", fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--brand)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.inserted, color: "var(--syn-string)" },
  { tag: t.deleted, color: "var(--syn-tag)" },
]);

export const highlighting = syntaxHighlighting(style);

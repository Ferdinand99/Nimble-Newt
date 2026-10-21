import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const space = Decoration.mark({ class: "cm-ws-space" });
const tab = Decoration.mark({ class: "cm-ws-tab" });
const matcher = new MatchDecorator({
  regexp: /[ \t]+/g,
  decoration: (m) => (m[0][0] === "\t" ? tab : space),
});

/** Draws spaces as dots and tabs as lines (CSS in style.css). */
export const whitespace = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = matcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

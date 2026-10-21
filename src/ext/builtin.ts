import type { Permission } from "./protocol";

export interface BuiltinManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: Permission[];
  commands: { id: string; title: string; titleNb: string }[];
}

export interface BuiltinExtension {
  manifest: BuiltinManifest;
  code: string;
}

// The scripts below are ordinary extensions: they only use the public `nimble` API inside the sandbox.
export const BUILTIN: BuiltinExtension[] = [
  {
    manifest: {
      id: "app.wordcount",
      name: "Word Count",
      version: "1.0.0",
      description: "Counts words, characters and lines in the selection or the document.",
      author: "Nimble Newt",
      permissions: ["editor.read", "ui"],
      commands: [{ id: "count", title: "Word Count", titleNb: "Ordtelling" }],
    },
    code: `
nimble.commands.register("count", async (ctx) => {
  const nb = ctx.locale === "nb";
  const sel = await nimble.editor.getSelection();
  const text = sel.text.length ? sel.text : await nimble.editor.getText();
  const words = (text.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}'’_-]*/gu) || []).length;
  const lines = text.length ? text.split("\\n").length : 0;
  const part = nb ? (sel.text.length ? " (markeringen)" : "") : (sel.text.length ? " (selection)" : "");
  await nimble.ui.message(nb
    ? words + " ord, " + text.length + " tegn, " + lines + " linjer" + part
    : words + " words, " + text.length + " characters, " + lines + " lines" + part, "info");
});`,
  },
  {
    manifest: {
      id: "app.markdown",
      name: "Markdown Helpers",
      version: "1.0.0",
      description: "Bold, italic, code, link and quote for the selection.",
      author: "Nimble Newt",
      permissions: ["editor.read", "editor.write", "ui"],
      commands: [
        { id: "bold", title: "Markdown: Bold", titleNb: "Markdown: Fet" },
        { id: "italic", title: "Markdown: Italic", titleNb: "Markdown: Kursiv" },
        { id: "code", title: "Markdown: Inline Code", titleNb: "Markdown: Kode i linjen" },
        { id: "link", title: "Markdown: Link…", titleNb: "Markdown: Lenke …" },
        { id: "quote", title: "Markdown: Blockquote", titleNb: "Markdown: Sitatblokk" },
      ],
    },
    code: `
async function wrap(mark) {
  const { text } = await nimble.editor.getSelection();
  if (!text) return;
  const done = text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark);
  await nimble.editor.replaceSelection(done ? text.slice(mark.length, -mark.length) : mark + text + mark);
}
nimble.commands.register("bold", () => wrap("**"));
nimble.commands.register("italic", () => wrap("*"));
nimble.commands.register("code", () => wrap("\`"));
nimble.commands.register("link", async (ctx) => {
  const { text } = await nimble.editor.getSelection();
  if (!text) return;
  const url = await nimble.ui.prompt({ title: ctx.locale === "nb" ? "Lenkeadresse" : "Link address", placeholder: "https://" });
  if (url) await nimble.editor.replaceSelection("[" + text + "](" + url + ")");
});
nimble.commands.register("quote", async () => {
  const { text } = await nimble.editor.getSelection();
  if (!text) return;
  const quoted = text.split("\\n").map((l) => "> " + l).join("\\n");
  await nimble.editor.replaceSelection(quoted);
});`,
  },
  {
    manifest: {
      id: "app.textcleaner",
      name: "Text Cleaner",
      version: "1.0.0",
      description: "Slugify the selection, straighten smart quotes and collapse spaces.",
      author: "Nimble Newt",
      permissions: ["editor.read", "editor.write"],
      commands: [
        { id: "slugify", title: "Text Cleaner: Slugify Selection", titleNb: "Tekstrydding: Lag URL-vennlig tekst" },
        { id: "straighten", title: "Text Cleaner: Straighten Quotes", titleNb: "Tekstrydding: Rette ut anførselstegn" },
        { id: "collapse", title: "Text Cleaner: Collapse Spaces", titleNb: "Tekstrydding: Slå sammen mellomrom" },
      ],
    },
    code: `
async function onSelection(fn) {
  const { text } = await nimble.editor.getSelection();
  const target = text || (await nimble.editor.getText());
  const out = fn(target);
  if (text) await nimble.editor.replaceSelection(out); else await nimble.editor.replaceAll(out);
}
nimble.commands.register("slugify", () => onSelection((s) =>
  s.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/æ/gi, "ae").replace(/ø/gi, "o").replace(/å/gi, "a")
   .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")));
nimble.commands.register("straighten", () => onSelection((s) =>
  s.replace(/[\\u2018\\u2019\\u201A\\u2032]/g, "'").replace(/[\\u201C\\u201D\\u201E\\u2033]/g, '"').replace(/[\\u2013\\u2014]/g, "-").replace(/\\u2026/g, "...")));
nimble.commands.register("collapse", () => onSelection((s) =>
  s.split("\\n").map((l) => l.replace(/[ \\t]{2,}/g, " ").replace(/[ \\t]+$/, "")).join("\\n")));`,
  },
];


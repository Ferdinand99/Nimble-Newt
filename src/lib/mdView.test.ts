import { describe, expect, it } from "vitest";
import { allowedInReadView, effectiveMdView, isMarkdownDoc, nextMdView, parseMdView, renderDelay } from "./mdView";

describe("Markdown views", () => {
  it("reads stored views defensively", () => {
    expect(parseMdView("split")).toBe("split");
    expect(parseMdView("read")).toBe("read");
    for (const v of ["edit", "READ", "preview", null, undefined, 3, {}]) expect(parseMdView(v)).toBe("edit");
  });

  it("toggles like VS Code: Ctrl+Shift+V for Read, Ctrl+K V for Split", () => {
    expect(nextMdView("edit", "toggleRead")).toBe("read");
    expect(nextMdView("read", "toggleRead")).toBe("edit");
    expect(nextMdView("split", "toggleRead")).toBe("read");
    expect(nextMdView("edit", "toggleSplit")).toBe("split");
    expect(nextMdView("split", "toggleSplit")).toBe("edit");
    expect(nextMdView("read", "toggleSplit")).toBe("split");
    expect(nextMdView("read", "edit")).toBe("edit");
    expect(nextMdView("edit", "split")).toBe("split");
  });

  it("applies only to Markdown tabs that are not in the large-file viewer", () => {
    const md = { langId: "markdown", large: null, mdView: "read" as const };
    expect(isMarkdownDoc(md)).toBe(true);
    expect(effectiveMdView(md)).toBe("read");
    expect(effectiveMdView({ ...md, langId: "plaintext" })).toBe("edit");
    expect(effectiveMdView({ ...md, large: {} })).toBe("edit");
    expect(effectiveMdView(null)).toBe("edit");
  });

  it("keeps each tab's own view", () => {
    const a = { langId: "markdown", large: null, mdView: "edit" as "edit" | "split" | "read" };
    const b = { ...a };
    a.mdView = nextMdView(a.mdView, "toggleRead");
    b.mdView = nextMdView(b.mdView, "toggleSplit");
    expect([effectiveMdView(a), effectiveMdView(b)]).toEqual(["read", "split"]);
  });

  it("refuses commands that change the text in the read view", () => {
    for (const id of ["file.save", "view.zoomIn", "markdown.toggleRead", "app.settings", "doc.language", "doc.encoding", "compare.withTab", "tools.panel"]) expect(allowedInReadView(id), id).toBe(true);
    for (const id of ["edit.undo", "edit.deleteLine", "lineop.sortAsc", "bookmark.cut", "macro.play", "tools.base64Encode", "doc.indent", "highlight.1"]) expect(allowedInReadView(id), id).toBe(false);
  });

  it("waits longer for long documents and slow renders", () => {
    expect(renderDelay(1_000, 0)).toBe(120);
    expect(renderDelay(1_000_000, 0)).toBe(500);
    expect(renderDelay(1_000, 400)).toBe(800);
    expect(renderDelay(50_000_000, 5_000)).toBe(1500);
  });
});

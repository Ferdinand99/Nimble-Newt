import { describe, expect, it } from "vitest";
import { classifyImage, classifyLink, resolveRelative, slugify } from "./mdLinks";

describe("classifyLink", () => {
  it("opens web and mail links outside the app", () => {
    expect(classifyLink("https://example.com/a?b#c")).toEqual({ kind: "external", url: "https://example.com/a?b#c" });
    expect(classifyLink("HTTP://example.com")).toEqual({ kind: "external", url: "HTTP://example.com" });
    expect(classifyLink("mailto:a@example.com")).toEqual({ kind: "external", url: "mailto:a@example.com" });
    expect(classifyLink("//example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
  });

  it("refuses script, data, file and unknown schemes, however they are written", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", "vbscript:x", "data:text/html,x", "data:image/png;base64,AAAA", "file:///etc/passwd", "ms-settings:", "tel:123", "C:\\notes.md", "c:/notes.md"]) {
      expect(classifyLink(href), JSON.stringify(href)).toEqual({ kind: "blocked" });
    }
  });

  it("follows links to Markdown files and anchors, nothing else local", () => {
    expect(classifyLink("other.md")).toEqual({ kind: "markdown", path: "other.md", fragment: "" });
    expect(classifyLink("docs/My%20Notes.markdown#Part%201")).toEqual({ kind: "markdown", path: "docs/My Notes.markdown", fragment: "Part 1" });
    expect(classifyLink("../README.MD?plain=1")).toEqual({ kind: "markdown", path: "../README.MD", fragment: "" });
    expect(classifyLink("#install")).toEqual({ kind: "anchor", id: "install" });
    expect(classifyLink("notes.txt")).toEqual({ kind: "blocked" });
    expect(classifyLink("/etc/passwd.md")).toEqual({ kind: "blocked" });
    expect(classifyLink("\\\\server\\share\\a.md")).toEqual({ kind: "blocked" });
    expect(classifyLink("bad%zz.md")).toEqual({ kind: "blocked" });
    expect(classifyLink("")).toEqual({ kind: "blocked" });
    expect(classifyLink(null)).toEqual({ kind: "blocked" });
  });
});

describe("classifyImage", () => {
  it("separates data, remote, local and refused images", () => {
    expect(classifyImage("data:image/png;base64,AAAA")).toEqual({ kind: "data", src: "data:image/png;base64,AAAA" });
    expect(classifyImage("data:image/svg+xml,<svg/>").kind).toBe("data");
    expect(classifyImage("data:text/html,<b>")).toEqual({ kind: "blocked" });
    expect(classifyImage("https://example.com/a.png")).toEqual({ kind: "remote", url: "https://example.com/a.png" });
    expect(classifyImage("//example.com/a.png")).toEqual({ kind: "remote", url: "https://example.com/a.png" });
    expect(classifyImage("img/a%20b.png?x=1#y")).toEqual({ kind: "local", path: "img/a b.png" });
    expect(classifyImage("../../secret.png")).toEqual({ kind: "local", path: "../../secret.png" });
    for (const src of ["/etc/passwd", "\\\\server\\x.png", "file:///etc/passwd", "javascript:alert(1)", "C:/x.png", "", null]) {
      expect(classifyImage(src), String(src)).toEqual({ kind: "blocked" });
    }
  });
});

describe("resolveRelative", () => {
  it("joins against the document's folder and folds . and ..", () => {
    expect(resolveRelative("/home/u/docs/readme.md", "other.md")).toBe("/home/u/docs/other.md");
    expect(resolveRelative("/home/u/docs/readme.md", "./a/../b/c.md")).toBe("/home/u/docs/b/c.md");
    expect(resolveRelative("/home/u/docs/readme.md", "../../x.md")).toBe("/home/x.md");
    expect(resolveRelative("C:\\Users\\u\\readme.md", "notes/a.md")).toBe("C:\\Users\\u\\notes\\a.md");
    expect(resolveRelative("C:\\Users\\u\\readme.md", "..\\..\\x.md")).toBe("C:\\x.md");
  });
  it("refuses to climb above the root", () => {
    expect(resolveRelative("/a/readme.md", "../../../x.md")).toBeNull();
    expect(resolveRelative("C:\\readme.md", "..\\x.md")).toBeNull();
  });
});

describe("slugify", () => {
  it("makes GitHub-style anchors", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Café  au lait ")).toBe("café--au-lait");
    expect(slugify("API_v2 - notes")).toBe("api_v2---notes");
  });
});

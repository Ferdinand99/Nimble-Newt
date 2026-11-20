// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { sanitizeMarkdown } from "./mdSanitize";

function clean(md: string) {
  const out = sanitizeMarkdown(renderMarkdown(md));
  const div = document.createElement("div");
  div.append(out.fragment);
  return { div, html: div.innerHTML, remote: out.remoteImages, local: out.localImages };
}

/** Every attribute of every element, for "nothing like this survived" checks. */
const attrs = (div: HTMLElement): string[] => [...div.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => `${a.name}=${a.value}`));

describe("sanitizeMarkdown", () => {
  it("removes script elements, also nested or split oddly", () => {
    const { div, html } = clean("<script>alert(1)</script>\n\nText <script src=x.js></script>\n\n<div><scr<script>ipt>alert(2)</script></div>\n\n<SCRIPT>alert(3)</SCRIPT>");
    expect(div.querySelector("script")).toBeNull();
    expect(html).not.toMatch(/<script/i);
  });

  it("removes event handlers such as onerror and onclick", () => {
    const { div } = clean('<img src="x.png" onerror="alert(1)">\n\n<p onclick="alert(2)" onmouseover="alert(3)">hi</p>\n\n<a href="https://a.example" onfocus="alert(4)">a</a>');
    expect(attrs(div).filter((a) => a.startsWith("on"))).toEqual([]);
  });

  it("refuses javascript:, vbscript:, data: and file: links", () => {
    const md = [
      "[a](javascript:alert(1))",
      '<a href="javascript:alert(2)">b</a>',
      '<a href="JaVaScRiPt:alert(3)">c</a>',
      '<a href="java&#x09;script:alert(4)">d</a>',
      '<a href=" javascript:alert(5)">e</a>',
      '<a href="vbscript:msgbox(1)">f</a>',
      '<a href="data:text/html,<script>alert(6)</script>">g</a>',
      '<a href="file:///etc/passwd">h</a>',
      '<a href="ms-settings:">i</a>',
    ].join("\n\n");
    const { div, html } = clean(md);
    // markdown-it does not even make a link of the first one; the others lose their href.
    const links = [...div.querySelectorAll("a")];
    expect(links.length).toBe(8);
    for (const a of links) {
      expect(a.getAttribute("href"), a.outerHTML).toBeNull();
      expect(a.dataset.mdLink ?? "blocked").toBe("blocked");
    }
    expect(html).not.toMatch(/href=/i);
  });

  it("marks web, mail, anchor and Markdown links for the view", () => {
    const { div } = clean("[w](https://example.com/x) [m](mailto:a@example.com) [h](#intro) [n](other.md#part) [p](../up/notes.markdown) [t](notes.txt) [abs](/etc/x.md)");
    const kinds = [...div.querySelectorAll("a")].map((a) => [a.dataset.mdLink, a.dataset.mdHref ?? null]);
    expect(kinds).toEqual([
      ["external", "https://example.com/x"],
      ["external", "mailto:a@example.com"],
      ["anchor", "intro"],
      ["markdown", "other.md#part"],
      ["markdown", "../up/notes.markdown"],
      ["blocked", null],
      ["blocked", null],
    ]);
  });

  it("holds remote images back until the user allows them", () => {
    const { div, remote, local } = clean('![a](https://example.com/a.png)\n\n<img src="http://example.com/b.gif">\n\n<img src="//cdn.example.com/c.png">\n\n![d](d.png)');
    const imgs = [...div.querySelectorAll("img")];
    expect(imgs.every((i) => !i.hasAttribute("src"))).toBe(true);
    expect(imgs.map((i) => i.getAttribute("data-md-remote"))).toEqual(["https://example.com/a.png", "http://example.com/b.gif", "https://cdn.example.com/c.png", null]);
    expect(remote).toBe(3);
    expect(local).toBe(1);
    expect(attrs(div).some((a) => /srcset|loading|referrerpolicy/.test(a))).toBe(false);
  });

  it("removes srcset and picture sources, which would load images by themselves", () => {
    const { div } = clean('<img srcset="https://example.com/a.png 2x" alt="x">\n\n<picture><source srcset="https://example.com/b.png"><img alt="y"></picture>');
    expect(div.querySelector("source")).toBeNull();
    expect(attrs(div).some((a) => a.includes("example.com"))).toBe(false);
  });

  it("keeps data: images, but only image types", () => {
    const { div } = clean('<img src="data:image/png;base64,iVBORw0KGgo=">\n\n<img src="data:text/html;base64,PHNjcmlwdD4=">');
    const imgs = div.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(imgs[1].hasAttribute("src")).toBe(false);
  });

  it("passes local paths on as they are; the backend refuses traversal", () => {
    const { div } = clean("![x](../../secret.png)\n\n![y](img/../../../etc/passwd)\n\n![z](/etc/passwd)\n\n![w](C:/Windows/win.ini)\n\n<img src=\"file:///etc/passwd\">");
    const imgs = [...div.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("data-md-local"))).toEqual(["../../secret.png", "img/../../../etc/passwd", null, null, null]);
    expect(imgs.slice(2).every((i) => i.hasAttribute("data-md-blocked"))).toBe(true);
    expect(imgs.every((i) => !i.hasAttribute("src"))).toBe(true);
  });

  it("removes frames, objects, forms, media, SVG, MathML, styles and base", () => {
    const md = [
      '<iframe src="https://example.com"></iframe>',
      '<object data="x.swf"></object><embed src="x.swf">',
      '<form action="https://example.com"><input name="q"><button>go</button><textarea></textarea></form>',
      '<video src="https://example.com/v.mp4"></video><audio src="a.mp3"></audio>',
      '<svg><script>alert(1)</script><a xlink:href="javascript:alert(2)">x</a></svg>',
      "<math><mi>x</mi></math>",
      "<style>body { display: none }</style>",
      '<link rel="stylesheet" href="https://example.com/x.css"><base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com">',
      '<p style="position: fixed; inset: 0; z-index: 99999">cover</p>',
    ].join("\n\n");
    const { div } = clean(md);
    for (const tag of ["iframe", "object", "embed", "form", "button", "textarea", "video", "audio", "svg", "math", "style", "link", "base", "meta", "script"]) {
      expect(div.querySelector(tag), tag).toBeNull();
    }
    expect(attrs(div).filter((a) => a.startsWith("style="))).toEqual([]);
    // What is left of the form's input is a disabled checkbox without a name.
    for (const i of div.querySelectorAll("input")) {
      expect(i.type).toBe("checkbox");
      expect(i.disabled).toBe(true);
      expect(i.hasAttribute("name")).toBe(false);
    }
  });

  it("keeps only the class names the renderer writes", () => {
    const { div } = clean('<div class="sheet toast language-js task-list-item">x</div>\n\n<p class="statusbar">y</p>');
    expect(div.querySelector("div")!.className).toBe("language-js task-list-item");
    expect(div.querySelector("p")!.hasAttribute("class")).toBe(false);
  });

  it("drops data-md-* attributes written in the document, so it cannot fake links or images", () => {
    const { div } = clean('<a data-md-link="external" data-md-href="https://evil.example">x</a>\n\n<img data-md-local="../../secret.png" alt="y">');
    expect(div.querySelector("a")!.hasAttribute("data-md-href")).toBe(false);
    expect(div.querySelector("img")!.hasAttribute("data-md-local")).toBe(false);
  });

  it("removes target, tabindex, autofocus and contenteditable, and prefixes ids and names", () => {
    const { div } = clean('<a href="https://example.com" target="_top" ping="https://t.example">a</a>\n\n<div id="app" name="x" tabindex="1" autofocus contenteditable>b</div>');
    const a = div.querySelector("a")!;
    expect(a.hasAttribute("target")).toBe(false);
    expect(a.hasAttribute("ping")).toBe(false);
    const d = div.querySelector("div")!;
    expect(d.id).toBe("user-content-app");
    expect(["tabindex", "autofocus", "contenteditable"].some((n) => d.hasAttribute(n))).toBe(false);
  });

  it("keeps harmless HTML that people use in READMEs", () => {
    const { div } = clean('<details><summary>More</summary>\n\nHidden *text*\n\n</details>\n\n<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> <abbr title="HyperText">HTML</abbr>\n\n<p align="center"><b>centered</b></p>');
    expect(div.querySelector("details summary")?.textContent).toBe("More");
    expect(div.querySelector("kbd")?.textContent).toBe("Ctrl");
    expect(div.querySelector("sub")?.textContent).toBe("2");
    expect(div.querySelector("abbr")?.getAttribute("title")).toBe("HyperText");
    expect(div.querySelector("p[align=center] b")?.textContent).toBe("centered");
  });
});

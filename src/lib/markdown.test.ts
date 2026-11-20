// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fenceLanguage, renderChunks, renderMarkdown } from "./markdown";
import { sanitizeMarkdown } from "./mdSanitize";

/** Renders and sanitises, like the view does, and returns a container to query. */
function view(src: string): HTMLElement {
  const div = document.createElement("div");
  div.append(sanitizeMarkdown(renderMarkdown(src)).fragment);
  return div;
}

describe("renderMarkdown (CommonMark + GFM)", () => {
  it("renders headings with GitHub-style ids, made unique", () => {
    const d = view("# Hello World!\n\n## Hello World!\n\n### Ünïcode `code`");
    const ids = [...d.querySelectorAll("h1, h2, h3")].map((h) => h.id);
    // The sanitiser prefixes ids so they cannot clobber globals of the app.
    expect(ids).toEqual(["user-content-hello-world", "user-content-hello-world-1", "user-content-ünïcode-code"]);
  });

  it("renders tables", () => {
    const d = view("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    expect(d.querySelectorAll("table th")).toHaveLength(2);
    expect([...d.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["1", "2"]);
  });

  it("renders task lists as disabled checkboxes", () => {
    const d = view("- [x] done\n- [ ] todo\n- [link](x.md) not a task\n");
    const boxes = [...d.querySelectorAll<HTMLInputElement>("input")];
    expect(boxes.map((b) => [b.type, b.disabled, b.checked])).toEqual([
      ["checkbox", true, true],
      ["checkbox", true, false],
    ]);
    expect(d.querySelector("ul")!.className).toBe("contains-task-list");
    expect(d.querySelectorAll("li.task-list-item")).toHaveLength(2);
    expect(d.querySelectorAll("li")[0].textContent).toBe(" done");
  });

  it("renders strikethrough, emphasis, quotes and lists", () => {
    const d = view("~~gone~~ *em* **strong**\n\n> quote\n\n1. one\n2. two\n");
    expect(d.querySelector("s")?.textContent).toBe("gone");
    expect(d.querySelector("em")?.textContent).toBe("em");
    expect(d.querySelector("strong")?.textContent).toBe("strong");
    expect(d.querySelector("blockquote")?.textContent?.trim()).toBe("quote");
    expect(d.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("turns bare URLs and <autolinks> into links", () => {
    const d = view("See https://example.com/a and <https://example.org> and www.example.net.");
    expect([...d.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a", "https://example.org", "http://www.example.net"]);
  });

  it("keeps the language of fenced code and escapes its content", () => {
    const d = view("```TypeScript title\nconst a = '<b>';\n```\n\n```\nplain\n```");
    const code = d.querySelectorAll("pre > code");
    expect(code[0].getAttribute("data-lang")).toBe("typescript");
    expect(code[0].className).toBe("language-typescript");
    expect(code[0].textContent).toBe("const a = '<b>';\n");
    expect(d.querySelector("b")).toBeNull();
    expect(code[1].hasAttribute("data-lang")).toBe(false);
  });

  it("marks block elements with their source line for scrolling", () => {
    const d = view("# A\n\npara\n\n- x\n\n```\ncode\n```\n");
    expect([...d.querySelectorAll("[data-line]")].map((e) => `${e.tagName}:${e.getAttribute("data-line")}`)).toEqual(["H1:0", "P:2", "UL:4", "LI:4", "PRE:6"]);
  });

  it("renders images, with the source moved out of `src`", () => {
    const d = view("![alt](img/a.png)");
    const img = d.querySelector("img")!;
    expect(img.alt).toBe("alt");
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("data-md-local")).toBe("img/a.png");
  });

});

describe("renderChunks (what the view re-renders while typing)", () => {
  // Varied blocks, as in a real document: chunk ends depend on block content.
  const doc = (n: number, edit = -1) =>
    Array.from({ length: n }, (_, i) => `## Section ${i}\n\nParagraph ${i === edit ? "EDITED" : "text"} number ${i} with a [link](https://example.com/${i}).\n\n- item ${i}\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n`).join("\n");

  it("gives the same HTML as one piece, with line numbers relative to each chunk", () => {
    const src = doc(200);
    const chunks = renderChunks(src);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.map((c) => c.html).join("").replace(/ data-line="\d+"/g, "")).toBe(renderMarkdown(src).replace(/ data-line="\d+"/g, ""));
    // Absolute line = chunk start + relative line, and it points at the block's first source line.
    const lines = src.split("\n");
    for (const c of chunks) {
      for (const m of c.html.matchAll(/<h2 data-line="(\d+)"[^>]*>([^<]*)</g)) expect(lines[c.line + Number(m[1])]).toBe(`## ${m[2]}`);
    }
  });

  it("changes only the chunk around an edit, also when lines are added above", () => {
    const before = renderChunks(doc(300)).map((c) => c.html);
    const edited = renderChunks(doc(300, 150)).map((c) => c.html);
    expect(edited.length).toBe(before.length);
    expect(edited.filter((h, i) => h !== before[i]).length).toBe(1);
    const shifted = renderChunks(`# Title\n\nNew intro paragraph.\n\n${doc(300)}`).map((c) => c.html);
    const kept = new Set(before);
    expect(shifted.filter((h) => !kept.has(h)).length).toBeLessThanOrEqual(2);
  });

  it("parses a 1 MB document in reasonable time", () => {
    const src = doc(8000);
    expect(src.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const chunks = renderChunks(src);
    expect(chunks.length).toBeGreaterThan(100);
    // Generous: CI machines are slow. It runs in a worker in the app.
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("fenceLanguage", () => {
  it("takes the first word, lower-cased, safe characters only", () => {
    expect(fenceLanguage("rust ignore")).toBe("rust");
    expect(fenceLanguage("C++")).toBe("c++");
    expect(fenceLanguage("")).toBe("");
    expect(fenceLanguage('"><script>')).toBe("");
  });
});

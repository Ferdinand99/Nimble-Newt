// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { h } from "./dom";

describe("h", () => {
  it("builds an element with classes, attributes, properties and children", () => {
    const el = h("a", { class: "link", href: "https://example.com/", dataset: { id: "7" }, "aria-label": "go" }, "go ", h("b", {}, "now"));
    expect(el.className).toBe("link");
    expect(el.getAttribute("href")).toBe("https://example.com/");
    expect(el.dataset.id).toBe("7");
    expect(el.getAttribute("aria-label")).toBe("go");
    expect(el.textContent).toBe("go now");
  });

  it("adds listeners for on* functions", () => {
    const click = vi.fn();
    const el = h("button", { onClick: click }, "x");
    el.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps text as text", () => {
    const el = h("div", {}, "<img src=x onerror=alert(1)>");
    expect(el.children.length).toBe(0);
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("refuses props that would parse text as markup", () => {
    for (const key of ["innerHTML", "outerHTML", "srcdoc", "innerhtml"]) {
      expect(() => h("div", { [key]: "<img src=x onerror=alert(1)>" })).toThrow(/would parse text as HTML/);
    }
  });

  it("refuses an on* handler given as text", () => {
    expect(() => h("div", { onclick: "alert(1)" })).toThrow(/must be a function/);
    expect(() => h("div", { onmouseover: "alert(1)" })).toThrow(/must be a function/);
  });

  it("ignores empty props", () => {
    const el = h("div", { innerHTML: undefined, onclick: null, hidden: false });
    expect(el.hidden).toBe(false);
  });
});

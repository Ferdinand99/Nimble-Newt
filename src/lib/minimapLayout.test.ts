import { describe, expect, it } from "vitest";
import { layout, lineRuns, scrollTopForY, viewportRect } from "./minimapLayout";

describe("minimap layout", () => {
  it("draws every line at 2 px when the file fits", () => {
    expect(layout(100, 400)).toEqual({ rowHeight: 2, step: 1, rows: 100, contentHeight: 200 });
  });
  it("samples lines when the file is longer than the map", () => {
    const l = layout(10_000, 500);
    expect(l.rowHeight).toBe(1);
    expect(l.step).toBe(20);
    expect(l.rows).toBe(500);
    expect(l.contentHeight).toBe(500);
  });
  it("handles empty input", () => {
    expect(layout(0, 500).rows).toBe(0);
    expect(layout(10, 0).rows).toBe(0);
  });
  it("splits a line into runs of text", () => {
    expect(lineRuns("  let x = 1;")).toEqual([[2, 5], [6, 7], [8, 9], [10, 12]]);
    expect(lineRuns("")).toEqual([]);
    expect(lineRuns("    ")).toEqual([]);
    expect(lineRuns("a".repeat(500), 90)).toEqual([[0, 90]]);
    expect(lineRuns("\tfoo")).toEqual([[1, 4]]);
  });
  it("maps the viewport to minimap pixels and back", () => {
    const lay = layout(1000, 400);
    expect(lay.contentHeight).toBe(334); // every 3rd line, 1 px each
    const r = viewportRect(5000, 1000, 20000, lay);
    expect(r.top).toBeCloseTo((5000 * 334) / 20000);
    expect(r.height).toBeCloseTo((1000 * 334) / 20000);
    // Clicking the middle of the viewport rectangle scrolls to (almost) where it already is.
    const mid = r.top + r.height / 2;
    expect(scrollTopForY(mid, 1000, 20000, lay)).toBeCloseTo(5000, -1);
    expect(scrollTopForY(0, 1000, 20000, lay)).toBe(0);
    expect(scrollTopForY(334, 1000, 20000, lay)).toBe(19000);
  });
  it("never makes the viewport marker vanishingly small", () => {
    expect(viewportRect(0, 10, 1_000_000, layout(1000, 400)).height).toBe(6);
  });
});

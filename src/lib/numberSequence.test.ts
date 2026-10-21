import { describe, expect, it } from "vitest";
import { formatInt, MAX_SEQ_COUNT, parseSeqOptions, sequence } from "./numberSequence";

describe("sequence", () => {
  it("counts from 1 by default", () => {
    expect(sequence(3)).toEqual(["1", "2", "3"]);
  });
  it("supports start and negative steps", () => {
    expect(sequence(4, { start: 10, step: -3 })).toEqual(["10", "7", "4", "1"]);
    expect(sequence(3, { start: -1, step: -1 })).toEqual(["-1", "-2", "-3"]);
    expect(sequence(3, { start: 0, step: 0 })).toEqual(["0", "0", "0"]);
  });
  it("repeats each value", () => {
    expect(sequence(5, { repeat: 2 })).toEqual(["1", "1", "2", "2", "3"]);
    expect(sequence(4, { start: 0, step: 5, repeat: 3 })).toEqual(["0", "0", "0", "5"]);
  });
  it("pads with zeros or spaces", () => {
    expect(sequence(2, { start: 9, pad: 3 })).toEqual(["009", "010"]);
    expect(sequence(2, { start: 9, pad: 3, padChar: " " })).toEqual(["  9", " 10"]);
    expect(sequence(1, { start: -5, pad: 4 })).toEqual(["-005"]);
    expect(sequence(1, { start: -5, pad: 4, padChar: " " })).toEqual(["  -5"]);
  });
  it("formats other bases", () => {
    expect(sequence(3, { start: 254, base: 16 })).toEqual(["fe", "ff", "100"]);
    expect(sequence(2, { start: 254, base: 16, uppercaseHex: true })).toEqual(["FE", "FF"]);
    expect(sequence(3, { start: 6, base: 2, pad: 4 })).toEqual(["0110", "0111", "1000"]);
    expect(sequence(2, { start: 7, base: 8 })).toEqual(["7", "10"]);
    expect(sequence(1, { start: -255, base: 16 })).toEqual(["-ff"]);
  });
  it("adds prefix and suffix", () => {
    expect(sequence(2, { start: 10, base: 16, pad: 2, prefix: "0x", suffix: "," })).toEqual(["0x0a,", "0x0b,"]);
    expect(sequence(2, { prefix: "item_" })).toEqual(["item_1", "item_2"]);
  });
  it("sanitises bad input instead of throwing", () => {
    expect(sequence(-5)).toEqual([]);
    expect(sequence(NaN)).toEqual([]);
    expect(sequence(2.9)).toEqual(["1", "2"]);
    expect(sequence(2, { start: NaN, step: Infinity })).toEqual(["1", "2"]);
    expect(sequence(2, { repeat: 0 })).toEqual(["1", "2"]);
    expect(sequence(1, { start: 1.9 })).toEqual(["1"]);
    expect(sequence(1, { base: 3 as never, pad: -2 })).toEqual(["1"]);
    expect(sequence(1, { pad: 9999, start: 1 })[0]).toHaveLength(64);
  });
  it("clamps huge counts and stays fast", () => {
    const t0 = performance.now();
    const big = sequence(5_000_000, { pad: 7 });
    expect(big).toHaveLength(MAX_SEQ_COUNT);
    expect(big[MAX_SEQ_COUNT - 1]).toBe("1000000");
    expect(big[0]).toBe("0000001");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it("keeps big integers exact", () => {
    expect(sequence(2, { start: 9007199254740993n, step: 2 })).toEqual(["9007199254740993", "9007199254740995"]);
  });
  it("formatInt handles signs", () => {
    expect(formatInt(-3, 10, 3)).toBe("-03");
    expect(formatInt(255, 16, 0, "0", true)).toBe("FF");
  });
});

describe("parseSeqOptions", () => {
  it("parses a valid form", () => {
    const r = parseSeqOptions({ count: "5", start: "10", step: "-2", repeat: "2", base: "16", pad: "3", padChar: " ", uppercaseHex: true, prefix: "#" });
    expect(r).toEqual({ ok: true, count: 5, options: { start: 10n, step: -2n, repeat: 2, base: 16, pad: 3, padChar: " ", uppercaseHex: true, prefix: "#", suffix: "" } });
  });
  it("uses defaults for empty fields", () => {
    const r = parseSeqOptions({ count: " 3 " });
    expect(r.ok && r.options.start).toBe(1n);
    expect(r.ok && r.options.base).toBe(10);
    expect(r.ok && r.count).toBe(3);
  });
  it("rejects bad input with the field name", () => {
    expect(parseSeqOptions({})).toEqual({ ok: false, field: "count", error: "required" });
    expect(parseSeqOptions({ count: "0" })).toEqual({ ok: false, field: "count", error: "range" });
    expect(parseSeqOptions({ count: "2000000" })).toEqual({ ok: false, field: "count", error: "range" });
    expect(parseSeqOptions({ count: "x" })).toEqual({ ok: false, field: "count", error: "integer" });
    expect(parseSeqOptions({ count: "3", start: "1.5" })).toEqual({ ok: false, field: "start", error: "integer" });
    expect(parseSeqOptions({ count: "3", step: "abc" })).toEqual({ ok: false, field: "step", error: "integer" });
    expect(parseSeqOptions({ count: "3", repeat: "0" })).toEqual({ ok: false, field: "repeat", error: "range" });
    expect(parseSeqOptions({ count: "3", base: "7" })).toEqual({ ok: false, field: "base", error: "range" });
    expect(parseSeqOptions({ count: "3", base: "hex" })).toEqual({ ok: false, field: "base", error: "integer" });
    expect(parseSeqOptions({ count: "3", pad: "100" })).toEqual({ ok: false, field: "pad", error: "range" });
    expect(parseSeqOptions({ count: "3", padChar: "x" })).toEqual({ ok: false, field: "padChar", error: "range" });
  });
  it("round-trips into sequence", () => {
    const r = parseSeqOptions({ count: "3", start: "99999999999999999999", step: "1" });
    expect(r.ok && sequence(r.count, r.options)).toEqual(["99999999999999999999", "100000000000000000000", "100000000000000000001"]);
  });
});

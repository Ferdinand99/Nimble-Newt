import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, formatJson, formatXml, hexDecode, hexEncode, htmlDecode, htmlEncode, minifyJson, minifyXml, parseMoment, urlDecode, urlEncode, uuidV4, uuidV7 } from "./tools";

const val = (r: { ok: boolean; text?: string }) => (r.ok ? (r as { text: string }).text : "ERR");

describe("JSON", () => {
  it("formats with the chosen indent and keeps empty containers compact", () => {
    expect(val(formatJson('{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[]}'))).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {\n      "c": null\n    }\n  ],\n  "d": {},\n  "e": []\n}');
    expect(val(formatJson('[1]', "\t"))).toBe("[\n\t1\n]");
  });
  it("keeps key order and exact number literals", () => {
    expect(val(formatJson('{"2":1,"1":12345678901234567890,"x":1.50}', 1))).toBe('{\n "2": 1,\n "1": 12345678901234567890,\n "x": 1.50\n}');
  });
  it("handles strings with escapes, commas and brackets inside", () => {
    const src = '{"k":"a,b:{c}[d]\\"e\\\\"}';
    expect(val(formatJson(src))).toBe('{\n  "k": "a,b:{c}[d]\\"e\\\\"\n}');
    expect(val(minifyJson(val(formatJson(src))))).toBe(src);
  });
  it("minifies and round-trips", () => {
    const src = '{"a": [1, 2, {"b": "c d"}], "e": true}';
    expect(val(minifyJson(src))).toBe('{"a":[1,2,{"b":"c d"}],"e":true}');
    expect(JSON.parse(val(formatJson(src)))).toEqual(JSON.parse(src));
  });
  it("reports invalid JSON instead of guessing", () => {
    expect(formatJson('{"a":}').ok).toBe(false);
    expect(minifyJson("{'a':1}").ok).toBe(false);
    expect(formatJson("").ok).toBe(false);
  });
  it("handles scalars and nested arrays", () => {
    expect(val(formatJson("42"))).toBe("42");
    expect(val(formatJson("[[],[[]]]"))).toBe("[\n  [],\n  [\n    []\n  ]\n]");
  });
});

describe("XML", () => {
  it("indents nested elements and keeps simple text inline", () => {
    expect(val(formatXml('<a><b>text</b><c x="1"/><d><e/></d></a>'))).toBe('<a>\n  <b>text</b>\n  <c x="1"/>\n  <d>\n    <e/>\n  </d>\n</a>');
  });
  it("keeps declarations, comments, CDATA and doctype intact", () => {
    const src = '<?xml version="1.0"?><!DOCTYPE a [<!ELEMENT a ANY>]><a><!-- hi --><![CDATA[<x>]]></a>';
    expect(val(formatXml(src))).toBe('<?xml version="1.0"?>\n<!DOCTYPE a [<!ELEMENT a ANY>]>\n<a>\n  <!-- hi -->\n  <![CDATA[<x>]]>\n</a>');
  });
  it("is not confused by > inside attribute values", () => {
    expect(val(formatXml('<a t="x>y"><b/></a>'))).toBe('<a t="x>y">\n  <b/>\n</a>');
  });
  it("minifies, dropping whitespace between tags and comments", () => {
    expect(val(minifyXml("<a>\n  <b> x  y </b>\n  <!-- c -->\n  <c/>\n</a>"))).toBe("<a><b> x y </b><c/></a>");
  });
  it("rejects unbalanced markup", () => {
    expect(formatXml("<a><b></a>").ok).toBe(false);
    expect(minifyXml("<a>").ok).toBe(false);
  });
});

describe("encodings", () => {
  it("Base64 round-trips unicode and supports the URL-safe form", () => {
    expect(base64Encode("Hello")).toBe("SGVsbG8=");
    const s = "blåbær 日本語 😀 ??>>";
    expect(val(base64Decode(base64Encode(s)))).toBe(s);
    const u = base64Encode("??>>~~", true);
    expect(u).not.toMatch(/[+/=]/);
    expect(val(base64Decode(u))).toBe("??>>~~");
  });
  it("Base64 rejects garbage and non-UTF-8 payloads", () => {
    expect(base64Decode("not base64!").ok).toBe(false);
    expect(base64Decode("/w==").ok).toBe(false); // 0xFF is not UTF-8
    expect(val(base64Decode("  SGVs\nbG8=  "))).toBe("Hello");
  });
  it("encodes large input without blowing the stack", () => {
    expect(val(base64Decode(base64Encode("x".repeat(500_000)))).length).toBe(500_000);
  });
  it("URL encoding", () => {
    expect(urlEncode("a b&c=æ/ø")).toBe("a%20b%26c%3D%C3%A6%2F%C3%B8");
    expect(val(urlDecode("a%20b%26c+d"))).toBe("a b&c d");
    expect(urlDecode("%E0%A4%A").ok).toBe(false);
  });
  it("HTML entities", () => {
    expect(htmlEncode(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
    expect(htmlDecode("&lt;b&gt; &amp;amp; &#65;&#x42; &oslash; &unknown; &#0; &#xD800;")).toBe("<b> &amp; AB ø &unknown; &#0; &#xD800;");
  });
  it("hex", () => {
    expect(hexEncode("Hi æ")).toBe("486920c3a6");
    expect(val(hexDecode("48 69 20 c3:a6"))).toBe("Hi æ");
    expect(hexDecode("xyz").ok).toBe(false);
    expect(hexDecode("abc").ok).toBe(false);
  });
});

describe("timestamps", () => {
  it("reads seconds, milliseconds and dates", () => {
    const s = parseMoment("1700000000", "UTC")!;
    expect(s.iso).toBe("2023-11-14T22:13:20.000Z");
    expect(s.interpreted).toBe("seconds");
    const ms = parseMoment("1700000000123", "UTC")!;
    expect(ms.epochSeconds).toBe(1700000000);
    expect(ms.interpreted).toBe("milliseconds");
    expect(parseMoment("2023-11-14T22:13:20Z", "UTC")!.epochSeconds).toBe(1700000000);
    expect(s.local).toBe("2023-11-14 22:13:20");
  });
  it("converts to a given time zone and rejects garbage", () => {
    expect(parseMoment("1700000000", "Europe/Oslo")!.local).toBe("2023-11-14 23:13:20");
    expect(parseMoment("hello")).toBeNull();
    expect(parseMoment("")).toBeNull();
  });
});

describe("UUIDs", () => {
  const fixed = (n: number) => new Uint8Array(n).fill(0xff);
  it("v4 has the right version and variant bits", () => {
    expect(uuidV4(fixed)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("v7 carries the timestamp and sorts by time", () => {
    const a = uuidV7(1700000000000, fixed);
    expect(a.startsWith("018bcfe5-6800-7")).toBe(true);
    expect(uuidV7(1700000000001, fixed) > a).toBe(true);
    expect(uuidV7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

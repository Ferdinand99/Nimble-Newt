import { StringStream } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildUserLanguage, findFold, keywordTable, normalizeDefinition, toLanguageDef, userTokenizer, type UserLanguageDefinition } from "./userLanguage";

const def = (over: Partial<UserLanguageDefinition> = {}): UserLanguageDefinition =>
  normalizeDefinition({
    id: "demo",
    name: "Demo",
    extensions: ["DM"],
    keywords: { keyword: ["if", "Else"], type: ["int"], builtin: ["print"], literal: ["nil"] },
    lineComment: "#",
    blockComment: ["/*", "*/"],
    strings: [{ start: '"', end: '"', escape: "\\" }],
    operators: "+-*/=",
    fold: { start: "{", end: "}" },
    ...over,
  });

/** Runs the tokenizer over lines, returning [token, text] pairs per line and carrying state. */
function run(d: UserLanguageDefinition, lines: string[]): [string | null, string][][] {
  const p = userTokenizer(d);
  const state = p.startState!(2);
  return lines.map((line) => {
    const s = new StringStream(line, 4, 2);
    const out: [string | null, string][] = [];
    while (!s.eol()) {
      s.start = s.pos;
      const tok = p.token(s, state);
      if (s.pos === s.start) throw new Error("no progress");
      out.push([tok, s.current()]);
    }
    return out;
  });
}
const nonWs = (r: [string | null, string][]) => r.filter(([, t]) => t.trim());

describe("user language tokenizer", () => {
  it("classifies keyword groups, case sensitive", () => {
    const [r] = run(def(), ["if Else else int print nil foo"]);
    expect(nonWs(r)).toEqual([["keyword", "if"], ["keyword", "Else"], [null, "else"], ["typeName", "int"], ["builtin", "print"], ["atom", "nil"], [null, "foo"]]);
  });
  it("supports case-insensitive keywords", () => {
    const [r] = run(def({ caseSensitive: false }), ["IF else INT"]);
    expect(nonWs(r).map(([k]) => k)).toEqual(["keyword", "keyword", "typeName"]);
  });
  it("first keyword group wins for duplicates", () => {
    expect(keywordTable(def({ keywords: { keyword: ["x"], type: ["x"] } })).get("x")).toBe("keyword");
  });
  it("handles strings with escapes and multi-line strings", () => {
    const rows = run(def(), ['a "x \\" y" b', '"open', 'still" end']);
    expect(nonWs(rows[0])).toEqual([[null, "a"], ["string", '"x \\" y"'], [null, "b"]]);
    expect(rows[1].every(([k]) => k === "string")).toBe(true);
    expect(nonWs(rows[2])).toEqual([["string", 'still"'], [null, "end"]]);
  });
  it("supports doubled-quote escapes", () => {
    const d = def({ strings: [{ start: "'", end: "'", escape: "'" }] });
    const [r] = run(d, ["'it''s' x"]);
    expect(nonWs(r)).toEqual([["string", "'it''s'"], [null, "x"]]);
  });
  it("handles line and multi-line block comments", () => {
    const rows = run(def(), ["x # if", "a /* one", "two if", "three */ if"]);
    expect(nonWs(rows[0])).toEqual([[null, "x"], ["comment", "# if"]]);
    expect(nonWs(rows[1])).toEqual([[null, "a"], ["comment", "/* one"]]);
    expect(nonWs(rows[2])).toEqual([["comment", "two if"]]);
    expect(nonWs(rows[3])).toEqual([["comment", "three */"], ["keyword", "if"]]);
  });
  it("tokenizes numbers when enabled", () => {
    const [r] = run(def(), ["1 2.5 0xFF 1e3 a1"]);
    expect(nonWs(r)).toEqual([["number", "1"], ["number", "2.5"], ["number", "0xFF"], ["number", "1e3"], [null, "a1"]]);
    const [off] = run(def({ numbers: false }), ["12"]);
    expect(off.every(([k]) => k !== "number")).toBe(true);
  });
  it("tokenizes operators and extra word characters", () => {
    const [r] = run(def({ wordChars: "-$" }), ["a-b + $x"]);
    expect(nonWs(r)).toEqual([[null, "a-b"], ["operator", "+"], [null, "$x"]]);
  });
  it("never loops on unusual input", () => {
    expect(() => run(def(), ["@@ ~ éø \u{1f600}", ""])).not.toThrow();
  });
});

describe("user language folding", () => {
  it("finds matching delimiters with nesting", () => {
    const lines = ["fn {", "  if {", "  }", "}", "x"];
    expect(findFold(lines, 0, "{", "}")).toEqual({ fromCol: 4, toLine: 3, toCol: 0 });
    expect(findFold(lines, 1, "{", "}")).toEqual({ fromCol: 6, toLine: 2, toCol: 2 });
    expect(findFold(lines, 4, "{", "}")).toBeNull();
    expect(findFold(["a { b }", "c"], 0, "{", "}")).toBeNull();
    expect(findFold(["{", "x"], 0, "{", "}")).toBeNull();
  });
  it("supports multi-character delimiters", () => {
    expect(findFold(["BEGIN", "x", "END"], 0, "BEGIN", "END")).toEqual({ fromCol: 5, toLine: 2, toCol: 0 });
  });
});

describe("buildUserLanguage / toLanguageDef", () => {
  it("creates an editor state with the language and fold service", async () => {
    const ext = buildUserLanguage(def());
    expect(() => EditorState.create({ doc: "a {\n}\n", extensions: [ext] })).not.toThrow();
    const noFold = buildUserLanguage(def({ fold: undefined }));
    expect(() => EditorState.create({ doc: "x", extensions: [noFold] })).not.toThrow();
  });
  it("prefixes ids and lowercases extensions", async () => {
    const l = toLanguageDef(def());
    expect(l.id).toBe("user-demo");
    expect(l.extensions).toEqual(["dm"]);
    expect(l.comment).toEqual({ line: "#", block: ["/*", "*/"] });
    expect(await l.load()).toBeTruthy();
  });
});

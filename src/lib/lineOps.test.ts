import { describe, expect, it } from "vitest";
import {
  changeCase,
  collapseBlankLines,
  identifierWords,
  indentLines,
  joinLines,
  keepOnlyDuplicates,
  numberLines,
  outdentLines,
  prefixLines,
  removeDuplicateLines,
  removeEmptyLines,
  reverseLines,
  selectionToLines,
  shuffleLines,
  sortLines,
  splitEol,
  splitLines,
  splitLinesBy,
  suffixLines,
  toLines,
  trimLines,
} from "./lineOps";

describe("sortLines", () => {
  it("sorts ascending and descending", () => {
    expect(sortLines(["b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(sortLines(["b", "c", "a"], { order: "desc" })).toEqual(["c", "b", "a"]);
  });
  it("honours case sensitivity", () => {
    expect(sortLines(["b", "A", "a", "B"], { caseSensitive: true })).toEqual(["A", "B", "a", "b"]);
    expect(sortLines(["b", "A", "a", "B"], { caseSensitive: false })).toEqual(["A", "a", "b", "B"]);
  });
  it("is stable for equal keys", () => {
    expect(sortLines(["bb", "BB", "a", "A"], { caseSensitive: false })).toEqual(["a", "A", "bb", "BB"]);
    expect(sortLines(["B", "a", "b", "A"], { order: "desc" })).toEqual(["B", "b", "a", "A"]);
  });
  it("sorts numerically with leading numbers", () => {
    expect(sortLines(["10", "9", "100", "1"], { numeric: true })).toEqual(["1", "9", "10", "100"]);
    expect(sortLines(["10", "9", "100", "1"])).toEqual(["1", "10", "100", "9"]);
    expect(sortLines(["-2", "3", "-10", "1.5"], { numeric: true })).toEqual(["-10", "-2", "1.5", "3"]);
  });
  it("sorts embedded numbers naturally", () => {
    expect(sortLines(["file10.txt", "file2.txt", "file1.txt"], { numeric: true })).toEqual(["file1.txt", "file2.txt", "file10.txt"]);
    expect(sortLines(["a2b10", "a2b9", "a10b1"], { numeric: true })).toEqual(["a2b9", "a2b10", "a10b1"]);
    expect(sortLines(["x99999999999999999999", "x100000000000000000000"], { numeric: true })).toEqual(["x99999999999999999999", "x100000000000000000000"]);
  });
  it("puts numbers before text and handles equal values", () => {
    expect(sortLines(["abc", "5", "5a"], { numeric: true })).toEqual(["5", "5a", "abc"]);
    expect(sortLines(["01", "1", "001"], { numeric: true })).toEqual(["001", "01", "1"]);
  });
  it("can ignore leading whitespace", () => {
    expect(sortLines(["  b", "a", " c"], { ignoreLeadingWhitespace: true })).toEqual(["a", "  b", " c"]);
    expect(sortLines(["  b", "a", " c"])).toEqual(["  b", " c", "a"]);
  });
  it("can use a locale for Norwegian letters", () => {
    expect(sortLines(["å", "ø", "z", "æ", "a"], { locale: "nb" })).toEqual(["a", "z", "æ", "ø", "å"]);
  });
  it("does not mutate the input", () => {
    const src = ["b", "a"];
    sortLines(src);
    expect(src).toEqual(["b", "a"]);
  });
});

describe("reverse and shuffle", () => {
  it("reverses", () => {
    expect(reverseLines(["a", "b", "c"])).toEqual(["c", "b", "a"]);
    expect(reverseLines([])).toEqual([]);
  });
  it("shuffles deterministically with an rng and keeps all lines", () => {
    let s = 7;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const src = ["a", "b", "c", "d", "e", "f"];
    const out = shuffleLines(src, rng);
    expect([...out].sort()).toEqual(src);
    expect(shuffleLines(src, () => 0)).toEqual(["b", "c", "d", "e", "f", "a"]);
    expect(shuffleLines(src, () => 0.9999)).toEqual(src);
    expect(src).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("duplicates and empties", () => {
  it("removes all duplicates keeping the first", () => {
    expect(removeDuplicateLines(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
  it("removes only consecutive duplicates", () => {
    expect(removeDuplicateLines(["a", "a", "b", "a", "a"], { mode: "consecutive" })).toEqual(["a", "b", "a"]);
  });
  it("can ignore case", () => {
    expect(removeDuplicateLines(["A", "a", "b"], { caseSensitive: false })).toEqual(["A", "b"]);
    expect(removeDuplicateLines(["A", "a", "b"], { caseSensitive: true })).toEqual(["A", "a", "b"]);
    expect(removeDuplicateLines(["A", "a", "A"], { mode: "consecutive", caseSensitive: false })).toEqual(["A"]);
  });
  it("keeps only duplicated lines", () => {
    expect(keepOnlyDuplicates(["a", "b", "a", "c", "b", "a"])).toEqual(["a", "b"]);
    expect(keepOnlyDuplicates(["a", "A"], { caseSensitive: false })).toEqual(["a"]);
  });
  it("removes empty and blank lines", () => {
    expect(removeEmptyLines(["a", "", " ", "b"])).toEqual(["a", " ", "b"]);
    expect(removeEmptyLines(["a", "", " \t", "b"], { blankToo: true })).toEqual(["a", "b"]);
  });
  it("collapses runs of blank lines", () => {
    expect(collapseBlankLines(["a", "", "", " ", "b", "", "c"])).toEqual(["a", "", "b", "", "c"]);
    expect(collapseBlankLines(["", "", "a"])).toEqual(["", "a"]);
  });
});

describe("trimLines", () => {
  it("trims by side", () => {
    expect(trimLines(["  a  "], "leading")).toEqual(["a  "]);
    expect(trimLines(["  a  "], "trailing")).toEqual(["  a"]);
    expect(trimLines(["\t a \t"], "both")).toEqual(["a"]);
  });
});

describe("changeCase", () => {
  it("upper and lower handle Norwegian letters", () => {
    expect(changeCase("blåbærsyltetøy", "upper")).toBe("BLÅBÆRSYLTETØY");
    expect(changeCase("ÆØÅ", "lower")).toBe("æøå");
  });
  it("title case", () => {
    expect(changeCase("hello wORLD from øst-norge", "title")).toBe("Hello World From Øst-Norge");
    expect(changeCase("don't stop", "title")).toBe("Don't Stop");
    expect(changeCase("åse og ærlig", "title")).toBe("Åse Og Ærlig");
  });
  it("sentence case", () => {
    expect(changeCase("HELLO world. this is it! øl? yes", "sentence")).toBe("Hello world. This is it! Øl? Yes");
    expect(changeCase("  leading space", "sentence")).toBe("  Leading space");
    expect(changeCase("v1.2 is out. ok", "sentence")).toBe("V1.2 is out. Ok");
  });
  it("invert case", () => {
    expect(changeCase("Hello Æøå", "invert")).toBe("hELLO æØÅ");
    expect(changeCase("123 ß", "invert")).toBe("123 ß");
  });
  it("splits identifiers into words", () => {
    expect(identifierWords("XMLHttpRequest")).toEqual(["XML", "Http", "Request"]);
    expect(identifierWords("foo_bar-baz qux2Go")).toEqual(["foo", "bar", "baz", "qux", "2", "Go"]);
    expect(identifierWords("blåBærSaft")).toEqual(["blå", "Bær", "Saft"]);
  });
  it("camel, pascal, snake and kebab", () => {
    expect(changeCase("hello world foo", "camel")).toBe("helloWorldFoo");
    expect(changeCase("hello_world-foo", "pascal")).toBe("HelloWorldFoo");
    expect(changeCase("helloWorldFoo", "snake")).toBe("hello_world_foo");
    expect(changeCase("HelloWorldFoo", "kebab")).toBe("hello-world-foo");
    expect(changeCase("Øl og Brød", "snake")).toBe("øl_og_brød");
    expect(changeCase("XMLHttpRequest", "snake")).toBe("xml_http_request");
  });
  it("identifier conversions work per line and keep indentation", () => {
    expect(changeCase("  foo bar\nbaz qux", "camel")).toBe("  fooBar\nbazQux");
    expect(changeCase("a b\r\nc d", "snake")).toBe("a_b\r\nc_d");
    expect(changeCase("", "camel")).toBe("");
    expect(changeCase("---", "snake")).toBe("---");
  });
});

describe("join and split", () => {
  it("joins with a separator and trims the touching edges", () => {
    expect(joinLines(["a", "b", "c"])).toBe("a b c");
    expect(joinLines(["  a  ", "  b  ", "  c  "], ",")).toBe("  a,b,c  ");
    expect(joinLines(["a", "", "  ", "b"], ", ")).toBe("a, b");
    expect(joinLines([])).toBe("");
    expect(joinLines(["only"])).toBe("only");
  });
  it("wraps at spaces at or before the width", () => {
    expect(splitLines("aaa bbb ccc", { width: 7 })).toEqual(["aaa bbb", "ccc"]);
    expect(splitLines("aaa bbb ccc", { width: 8 })).toEqual(["aaa bbb", "ccc"]);
    expect(splitLines("aaa bbb ccc", { width: 11 })).toEqual(["aaa bbb ccc"]);
    expect(splitLines("one two three four", { width: 9 })).toEqual(["one two", "three", "four"]);
  });
  it("keeps long words whole", () => {
    expect(splitLines("short extraordinarily long", { width: 5 })).toEqual(["short", "extraordinarily", "long"]);
    expect(splitLines("abcdefghij", { width: 4 })).toEqual(["abcdefghij"]);
  });
  it("keeps existing line breaks and drops break whitespace", () => {
    expect(splitLines("aa bb\n\ncc dd", { width: 5 })).toEqual(["aa bb", "", "cc dd"]);
    expect(splitLines("aa   bb", { width: 3 })).toEqual(["aa", "bb"]);
    expect(splitLines("a b", { width: 0 })).toEqual(["a", "b"]);
  });
  it("splits by a delimiter", () => {
    expect(splitLinesBy("a,b,c", ",")).toEqual(["a", "b", "c"]);
    expect(splitLinesBy("a,b\nc", ",")).toEqual(["a", "b", "c"]);
    expect(splitLinesBy("a1b22c", /\d+/)).toEqual(["a", "b", "c"]);
    expect(splitLinesBy("a,b", "")).toEqual(["a,b"]);
  });
});

describe("indent, prefix and numbering", () => {
  it("indents non-empty lines", () => {
    expect(indentLines(["a", "", "b"], "  ")).toEqual(["  a", "", "  b"]);
    expect(indentLines(["a"], "\t", 2)).toEqual(["\t\ta"]);
  });
  it("outdents by one unit", () => {
    expect(outdentLines(["    a", "  b", "c", "\td"], "    ")).toEqual(["a", "b", "c", "d"]);
    expect(outdentLines(["\t\ta"], "\t")).toEqual(["\ta"]);
    expect(outdentLines(["      a"], "    ")).toEqual(["  a"]);
  });
  it("adds prefixes and suffixes", () => {
    expect(prefixLines(["a", "", "b"], "> ")).toEqual(["> a", "> ", "> b"]);
    expect(prefixLines(["a", "", "b"], "> ", { skipEmpty: true })).toEqual(["> a", "", "> b"]);
    expect(suffixLines(["a", "b"], ";")).toEqual(["a;", "b;"]);
    expect(suffixLines(["a", ""], ";", { skipEmpty: true })).toEqual(["a;", ""]);
  });
  it("numbers lines", () => {
    expect(numberLines(["a", "b"])).toEqual(["1. a", "2. b"]);
    expect(numberLines(["a", "b"], { start: 8, step: 2, pad: 3, padChar: "0", separator: ": " })).toEqual(["008: a", "010: b"]);
    expect(numberLines(["a", "b"], { start: 9, pad: 2, separator: " " })).toEqual([" 9 a", "10 b"]);
    expect(numberLines(["a", "b"], { start: 1, step: -1, separator: "|" })).toEqual(["1|a", "0|b"]);
  });
});

describe("selection helpers", () => {
  const text = "one\ntwo\nthree\nfour";
  it("splits lines of any ending", () => {
    expect(toLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    expect(splitEol("a\r\nb")).toEqual({ lines: ["a", "b"], eol: "\r\n" });
    expect(splitEol("a\nb").eol).toBe("\n");
  });
  it("maps a caret to its line", () => {
    expect(selectionToLines(text, 5, 5)).toEqual({ first: 1, last: 1, start: 4, end: 7 });
  });
  it("maps a selection to whole lines", () => {
    expect(selectionToLines(text, 5, 10)).toEqual({ first: 1, last: 2, start: 4, end: 13 });
    expect(selectionToLines(text, 10, 5)).toEqual({ first: 1, last: 2, start: 4, end: 13 });
  });
  it("excludes a line the selection only touches at its start", () => {
    expect(selectionToLines(text, 0, 8)).toEqual({ first: 0, last: 1, start: 0, end: 7 });
  });
  it("handles CRLF and the end of the document", () => {
    const crlf = "a\r\nb\r\nc";
    expect(selectionToLines(crlf, 0, 6)).toMatchObject({ first: 0, last: 1, start: 0, end: 4 });
    expect(selectionToLines(crlf, 100, 100)).toMatchObject({ first: 2, last: 2 });
    expect(selectionToLines("", 0, 0)).toEqual({ first: 0, last: 0, start: 0, end: 0 });
  });
});

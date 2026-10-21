import { describe, expect, it } from "vitest";
import { collectWords, isWordChar, suggest } from "./completion";

const names = (ws: { word: string }[]) => ws.map((w) => w.word);

describe("collectWords", () => {
  it("counts words and skips short ones", () => {
    const w = collectWords("foo bar foo ab foo bar");
    expect(w).toEqual([
      { word: "foo", count: 3 },
      { word: "bar", count: 2 },
    ]);
  });
  it("allows digits, underscore and dollar inside words", () => {
    expect(names(collectWords("my_var $scope item2 _x1"))).toEqual(["$scope", "_x1", "item2", "my_var"]);
  });
  it("skips pure numbers", () => {
    expect(collectWords("123 4567 3.14 0xff 12ab")).toEqual([
      { word: "0xff", count: 1 },
      { word: "12ab", count: 1 },
    ]);
  });
  it("handles Unicode letters", () => {
    const w = names(collectWords("blåbær øl ærlig Ünïcödé 日本語 naïve"));
    expect(w).toEqual(expect.arrayContaining(["blåbær", "ærlig", "Ünïcödé", "日本語", "naïve"]));
    expect(w).not.toContain("øl");
  });
  it("does not treat emoji as words", () => {
    expect(collectWords("😀😀😀 abc")).toEqual([{ word: "abc", count: 1 }]);
  });
  it("is case sensitive", () => {
    expect(names(collectWords("Foo foo Foo"))).toEqual(["Foo", "foo"]);
  });
  it("respects minLength and maxWords", () => {
    expect(names(collectWords("ab abc abcd", { minLength: 2 }))).toEqual(["ab", "abc", "abcd"]);
    expect(names(collectWords("aaa aaa bbb ccc", { maxWords: 2 }))).toEqual(["aaa", "bbb"]);
  });
  it("skips absurdly long runs", () => {
    expect(collectWords("x".repeat(500) + " word")).toEqual([{ word: "word", count: 1 }]);
  });
  it("handles empty and symbol-only text", () => {
    expect(collectWords("")).toEqual([]);
    expect(collectWords("!!! --- ...")).toEqual([]);
  });
  it("splits at punctuation and works at the end of the string", () => {
    expect(names(collectWords("a.foo(bar);baz"))).toEqual(["bar", "baz", "foo"]);
  });
});

describe("suggest", () => {
  const words = collectWords("foobar foo Foobaz foobar fooqux Other foolish foolish foolish");
  it("ranks same-case prefix matches by frequency then alphabet", () => {
    expect(suggest(words, "foo")).toEqual(["foolish", "foobar", "fooqux", "Foobaz"]);
  });
  it("matches case-insensitively, same-case first", () => {
    expect(suggest(words, "Foo")).toEqual(["Foobaz", "foolish", "foobar", "fooqux"]);
    expect(suggest(words, "OTH")).toEqual(["Other"]);
  });
  it("never suggests the prefix or the excluded word", () => {
    expect(suggest(words, "foo", { exclude: "foolish" })).not.toContain("foolish");
    expect(suggest(words, "foobar")).toEqual([]);
  });
  it("applies the limit and ignores empty prefixes", () => {
    expect(suggest(words, "foo", { limit: 2 })).toHaveLength(2);
    expect(suggest(words, "")).toEqual([]);
    expect(suggest(words, "zzz")).toEqual([]);
  });
  it("works with Unicode prefixes", () => {
    const w = collectWords("blåbær blåbærsaft blåse brød");
    expect(suggest(w, "blå")).toEqual(["blåbær", "blåbærsaft", "blåse"]);
    expect(suggest(w, "BLÅB")).toEqual(["blåbær", "blåbærsaft"]);
  });
  it("isWordChar agrees with the scanner", () => {
    expect(isWordChar("a")).toBe(true);
    expect(isWordChar("å")).toBe(true);
    expect(isWordChar("_")).toBe(true);
    expect(isWordChar("-")).toBe(false);
    expect(isWordChar("")).toBe(false);
  });
});

describe("performance", () => {
  it("scans 5 MB well under a second", () => {
    const vocab = Array.from({ length: 4000 }, (_, i) => `word${i}_${(i * 7919).toString(36)}`);
    vocab.push("blåbær", "øvelse", "naïve");
    const parts: string[] = [];
    let size = 0;
    let s = 1;
    while (size < 5 * 1024 * 1024) {
      s = (s * 16807) % 2147483647;
      const line = `  const ${vocab[s % vocab.length]} = ${vocab[(s >> 3) % vocab.length]}(${s}, "${vocab[(s >> 5) % vocab.length]}"); // ok\n`;
      parts.push(line);
      size += line.length;
    }
    const text = parts.join("");
    expect(text.length).toBeGreaterThan(5 * 1024 * 1024);
    const t0 = performance.now();
    const w = collectWords(text);
    const t1 = performance.now();
    const hits = suggest(w, "word1");
    const t2 = performance.now();
    expect(w.length).toBeGreaterThan(3000);
    expect(hits.length).toBe(30);
    expect(t1 - t0).toBeLessThan(900);
    expect(t2 - t1).toBeLessThan(50);
  });
});

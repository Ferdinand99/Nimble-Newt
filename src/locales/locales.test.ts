import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL(".", import.meta.url);
const read = (f: string): Record<string, string> => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const en = read("en.json");
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json");
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("locale files", () => {
  it("ships the 26 interface languages", () => {
    expect(files.map((f) => f.replace(".json", "")).sort()).toEqual(
      "ar cs da de es fa fi fr he hu it ja ko nb nl pl pt-BR pt-PT ro ru sv tr uk zh-CN zh-TW".split(" ").sort().filter((c) => c !== "en"),
    );
  });
  for (const f of files) {
    describe(f, () => {
      const l = read(f);
      it("has exactly the English keys (100 % coverage, nothing stale)", () => {
        expect(Object.keys(en).filter((k) => !(k in l))).toEqual([]);
        expect(Object.keys(l).filter((k) => !(k in en))).toEqual([]);
      });
      it("keeps every {placeholder}", () => {
        const bad = Object.keys(en).filter((k) => typeof l[k] === "string" && placeholders(l[k]).join() !== placeholders(en[k]).join());
        expect(bad).toEqual([]);
      });
      it("has no empty values", () => {
        expect(Object.keys(l).filter((k) => !l[k]?.trim())).toEqual([]);
      });
    });
  }
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import nb from "../locales/nb.json";
import { resolveLocale } from "./i18n";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "locales" ? [] : sources(p);
    return /\.ts$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
  });
}

/** Keys staged in src/locales/_pending/*.en.json count as existing until they are merged. */
function pending(lang: "en" | "nb"): Record<string, string> {
  const dir = "src/locales/_pending";
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(`.${lang}.json`));
  } catch {
    /* no pending keys */
  }
  return Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>));
}

describe("locales", () => {
  const enKeys = Object.keys(en);
  it("Norwegian has exactly the English keys", () => {
    const nbKeys = Object.keys(nb);
    expect(enKeys.filter((k) => !nbKeys.includes(k))).toEqual([]);
    expect(nbKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
  });
  it("every t('key') used in the source exists", () => {
    const used = new Set<string>();
    for (const f of sources("src")) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g)) used.add(m[1]);
    }
    const known = { ...en, ...pending("en") };
    expect([...used].filter((k) => !(k in known)).sort()).toEqual([]);
  });
  it("pending Norwegian keys mirror pending English keys", () => {
    expect(Object.keys(pending("nb")).sort()).toEqual(Object.keys(pending("en")).sort());
  });
  it("placeholders match between languages", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of enKeys) expect(ph((nb as Record<string, string>)[k] ?? ""), k).toBe(ph((en as Record<string, string>)[k]));
  });
  it("resolves locales", () => {
    expect(resolveLocale("auto", "nb-NO")).toBe("nb");
    expect(resolveLocale("auto", "en-US")).toBe("en");
    expect(resolveLocale("nb")).toBe("nb");
  });
});

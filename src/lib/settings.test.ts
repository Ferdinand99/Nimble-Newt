import { describe, expect, it } from "vitest";
import { DEFAULTS, normalize } from "./settings";

describe("settings.normalize", () => {
  it("fills defaults for empty or garbage input", () => {
    expect(normalize(null)).toEqual(DEFAULTS);
    expect(normalize("x")).toEqual(DEFAULTS);
  });
  it("keeps valid values and clamps numbers", () => {
    const s = normalize({ theme: "dark", fontSize: 500, tabSize: 0, wordWrap: true, defaultEol: "CRLF" });
    expect(s.theme).toBe("dark");
    expect(s.fontSize).toBe(40);
    expect(s.tabSize).toBe(1);
    expect(s.wordWrap).toBe(true);
    expect(s.defaultEol).toBe("CRLF");
  });
  it("rejects unknown enum values", () => {
    const s = normalize({ theme: "neon", defaultEncoding: "KOI8", locale: "xx" });
    expect(s.theme).toBe("system");
    expect(s.defaultEncoding).toBe("UTF-8");
    expect(s.locale).toBe("auto");
  });
});

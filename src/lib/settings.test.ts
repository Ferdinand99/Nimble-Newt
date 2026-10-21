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
  it("accepts any well-formed encoding label (the backend validates it)", () => {
    expect(normalize({ defaultEncoding: "Shift_JIS" }).defaultEncoding).toBe("Shift_JIS");
    expect(normalize({ defaultEncoding: "windows-1251" }).defaultEncoding).toBe("windows-1251");
  });
  it("rejects unknown enum values", () => {
    const s = normalize({ theme: "neon", defaultEncoding: "<script>", locale: "xx" });
    expect(s.theme).toBe("system");
    expect(s.defaultEncoding).toBe("UTF-8");
    expect(s.locale).toBe("auto");
  });
});

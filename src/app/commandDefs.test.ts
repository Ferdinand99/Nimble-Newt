import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import nb from "../locales/nb.json";
import { accelFor, COMMAND_DEFS, matchesAccel } from "./commandDefs";

const ev = (o: Partial<Parameters<typeof matchesAccel>[0]>) => ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

describe("command definitions", () => {
  it("has unique ids and a title in every language", () => {
    expect(new Set(COMMAND_DEFS.map((c) => c.id)).size).toBe(COMMAND_DEFS.length);
    for (const c of COMMAND_DEFS) {
      expect(`cmd.${c.id}` in en, `en cmd.${c.id}`).toBe(true);
      expect(`cmd.${c.id}` in nb, `nb cmd.${c.id}`).toBe(true);
    }
  });
  it("has no two commands sharing a shortcut on the same platform", () => {
    for (const mac of [false, true]) {
      const seen = new Map<string, string>();
      for (const c of COMMAND_DEFS) {
        const a = accelFor(c, mac);
        if (!a) continue;
        const norm = a.toLowerCase();
        expect(seen.get(norm), `${c.id} vs ${seen.get(norm)} (${a})`).toBeUndefined();
        seen.set(norm, c.id);
      }
    }
  });
});

describe("matchesAccel", () => {
  it("matches Ctrl+Shift+P on Windows but not Cmd", () => {
    expect(matchesAccel(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "CmdOrCtrl+Shift+P", false)).toBe(true);
    expect(matchesAccel(ev({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }), "CmdOrCtrl+Shift+P", false)).toBe(false);
    expect(matchesAccel(ev({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }), "CmdOrCtrl+Shift+P", true)).toBe(true);
  });
  it("is strict about extra modifiers", () => {
    expect(matchesAccel(ev({ key: "s", code: "KeyS", ctrlKey: true, shiftKey: true }), "CmdOrCtrl+S", false)).toBe(false);
  });
  it("handles Option-modified letters on macOS via the physical key", () => {
    expect(matchesAccel(ev({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }), "Alt+CmdOrCtrl+F", true)).toBe(true);
  });
  it("handles zoom, function and arrow keys", () => {
    expect(matchesAccel(ev({ key: "+", code: "Equal", ctrlKey: true, shiftKey: false }), "CmdOrCtrl+=", false)).toBe(true);
    expect(matchesAccel(ev({ key: "F3", code: "F3" }), "F3", false)).toBe(true);
    expect(matchesAccel(ev({ key: "F3", code: "F3", shiftKey: true }), "Shift+F3", false)).toBe(true);
    expect(matchesAccel(ev({ key: "ArrowUp", code: "ArrowUp", altKey: true }), "Alt+Up", false)).toBe(true);
    expect(matchesAccel(ev({ key: "Tab", code: "Tab", ctrlKey: true }), "Ctrl+Tab", true)).toBe(true);
  });
});

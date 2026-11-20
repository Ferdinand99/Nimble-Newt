import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import nb from "../locales/nb.json";
import { formatShortcut } from "../lib/logic";
import { accelFor, ChordMatcher, COMMAND_DEFS, matchesAccel, shortcutLabel } from "./commandDefs";

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

describe("Markdown view shortcuts", () => {
  const chordDefs = COMMAND_DEFS.filter((c) => c.chord);
  const always = () => true;

  it("are Ctrl/Cmd+Shift+V and Ctrl/Cmd+K V, only for Markdown tabs", () => {
    const read = COMMAND_DEFS.find((c) => c.id === "markdown.toggleRead")!;
    const split = COMMAND_DEFS.find((c) => c.id === "markdown.toggleSplit")!;
    expect(read.accel).toBe("CmdOrCtrl+Shift+V");
    expect(split.chord).toBe("CmdOrCtrl+K V");
    expect([read.when, split.when]).toEqual(["markdown", "markdown"]);
    expect(shortcutLabel(split, false, formatShortcut)).toBe("Ctrl+K V");
    expect(shortcutLabel(split, true, formatShortcut)).toBe("⌘K V");
    expect(shortcutLabel(read, false, formatShortcut)).toBe("Ctrl+Shift+V");
  });

  it("runs a chord on its second key, with or without Ctrl still held", () => {
    for (const second of [ev({ key: "v", code: "KeyV" }), ev({ key: "v", code: "KeyV", ctrlKey: true })]) {
      const m = new ChordMatcher(chordDefs, false);
      expect(m.handle(ev({ key: "k", code: "KeyK", ctrlKey: true }), always, 0)).toBe("consume");
      expect(m.handle(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }), always, 10)).toBe("consume");
      expect(m.handle(second, always, 20)).toEqual({ run: "markdown.toggleSplit" });
      expect(m.waiting).toBe(false);
    }
  });

  it("passes keys on when the chord is not completed, has timed out or does not apply", () => {
    const m = new ChordMatcher(chordDefs, false, 1000);
    expect(m.handle(ev({ key: "k", code: "KeyK", ctrlKey: true }), always, 0)).toBe("consume");
    expect(m.handle(ev({ key: "x", code: "KeyX" }), always, 10)).toBe("pass");
    expect(m.handle(ev({ key: "v", code: "KeyV" }), always, 20)).toBe("pass");
    expect(m.handle(ev({ key: "k", code: "KeyK", ctrlKey: true }), always, 100)).toBe("consume");
    expect(m.handle(ev({ key: "v", code: "KeyV" }), always, 5000)).toBe("pass");
    // Not a Markdown tab: Ctrl+K goes to the editor as before.
    expect(m.handle(ev({ key: "k", code: "KeyK", ctrlKey: true }), () => false, 6000)).toBe("pass");
    expect(m.handle(ev({ key: "k", code: "KeyK", metaKey: true }), always, 7000)).toBe("pass");
  });

  it("uses Cmd on macOS", () => {
    const m = new ChordMatcher(chordDefs, true);
    expect(m.handle(ev({ key: "k", code: "KeyK", metaKey: true }), always, 0)).toBe("consume");
    expect(m.handle(ev({ key: "v", code: "KeyV" }), always, 1)).toEqual({ run: "markdown.toggleSplit" });
  });
});

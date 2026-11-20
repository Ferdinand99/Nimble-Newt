// Command ids, shortcuts and the menu layout live in commands.json, shared with the native menu
// (src-tauri/src/menu.rs includes the same file), so shortcuts cannot drift apart.

import data from "./commands.json";

export interface CommandDef {
  id: string;
  accel?: string;
  accelMac?: string;
  /** Handled by the editor's own keymap; the app-level shortcut handler leaves it alone. */
  editor?: boolean;
  /** Recorded in macros when run from the palette or menu. */
  macro?: boolean;
  /** A two-step shortcut such as "CmdOrCtrl+K V" (press the first, release, press the second). Webview only. */
  chord?: string;
  /** The shortcut only applies in this context; elsewhere the key goes on to the editor as usual. */
  when?: "markdown";
}

export const COMMAND_DEFS: CommandDef[] = data.commands as CommandDef[];

export function accelFor(def: CommandDef, mac: boolean): string | undefined {
  return (mac && def.accelMac) || def.accel;
}

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Does this key event match an accelerator like "CmdOrCtrl+Shift+P"? */
export function matchesAccel(e: KeyLike, accel: string, mac: boolean): boolean {
  const parts = accel.split("+");
  const key = parts.pop()!;
  let ctrl = false,
    meta = false,
    alt = false,
    shift = false;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "cmdorctrl") {
      if (mac) meta = true;
      else ctrl = true;
    } else if (l === "ctrl") ctrl = true;
    else if (l === "alt") alt = true;
    else if (l === "shift") shift = true;
  }
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== alt || e.shiftKey !== shift) return false;
  const k = key.toLowerCase();
  if (k.length === 1 && /[a-z]/.test(k)) return e.code === `Key${k.toUpperCase()}` || e.key.toLowerCase() === k;
  if (k.length === 1 && /[0-9]/.test(k)) return e.code === `Digit${k}` || e.key === k;
  if (/^f\d{1,2}$/.test(k)) return e.key.toLowerCase() === k;
  if (k === "=") return e.key === "=" || e.key === "+" || e.code === "Equal";
  if (k === "-") return e.key === "-" || e.code === "Minus";
  if (k === ",") return e.key === "," || e.code === "Comma";
  if (k === "/") return e.key === "/" || e.code === "Slash";
  if (k === "up") return e.key === "ArrowUp";
  if (k === "down") return e.key === "ArrowDown";
  if (k === "tab") return e.key === "Tab";
  return e.key.toLowerCase() === k;
}

export type MenuNode = string | { id: string; items: MenuNode[] };
export const MENU: { id: string; items: MenuNode[] }[] = data.menu as { id: string; items: MenuNode[] }[];

/** Ids of commands that are recorded when a macro is being recorded. */
export const MACRO_COMMANDS = new Set(COMMAND_DEFS.filter((c) => c.macro).map((c) => c.id));

/** Commands that ask the user for input: they run while recording but are not recorded (they would prompt on every pass). */
export const MACRO_NOT_RECORDED = new Set(["lineop.splitAt", "lineop.prefix", "lineop.suffix"]);

/** "CmdOrCtrl+K V" → ["CmdOrCtrl+K", "V"]. */
export function splitChord(chord: string): [string, string] {
  const [a, b = ""] = chord.trim().split(/\s+/);
  return [a, b];
}

/** The shortcut as shown in the palette and tooltips, chords included ("Ctrl+K V", "⌘K V"). */
export function shortcutLabel(def: CommandDef, mac: boolean, format: (accel: string, mac: boolean) => string): string | undefined {
  const a = accelFor(def, mac);
  if (a) return format(a, mac);
  if (def.chord) return splitChord(def.chord).map((p) => format(p, mac)).join(" ");
  return undefined;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

/**
 * Two-step shortcuts. `handle` is called for every key press: it answers "consume" for the first step
 * (the key must not reach the editor), the command id for the second, and "pass" for anything else.
 * A key that does not complete the chord cancels it and is passed on. The second key may be pressed
 * with or without Ctrl/Cmd still held, as in VS Code.
 */
export class ChordMatcher {
  private pending: { defs: CommandDef[]; at: number } | null = null;

  constructor(
    private readonly defs: CommandDef[],
    private readonly mac: boolean,
    private readonly timeoutMs = 3000,
  ) {}

  get waiting(): boolean {
    return this.pending !== null;
  }

  handle(e: KeyLike, enabled: (def: CommandDef) => boolean, now = Date.now()): "pass" | "consume" | { run: string } {
    if (MODIFIER_KEYS.has(e.key)) return this.pending ? "consume" : "pass";
    const p = this.pending;
    this.pending = null;
    if (p && now - p.at <= this.timeoutMs) {
      for (const def of p.defs) {
        const second = splitChord(def.chord!)[1];
        if (matchesAccel(e, second, this.mac) || matchesAccel(e, `CmdOrCtrl+${second}`, this.mac)) return { run: def.id };
      }
      return "pass";
    }
    const started = this.defs.filter((d) => d.chord && enabled(d) && matchesAccel(e, splitChord(d.chord)[0], this.mac));
    if (!started.length) return "pass";
    this.pending = { defs: started, at: now };
    return "consume";
  }

  cancel(): void {
    this.pending = null;
  }
}

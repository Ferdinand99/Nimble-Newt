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

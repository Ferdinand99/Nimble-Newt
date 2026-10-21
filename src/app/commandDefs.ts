// Command ids and shortcuts, free of DOM/Tauri imports so they can be tested.
// Keep the accelerators in sync with src-tauri/src/menu.rs.

export interface CommandDef {
  id: string;
  accel?: string;
  accelMac?: string;
  /** Handled by the editor's own keymap; the app-level shortcut handler leaves it alone. */
  editor?: boolean;
}

export const COMMAND_DEFS: CommandDef[] = [
  { id: "file.new", accel: "CmdOrCtrl+N" },
  { id: "file.open", accel: "CmdOrCtrl+O" },
  { id: "file.quickOpen", accel: "CmdOrCtrl+P" },
  { id: "file.save", accel: "CmdOrCtrl+S" },
  { id: "file.saveAs", accel: "CmdOrCtrl+Shift+S" },
  { id: "file.saveAll", accel: "CmdOrCtrl+Alt+S" },
  { id: "file.close", accel: "CmdOrCtrl+W" },
  { id: "file.closeOthers" },
  { id: "file.reopenClosed", accel: "CmdOrCtrl+Shift+T" },
  { id: "edit.undo", accel: "CmdOrCtrl+Z" },
  { id: "edit.redo", accel: "CmdOrCtrl+Y", accelMac: "CmdOrCtrl+Shift+Z" },
  { id: "edit.selectAll", accel: "CmdOrCtrl+A" },
  { id: "edit.find", accel: "CmdOrCtrl+F" },
  { id: "edit.replace", accel: "CmdOrCtrl+H", accelMac: "Alt+CmdOrCtrl+F" },
  { id: "edit.findNext", accel: "F3" },
  { id: "edit.findPrev", accel: "Shift+F3" },
  { id: "edit.findInFiles", accel: "CmdOrCtrl+Shift+F" },
  { id: "edit.gotoLine", accel: "CmdOrCtrl+G", accelMac: "CmdOrCtrl+L" },
  { id: "edit.duplicateLine", accel: "CmdOrCtrl+Shift+D", editor: true },
  { id: "edit.deleteLine", accel: "CmdOrCtrl+Shift+K", editor: true },
  { id: "edit.moveLineUp", accel: "Alt+Up", editor: true },
  { id: "edit.moveLineDown", accel: "Alt+Down", editor: true },
  { id: "edit.toggleComment", accel: "CmdOrCtrl+/", editor: true },
  { id: "edit.toggleBlockComment", accel: "CmdOrCtrl+Shift+A", editor: true },
  { id: "edit.selectNext", accel: "CmdOrCtrl+D", editor: true },
  { id: "edit.addCursorAbove", accel: "CmdOrCtrl+Alt+Up", editor: true },
  { id: "edit.addCursorBelow", accel: "CmdOrCtrl+Alt+Down", editor: true },
  { id: "edit.upperCase" },
  { id: "edit.lowerCase" },
  { id: "edit.trimTrailing" },
  { id: "edit.sortLines" },
  { id: "view.palette", accel: "CmdOrCtrl+Shift+P" },
  { id: "view.wrap", accel: "Alt+Z" },
  { id: "view.whitespace" },
  { id: "view.zoomIn", accel: "CmdOrCtrl+=" },
  { id: "view.zoomOut", accel: "CmdOrCtrl+-" },
  { id: "view.zoomReset", accel: "CmdOrCtrl+0" },
  { id: "view.nextTab", accel: "Ctrl+Tab" },
  { id: "view.prevTab", accel: "Ctrl+Shift+Tab" },
  { id: "view.themeSystem" },
  { id: "view.themeLight" },
  { id: "view.themeDark" },
  { id: "doc.language" },
  { id: "doc.encoding" },
  { id: "doc.eol" },
  { id: "doc.indent" },
  { id: "app.settings", accel: "CmdOrCtrl+," },
  { id: "app.checkUpdates" },
  { id: "app.about" },
];

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
  let ctrl = false, meta = false, alt = false, shift = false;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "cmdorctrl") {
      if (mac) meta = true;
      else ctrl = true;
    }
    else if (l === "ctrl") ctrl = true;
    else if (l === "alt") alt = true;
    else if (l === "shift") shift = true;
  }
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== alt || e.shiftKey !== shift) return false;
  const k = key.toLowerCase();
  if (k.length === 1 && /[a-z]/.test(k)) return e.code === `Key${k.toUpperCase()}` || e.key.toLowerCase() === k;
  if (k.length === 1 && /[0-9]/.test(k)) return e.code === `Digit${k}` || e.key === k;
  if (k === "=") return e.key === "=" || e.key === "+" || e.code === "Equal";
  if (k === "-") return e.key === "-" || e.code === "Minus";
  if (k === ",") return e.key === "," || e.code === "Comma";
  if (k === "/") return e.key === "/" || e.code === "Slash";
  if (k === "up") return e.key === "ArrowUp";
  if (k === "down") return e.key === "ArrowDown";
  if (k === "tab") return e.key === "Tab";
  return e.key.toLowerCase() === k;
}

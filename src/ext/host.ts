import { EditorSelection } from "@codemirror/state";
import { workspace } from "../app/workspace";
import { api, errorMessage, type InstalledExtension, type ExtManifest } from "../lib/api";
import { h } from "../lib/dom";
import { t, resolveLocale } from "../lib/i18n";
import { settings } from "../lib/settings";
import { openSheet, promptText } from "../ui/dialog";
import { quickPick } from "../ui/palette";
import { toast } from "../ui/toast";
import { BUILTIN } from "./builtin";
import { LIMITS, type Permission } from "./protocol";
import { setExtensionCommands, splitCommandId, type ExtCommand } from "./registry";
import { Sandbox } from "./sandbox";

interface Rec {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: Permission[];
  commands: { id: string; title: string }[];
  builtin: boolean;
  enabled: boolean;
  sandbox: Sandbox | null;
  problem?: string;
}

const records = new Map<string, Rec>();
const locale = () => resolveLocale(settings.value.locale);

function fromBuiltin(): Rec[] {
  return BUILTIN.map((b) => ({
    id: b.manifest.id,
    name: b.manifest.name,
    version: b.manifest.version,
    description: b.manifest.description,
    author: b.manifest.author,
    permissions: b.manifest.permissions,
    commands: b.manifest.commands.map((c) => ({ id: c.id, title: locale() === "nb" ? c.titleNb : c.title })),
    builtin: true,
    enabled: true,
    sandbox: null,
  }));
}

function fromInstalled(e: InstalledExtension): Rec {
  const m = e.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    permissions: m.permissions as Permission[],
    commands: m.contributes.commands.map((c) => ({ id: c.id, title: c.title })),
    builtin: false,
    enabled: e.enabled,
    sandbox: null,
  };
}

function publish(): void {
  const list: ExtCommand[] = [];
  for (const r of records.values()) {
    if (!r.enabled) continue;
    for (const c of r.commands) list.push({ id: `ext:${r.id}:${c.id}`, title: `${r.name}: ${c.title}`.replace(/^([^:]+): \1: /, "$1: ") });
  }
  setExtensionCommands(list);
  void api.setExtensionMenu(locale(), list.map((c) => ({ id: c.id, label: c.title }))).catch(() => {});
}

/** Reads installed manifests (not their scripts) and publishes the commands. Called after the first paint. */
export async function initExtensions(): Promise<void> {
  records.clear();
  for (const b of fromBuiltin()) records.set(b.id, b);
  try {
    const { extensions, problems } = await api.extList();
    for (const e of extensions) if (!records.has(e.manifest.id)) records.set(e.manifest.id, fromInstalled(e));
    for (const p of problems) console.warn("extension problem:", p);
  } catch (e) {
    console.warn("could not list extensions", e);
  }
  publish();
}

// ---- the API an extension can call -------------------------------------------------------

function selectionText(): { text: string; ranges: { from: number; to: number }[] } {
  const v = workspace.focusedView();
  const ranges = v.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  return { text: ranges.map((r) => v.state.sliceDoc(r.from, r.to)).join("\n"), ranges };
}

function handler(rec: Rec) {
  return async (method: string, p: { [k: string]: unknown }): Promise<unknown> => {
    const v = workspace.focusedView();
    const doc = workspace.active;
    switch (method) {
      case "editor.getText": {
        if (v.state.doc.length > LIMITS.textBytes) throw new Error("The document is too large for extensions.");
        return v.state.doc.toString();
      }
      case "editor.getSelection":
        return selectionText();
      case "editor.getLanguage":
        return doc?.langId ?? "plaintext";
      case "editor.getFileName":
        return doc?.title ?? "";
      case "editor.replaceSelection":
        v.dispatch(v.state.changeByRange((r) => ({ changes: { from: r.from, to: r.to, insert: String(p.text) }, range: EditorSelection.range(r.from, r.from + String(p.text).length) })), { userEvent: "input.extension" });
        return null;
      case "editor.insertText":
        v.dispatch(v.state.changeByRange((r) => ({ changes: { from: r.from, to: r.to, insert: String(p.text) }, range: EditorSelection.cursor(r.from + String(p.text).length) })), { userEvent: "input.extension" });
        return null;
      case "editor.replaceAll":
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: String(p.text) }, userEvent: "input.extension" });
        return null;
      case "ui.message":
        toast(`${rec.name}: ${String(p.text)}`, (p.kind as "info" | "success" | "warning" | "error") ?? "info");
        return null;
      case "ui.prompt": {
        // The command timeout stops while the user is typing, and the dialog says whose it is.
        const release = rec.sandbox?.hold();
        try {
          return await promptText(`${rec.name}: ${String(p.title)}`, String(p.placeholder ?? ""), String(p.value ?? ""));
        } finally {
          release?.();
        }
      }
      case "ui.pick": {
        const items = (p.items as string[]).map((label, i) => ({ label, value: i }));
        const release = rec.sandbox?.hold();
        try {
          const i = await quickPick(items, `${rec.name}: ${String(p.title)}`);
          return i === null ? null : (p.items as string[])[i];
        } finally {
          release?.();
        }
      }
      case "clipboard.writeText":
        await navigator.clipboard.writeText(String(p.text));
        return null;
      case "storage.get":
        return api.extStorageGet(rec.id, String(p.key));
      case "storage.set":
        await api.extStorageSet(rec.id, String(p.key), String(p.value));
        return null;
      case "storage.remove":
        await api.extStorageRemove(rec.id, String(p.key));
        return null;
    }
    throw new Error(`unknown method ${method}`);
  };
}

async function scriptFor(rec: Rec): Promise<string> {
  if (rec.builtin) return BUILTIN.find((b) => b.manifest.id === rec.id)!.code;
  return api.extReadMain(rec.id);
}

async function ensureRunning(rec: Rec): Promise<Sandbox> {
  if (rec.sandbox?.running) return rec.sandbox;
  const code = await scriptFor(rec);
  rec.sandbox = new Sandbox(rec.id, code, rec.permissions, handler(rec), (reason) => {
    // A runaway extension is switched off until the user turns it back on.
    rec.enabled = false;
    rec.problem = reason;
    if (!rec.builtin) void api.extSetEnabled(rec.id, false).catch(() => {});
    publish();
    toast(t("ext.stopped", { name: rec.name }), "warning", 8000);
  });
  await rec.sandbox.start();
  return rec.sandbox;
}

/** Runs `ext:<id>:<command>`; starts the extension's sandbox on first use. */
export async function runExtensionCommand(fullId: string): Promise<void> {
  const parts = splitCommandId(fullId);
  const rec = parts && records.get(parts.ext);
  if (!parts || !rec || !rec.enabled) return;
  try {
    const sb = await ensureRunning(rec);
    // The script registers its handlers asynchronously right after it starts.
    for (let i = 0; i < 20 && !sb.hasCommand(parts.command); i++) await new Promise((r) => setTimeout(r, 25));
    if (!sb.hasCommand(parts.command)) throw new Error(t("ext.noHandler", { command: parts.command }));
    await sb.run(parts.command, { locale: locale() });
  } catch (e) {
    toast(t("ext.failed", { name: rec.name, error: errorMessage(e) }), "error", 8000);
  }
}

// ---- management UI -----------------------------------------------------------------------

export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: Permission[];
  builtin: boolean;
  enabled: boolean;
  problem?: string;
}

export const listExtensions = (): ExtensionRow[] => [...records.values()].map(({ sandbox: _s, commands: _c, ...row }) => row);

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const rec = records.get(id);
  if (!rec) return;
  rec.enabled = enabled;
  rec.problem = undefined;
  if (!enabled) {
    rec.sandbox?.kill();
    rec.sandbox = null;
  }
  if (!rec.builtin) await api.extSetEnabled(id, enabled);
  publish();
}

export async function removeExtension(id: string): Promise<void> {
  const rec = records.get(id);
  if (!rec || rec.builtin) return;
  rec.sandbox?.kill();
  await api.extRemove(id);
  records.delete(id);
  publish();
}

const PERM_KEYS: Record<Permission, string> = {
  "editor.read": "ext.perm.editorRead",
  "editor.write": "ext.perm.editorWrite",
  ui: "ext.perm.ui",
  "clipboard.write": "ext.perm.clipboard",
  storage: "ext.perm.storage",
};
export const permissionText = (p: Permission): string => t(PERM_KEYS[p]);

/** Validates a folder or .nnext file, asks for consent and installs it. */
export async function installFrom(path: string): Promise<boolean> {
  let manifest: ExtManifest;
  try {
    manifest = await api.extInspect(path);
  } catch (e) {
    toast(t("ext.invalid", { error: errorMessage(e) }), "error", 9000);
    return false;
  }
  const existing = records.get(manifest.id);
  if (existing?.builtin) {
    toast(t("ext.builtinId"), "error");
    return false;
  }
  const perms = manifest.permissions as Permission[];
  const yes = await openSheet<boolean>({
    title: t("ext.installTitle", { name: manifest.name }),
    alert: true,
    body: [
      h("p", {}, manifest.description || t("ext.noDescription")),
      h("p", { class: "muted" }, `${manifest.author ? manifest.author + " · " : ""}${t("ext.version", { version: manifest.version })}`),
      h("div", { class: "group-title" }, t("ext.wants")),
      perms.length
        ? h("ul", { class: "inset-list" }, ...perms.map((p) => h("li", { class: "list-row" }, h("span", {}, permissionText(p)))))
        : h("p", { class: "muted" }, t("ext.wantsNothing")),
      h("p", { class: "muted", style: "margin-top:10px" }, t("ext.sandboxNote")),
    ],
    dismissValue: false,
    choices: [
      { value: false, label: t("common.cancel") },
      { value: true, label: existing ? t("ext.update") : t("ext.install"), kind: "primary" },
    ],
  });
  if (!yes) return false;
  try {
    await api.extInstall(path, !!existing, manifest);
    existing?.sandbox?.kill();
    await initExtensions();
    toast(t("ext.installed", { name: manifest.name }), "success");
    return true;
  } catch (e) {
    toast(t("ext.invalid", { error: errorMessage(e) }), "error", 9000);
    return false;
  }
}

/** Used by CI (`NIMBLE_EXT_SELFTEST`): runs the built-in Word Count through the real sandbox and reports the result. */
export async function selfTest(): Promise<void> {
  let ok = false;
  let message = "no result";
  try {
    if (records.size === 0) await initExtensions();
    const view = workspace.focusedView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "one two three four\n" } });
    void runExtensionCommand("ext:app.wordcount:count");
    for (let i = 0; i < 100 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const text = [...document.querySelectorAll(".toast")].map((e) => e.textContent ?? "").join(" | ");
      if (/\b4 (words|ord)\b/.test(text)) {
        ok = true;
        message = text;
      } else if (text) message = text;
    }
  } catch (e) {
    message = errorMessage(e);
  }
  await api.selftestDone(ok, message);
}

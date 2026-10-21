import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import {
  formatFromPath,
  importDefinition,
  loadDefinitions,
  removeDefinition,
  serializeDefinition,
  templateAs,
} from "../lib/userLanguageStore";
import type { UserLanguageDefinition } from "../lib/userLanguage";
import "../styles/userlang.css";
import { confirmSheet, openSheet } from "./dialog";
import { toast } from "./toast";

const FILTERS = [{ name: "Language definition", extensions: ["json", "toml"] }];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function writeText(path: string, text: string): Promise<void> {
  await api.saveFile(path, text, "UTF-8", "LF", null);
}

async function exportDefinition(def: UserLanguageDefinition): Promise<void> {
  const path = await saveDialog({ title: t("lang.dialogExport"), defaultPath: `${def.id}.json`, filters: FILTERS });
  if (!path) return;
  await writeText(path, await serializeDefinition(def, formatFromPath(path)));
  toast(t("lang.exported", { name: def.name }), "success");
}

async function importFromDisk(): Promise<boolean> {
  const sel = await openDialog({ multiple: false, directory: false, title: t("lang.dialogImport"), filters: FILTERS });
  const path = Array.isArray(sel) ? sel[0] : sel;
  if (!path) return false;
  const file = await api.openFile(path, "LF");
  const def = await importDefinition(file.text, formatFromPath(path));
  toast(t("lang.imported", { name: def.name }), "success");
  return true;
}

async function saveTemplate(): Promise<void> {
  const path = await saveDialog({ title: t("lang.dialogTemplate"), defaultPath: "language-template.toml", filters: FILTERS });
  if (!path) return;
  await writeText(path, await templateAs(formatFromPath(path)));
  toast(t("lang.templateSaved"), "success");
}

export async function openLanguagesSheet(): Promise<void> {
  const list = h("ul", { class: "inset-list" });
  const holder = h("div", {});

  const guarded = (fn: () => Promise<unknown>) => async () => {
    try {
      if ((await fn()) !== false) await render();
    } catch (e) {
      toast(t("lang.failed", { error: message(e) }), "error");
    }
  };

  async function render(): Promise<void> {
    const defs = await loadDefinitions();
    list.replaceChildren();
    if (!defs.length) holder.replaceChildren(h("div", { class: "userlang-empty" }, t("lang.empty")));
    else holder.replaceChildren(list);
    for (const def of defs) {
      const exts = def.extensions.map((e) => `.${e}`).concat(def.filenames).join(" ");
      list.append(
        h(
          "li",
          { class: "list-row" },
          h("div", { class: "list-row-text" }, h("div", { class: "list-row-label" }, def.name), h("div", { class: "list-row-hint" }, exts || def.id)),
          h(
            "div",
            { class: "userlang-row-actions" },
            h("button", { class: "btn btn-sm", type: "button", onclick: guarded(() => exportDefinition(def).then(() => false)) }, t("lang.export")),
            h(
              "button",
              {
                class: "btn btn-sm btn-danger",
                type: "button",
                onclick: guarded(async () => {
                  if (!(await confirmSheet(t("lang.delete"), t("lang.deleteConfirm", { name: def.name }), t("lang.delete"), true))) return false;
                  await removeDefinition(def.id);
                  toast(t("lang.deleted", { name: def.name }), "info");
                }),
              },
              t("lang.delete"),
            ),
          ),
        ),
      );
    }
  }

  const body = [
    h("p", { class: "userlang-hint" }, t("lang.hint")),
    h("div", { class: "group-title" }, t("lang.title")),
    holder,
    h(
      "div",
      { class: "userlang-actions" },
      h("button", { class: "btn", type: "button", onclick: guarded(importFromDisk) }, t("lang.import")),
      h("button", { class: "btn", type: "button", onclick: guarded(() => saveTemplate().then(() => false)) }, t("lang.template")),
    ),
  ];
  await render();
  await openSheet<null>({ title: t("lang.title"), body, dismissValue: null, choices: [{ value: null, label: t("common.done"), kind: "primary" }] });
}

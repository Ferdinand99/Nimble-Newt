import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates } from "../app/updater";
import { EOLS, listEncodings } from "../lib/api";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import { FONT_MAX, FONT_MIN, settings, type Settings } from "../lib/settings";
import { openSheet } from "./dialog";

function row(label: string, control: Node, hint?: string): HTMLElement {
  return h("li", { class: "list-row" }, h("div", { class: "list-row-text" }, h("div", { class: "list-row-label" }, label), hint ? h("div", { class: "list-row-hint" }, hint) : null), control);
}

function segmented<K extends keyof Settings>(key: K, options: [Settings[K], string][], label: string): HTMLElement {
  const wrap = h("div", { class: "segmented", role: "group", "aria-label": label });
  const sync = () => wrap.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(settings.value[key] === options[i][0])));
  options.forEach(([value, text]) => wrap.append(h("button", { type: "button", onclick: () => { settings.set({ [key]: value } as Partial<Settings>); sync(); } }, text)));
  sync();
  return wrap;
}

function toggle(key: { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings], label: string): HTMLElement {
  const input = h("input", { class: "switch-input", type: "checkbox", role: "switch", "aria-label": label, checked: settings.value[key] });
  input.addEventListener("change", () => settings.set({ [key]: input.checked } as Partial<Settings>));
  return h("label", { class: "switch" }, input, h("span", { class: "switch-ui" }));
}

function select<K extends "defaultEncoding" | "defaultEol">(key: K, values: readonly string[], label: string, text: (v: string) => string = (v) => v, groups?: Map<string, string[]>): HTMLElement {
  const sel = h("select", { class: "input", style: "width:auto", "aria-label": label });
  const opt = (v: string) => h("option", { value: v, selected: settings.value[key] === v }, text(v));
  if (groups) {
    for (const [g, list] of groups) sel.append(h("optgroup", { label: g }, ...list.map(opt)));
  } else {
    for (const v of values) sel.append(opt(v));
  }
  sel.addEventListener("change", () => settings.set({ [key]: sel.value } as Partial<Settings>));
  return sel;
}

function stepper(key: "fontSize" | "tabSize", min: number, max: number, label: string): HTMLElement {
  const input = h("input", { class: "input", type: "number", min: String(min), max: String(max), value: String(settings.value[key]), "aria-label": label });
  const set = (n: number) => {
    settings.set({ [key]: n } as Partial<Settings>);
    input.value = String(settings.value[key]);
  };
  input.addEventListener("change", () => set(Number(input.value)));
  const dec = h("button", { class: "btn btn-icon btn-sm", type: "button", "aria-label": t("settings.decrease"), onclick: () => set(settings.value[key] - 1) }, "−");
  const inc = h("button", { class: "btn btn-icon btn-sm", type: "button", "aria-label": t("settings.increase"), onclick: () => set(settings.value[key] + 1) }, "+");
  return h("div", { class: "settings-row-stepper" }, dec, input, inc);
}

export async function openSettings(): Promise<void> {
  const version = await getVersion().catch(() => "");
  const encodings = await listEncodings().catch(() => []);
  const groups = new Map<string, string[]>();
  for (const e of encodings) {
    const g = e.group === "Unicode" ? t("enc.group.unicode") : t(`enc.group.${e.group}`);
    groups.set(g, [...(groups.get(g) ?? []), e.label]);
  }
  const list = (...rows: HTMLElement[]) => h("ul", { class: "inset-list" }, ...rows);
  const body = [
    h("div", { class: "group-title" }, t("settings.appearance")),
    list(
      row(t("settings.theme"), segmented("theme", [["system", t("settings.themeSystem")], ["light", t("settings.themeLight")], ["dark", t("settings.themeDark")]], t("settings.theme"))),
      row(t("settings.language"), segmented("locale", [["auto", t("settings.langAuto")], ["en", "English"], ["nb", "Norsk"]], t("settings.language")), t("settings.languageHint")),
      row(t("settings.fontSize"), stepper("fontSize", FONT_MIN, FONT_MAX, t("settings.fontSize"))),
    ),
    h("div", { class: "group-title" }, t("settings.editing")),
    list(
      row(t("settings.insertSpaces"), toggle("insertSpaces", t("settings.insertSpaces")), t("settings.insertSpacesHint")),
      row(t("settings.tabSize"), stepper("tabSize", 1, 16, t("settings.tabSize"))),
      row(t("settings.wordWrap"), toggle("wordWrap", t("settings.wordWrap"))),
      row(t("settings.showWhitespace"), toggle("showWhitespace", t("settings.showWhitespace"))),
      row(t("settings.minimap"), toggle("minimap", t("settings.minimap")), t("settings.minimapHint")),
      row(t("settings.wordCompletion"), toggle("wordCompletion", t("settings.wordCompletion")), t("settings.wordCompletionHint")),
    ),
    h("div", { class: "group-title" }, t("settings.files")),
    list(
      row(t("settings.defaultEncoding"), select("defaultEncoding", [], t("settings.defaultEncoding"), undefined, groups.size ? groups : undefined), t("settings.defaultEncodingHint")),
      row(t("settings.defaultEol"), select("defaultEol", EOLS, t("settings.defaultEol"), (v) => t(`eol.${v}`))),
      row(t("settings.restoreSession"), toggle("restoreSession", t("settings.restoreSession")), t("settings.restoreSessionHint")),
    ),
    h("div", { class: "group-title" }, t("settings.updates")),
    list(
      row(t("settings.autoUpdate"), toggle("autoUpdate", t("settings.autoUpdate")), t("settings.autoUpdateHint")),
      row(version ? t("settings.version", { version }) : t("settings.updates"), h("button", { class: "btn btn-sm", type: "button", onclick: () => { void checkForUpdates(true); } }, t("settings.checkNow"))),
    ),
  ];
  await openSheet<null>({
    title: t("settings.title"),
    body,
    dismissValue: null,
    choices: [{ value: null, label: t("common.done"), kind: "primary" }],
  });
}

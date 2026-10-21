import { EditorSelection } from "@codemirror/state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../lib/api";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import * as tools from "../lib/tools";
import { openSheet } from "../ui/dialog";
import { toast } from "../ui/toast";
import { workspace } from "./workspace";

type Fn = (s: string) => tools.Result | string;

const indentUnit = (): string | number => {
  const i = workspace.active?.indent;
  return i?.useTabs ? "\t" : (i?.size ?? 2);
};

/** Applies `fn` to every non-empty selection, or to the whole document when nothing is selected. */
function transform(fn: Fn): void {
  const v = workspace.view;
  const ranges = v.state.selection.ranges.filter((r) => !r.empty);
  const spans = ranges.length ? ranges.map((r) => ({ from: r.from, to: r.to })) : [{ from: 0, to: v.state.doc.length }];
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const { from, to } of spans) {
    const r = fn(v.state.sliceDoc(from, to));
    const res: tools.Result = typeof r === "string" ? { ok: true, text: r } : r;
    if (!res.ok) return void toast(t("tools.failed", { error: res.error }), "error");
    changes.push({ from, to, insert: res.text });
  }
  v.dispatch({ changes, userEvent: "input.tools" });
  workspace.focus();
}

const selectionOrDoc = (): string => {
  const v = workspace.view;
  const sel = v.state.selection.ranges.filter((r) => !r.empty).map((r) => v.state.sliceDoc(r.from, r.to));
  return sel.length ? sel.join("\n") : v.state.doc.toString();
};

function insertAtCursor(text: string): void {
  const v = workspace.view;
  v.dispatch(v.state.changeByRange((r) => ({ changes: { from: r.from, to: r.to, insert: text }, range: EditorSelection.cursor(r.from + text.length) })), { userEvent: "input.tools" });
  workspace.focus();
}

const copy = async (s: string) => {
  await navigator.clipboard.writeText(s);
  toast(t("tools.copied"), "success");
};

function resultRow(label: string, value: string): HTMLElement {
  return h("li", { class: "list-row" }, h("div", { class: "list-row-text", style: "min-width:0" }, h("div", { class: "list-row-hint" }, label), h("div", { class: "mono", style: "overflow-wrap:anywhere;font-size:0.75rem", tabIndex: 0 }, value)), h("button", { class: "btn btn-sm", type: "button", onclick: () => void copy(value) }, t("tools.copy")));
}

async function showHashes(title: string, load: () => Promise<{ algorithm: string; hex: string }[]>): Promise<void> {
  try {
    const rows = await load();
    await openSheet<null>({
      title,
      body: h("ul", { class: "inset-list" }, ...rows.map((r) => resultRow(r.algorithm.toUpperCase().replace("SHA", "SHA-"), r.hex))),
      dismissValue: null,
      choices: [{ value: null, label: t("common.done"), kind: "primary" }],
    });
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

async function timestampSheet(): Promise<void> {
  const seed = workspace.view.state.sliceDoc(workspace.view.state.selection.main.from, workspace.view.state.selection.main.to).trim();
  const input = h("input", { class: "input mono", type: "text", value: seed || String(Math.floor(Date.now() / 1000)), "aria-label": t("tools.timestampInput"), spellcheck: false });
  const out = h("ul", { class: "inset-list" });
  const render = () => {
    const m = tools.parseMoment(input.value);
    out.replaceChildren(
      ...(m
        ? [resultRow(t("tools.ts.seconds"), String(m.epochSeconds)), resultRow(t("tools.ts.millis"), String(m.epochMillis)), resultRow("ISO 8601 (UTC)", m.iso), resultRow(t("tools.ts.local"), m.local)]
        : [h("li", { class: "list-row" }, h("span", { class: "muted" }, t("tools.ts.unreadable")))]),
    );
  };
  input.addEventListener("input", render);
  render();
  await openSheet<null>({
    title: t("cmd.tools.timestamp"),
    body: [h("p", {}, t("tools.ts.hint")), input, h("div", { style: "height:10px" }), out],
    dismissValue: null,
    choices: [{ value: null, label: t("common.done"), kind: "primary" }],
    onOpen: () => input.select(),
  });
}

const table: Record<string, () => void | Promise<void>> = {
  "tools.jsonFormat": () => transform((s) => tools.formatJson(s, indentUnit())),
  "tools.jsonMinify": () => transform(tools.minifyJson),
  "tools.xmlFormat": () => transform((s) => tools.formatXml(s, indentUnit())),
  "tools.xmlMinify": () => transform(tools.minifyXml),
  "tools.base64Encode": () => transform((s) => tools.base64Encode(s)),
  "tools.base64Decode": () => transform(tools.base64Decode),
  "tools.urlEncode": () => transform(tools.urlEncode),
  "tools.urlDecode": () => transform(tools.urlDecode),
  "tools.htmlEncode": () => transform(tools.htmlEncode),
  "tools.htmlDecode": () => transform(tools.htmlDecode),
  "tools.hexEncode": () => transform(tools.hexEncode),
  "tools.hexDecode": () => transform(tools.hexDecode),
  "tools.hash": () => showHashes(t("cmd.tools.hash"), () => api.hashText(selectionOrDoc(), ["md5", "sha1", "sha256", "sha512"])),
  "tools.hashFile": async () => {
    const p = await openDialog({ multiple: false, directory: false, title: t("tools.pickFile") });
    if (typeof p === "string") await showHashes(p, () => api.hashFile(p, ["md5", "sha1", "sha256", "sha512"]));
  },
  "tools.timestamp": timestampSheet,
  "tools.insertTimestamp": () => insertAtCursor(new Date().toISOString()),
  "tools.insertUuid": () => insertAtCursor(tools.uuidV4()),
  "tools.insertUuidV7": () => insertAtCursor(tools.uuidV7()),
};

export const TOOL_IDS = Object.keys(table);

export async function runTool(id: string): Promise<void> {
  await table[id]?.();
}

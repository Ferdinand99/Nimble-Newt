import { runTool } from "../app/toolsCommands";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import "../styles/tools.css";

const GROUPS: [string, string[]][] = [
  ["tools.group.json", ["tools.jsonFormat", "tools.jsonMinify"]],
  ["tools.group.xml", ["tools.xmlFormat", "tools.xmlMinify"]],
  ["tools.group.encode", ["tools.base64Encode", "tools.base64Decode", "tools.urlEncode", "tools.urlDecode", "tools.htmlEncode", "tools.htmlDecode", "tools.hexEncode", "tools.hexDecode"]],
  ["tools.group.hash", ["tools.hash", "tools.hashFile"]],
  ["tools.group.insert", ["tools.timestamp", "tools.insertTimestamp", "tools.insertUuid", "tools.insertUuidV7"]],
];

/** Buttons for the text tools; each acts on the selection, or on the whole document when nothing is selected. */
export function createToolsPanel(host: HTMLElement): void {
  const root = h("div", { class: "tools" }, h("p", { class: "tools-hint" }, t("tools.scopeHint")));
  for (const [title, ids] of GROUPS) {
    root.append(h("div", { class: "group-title" }, t(title)), h("div", { class: "tools-grid" }, ...ids.map((id) => h("button", { class: "btn btn-sm", type: "button", onclick: () => void runTool(id) }, t(`cmd.${id}`)))));
  }
  host.append(root);
}

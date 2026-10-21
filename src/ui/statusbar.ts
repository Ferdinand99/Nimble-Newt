import { toggleRecording } from "../app/macros";
import { workspace } from "../app/workspace";
import { recorder } from "../editor/macroRecorder";
import { COMMON_ENCODINGS, EOLS } from "../lib/api";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import { getLanguage, LANGUAGES } from "../lib/languages";
import { promptNumber } from "./dialog";
import { pickEncoding } from "./encodingPick";
import { showMenu, type MenuEntry } from "./menu";
import { quickPick } from "./palette";

type Item = HTMLButtonElement;
const item = (cls: string, onClick: (b: Item) => void): Item => {
  const b = h("button", { class: `status-item ${cls}`, type: "button" }) as Item;
  b.addEventListener("click", () => onClick(b));
  return b;
};

export interface StatusHandles {
  setUpdate(version: string | null, onClick?: () => void): void;
}

export function initStatusbar(): StatusHandles {
  const bar = document.getElementById("statusbar")!;
  const pos = item("pos", () => void goToLine());
  const sel = h("span", { class: "status-item", style: "pointer-events:none" });
  const indent = item("indent", (b) => indentMenu(b));
  const lang = item("lang", () => void pickLanguage());
  const enc = item("enc", (b) => encodingMenu(b));
  const eol = item("eol", (b) => eolMenu(b));
  const rec = item("status-rec", () => toggleRecording());
  rec.hidden = true;
  const follow = item("status-update", () => {
    const d = workspace.active;
    if (d?.follow) workspace.toggleFollow(d);
  });
  follow.hidden = true;
  const update = item("status-update", () => updateClick?.());
  update.hidden = true;
  let updateClick: (() => void) | undefined;
  bar.append(pos, sel, rec, follow, h("span", { class: "spacer" }), update, indent, lang, enc, eol);

  const render = () => {
    const d = workspace.active;
    if (!d) return;
    const st = workspace.view.state;
    const main = st.selection.main;
    const line = st.doc.lineAt(main.head);
    pos.textContent = t("status.pos", { line: line.number, col: main.head - line.from + 1 });
    const n = st.selection.ranges.length;
    if (n > 1) sel.textContent = t("status.cursors", { n });
    else if (!main.empty) {
      const lines = st.doc.lineAt(main.to).number - st.doc.lineAt(main.from).number + 1;
      sel.textContent = t("status.selected", { chars: main.to - main.from, lines });
    } else sel.textContent = "";
    indent.textContent = d.indent.useTabs ? t("status.tabs", { n: d.indent.size }) : t("status.spaces", { n: d.indent.size });
    lang.textContent = getLanguage(d.langId).name;
    enc.textContent = d.encoding;
    eol.textContent = d.eol;
    follow.hidden = !d.follow;
    follow.textContent = t("follow.pill");
    follow.title = t("follow.pillHint");
    pos.title = t("status.gotoLine");
    indent.title = t("status.indentTitle");
    lang.title = t("status.languageTitle");
    enc.title = t("status.encodingTitle");
    eol.title = t("status.eolTitle");
  };
  workspace.on((k) => {
    if (k !== "tabs") render();
  });
  recorder.onChange(() => {
    rec.hidden = !recorder.recording;
    rec.textContent = t("macro.recording", { n: recorder.count });
    rec.title = t("macro.stopHint");
  });
  render();

  const goToLine = async () => {
    const st = workspace.view.state;
    const n = await promptNumber(t("cmd.edit.gotoLine"), t("status.lineRange", { max: st.doc.lines }), 1, st.doc.lines);
    if (n !== null) workspace.goTo(n, 0);
  };

  const pickLanguage = async () => {
    const d = workspace.active;
    if (!d) return;
    const id = await quickPick(LANGUAGES.map((l) => ({ label: l.name, detail: l.extensions.slice(0, 3).map((e) => `.${e}`).join(" "), value: l.id })), t("status.selectLanguage"), { selected: d.langId });
    if (id) {
      await workspace.setLanguage(d, id);
      workspace.focus();
    }
  };

  const indentMenu = (anchor: HTMLElement) => {
    const d = workspace.active;
    if (!d) return;
    const entries: MenuEntry[] = [
      ...[2, 3, 4, 8].map((n) => ({ label: t("status.spaces", { n }), checked: !d.indent.useTabs && d.indent.size === n, run: () => workspace.setIndent(d, { useTabs: false, size: n }) })),
      { separator: true, label: "" },
      ...[2, 4, 8].map((n) => ({ label: t("status.tabs", { n }), checked: d.indent.useTabs && d.indent.size === n, run: () => workspace.setIndent(d, { useTabs: true, size: n }) })),
    ];
    showMenu(entries, anchor);
  };

  const encodingMenu = (anchor: HTMLElement) => {
    const d = workspace.active;
    if (!d) return;
    const other = !COMMON_ENCODINGS.includes(d.encoding);
    const entries: MenuEntry[] = COMMON_ENCODINGS.map((e) => ({ label: t("status.convertTo", { enc: e }), checked: d.encoding === e, run: () => workspace.setEncoding(d, e) }));
    entries.push({ label: other ? t("status.convertToOtherCurrent", { enc: d.encoding }) : t("status.convertToOther"), checked: other, run: () => void pickEncoding(t("status.convertToOther"), d.encoding).then((e) => {
          if (e) workspace.setEncoding(d, e);
        }) });
    if (d.path) {
      entries.push({ separator: true, label: "" });
      entries.push({ label: t("status.reopenWithOther"), run: () => void pickEncoding(t("status.reopenWithOther"), d.encoding).then((e) => {
          if (e) void workspace.reopenWithEncoding(d, e);
        }) });
    }
    showMenu(entries, anchor);
  };

  const eolMenu = (anchor: HTMLElement) => {
    const d = workspace.active;
    if (!d) return;
    showMenu(EOLS.map((e) => ({ label: t(`eol.${e}`), checked: d.eol === e, run: () => workspace.setEol(d, e) })), anchor);
  };

  return {
    setUpdate(version, onClick) {
      update.hidden = !version;
      update.textContent = version ? t("update.statusPill", { version }) : "";
      updateClick = onClick;
    },
  };
}

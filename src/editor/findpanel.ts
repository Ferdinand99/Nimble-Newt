import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import { debounce, h, icon } from "../lib/dom";
import { t } from "../lib/i18n";

let wantReplace = false;
export function requestReplaceRow(on: boolean): void {
  wantReplace = on;
}

const MAX_COUNT = 10000;

function toggle(label: string, ic: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-pressed": String(pressed), title: label, "aria-label": label, onclick: onClick }, icon(ic));
  return b;
}

/** Custom in-file find/replace bar, mounted by CodeMirror's search extension. */
export function createFindPanel(view: EditorView): Panel {
  const q0 = getSearchQuery(view.state);
  const findInput = h("input", { class: "input", type: "text", placeholder: t("find.find"), "aria-label": t("find.find"), value: q0.search, spellcheck: false, "main-field": "true" });
  const replaceInput = h("input", { class: "input", type: "text", placeholder: t("find.replaceWith"), "aria-label": t("find.replaceWith"), value: q0.replace, spellcheck: false });
  const count = h("span", { class: "find-count", "aria-live": "polite" });
  const state = { caseSensitive: q0.caseSensitive, regexp: q0.regexp, wholeWord: q0.wholeWord };

  const commit = () => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: findInput.value, replace: replaceInput.value, ...state })) });
  };
  const pressed = (b: HTMLButtonElement, on: boolean) => b.setAttribute("aria-pressed", String(on));
  const bCase = toggle(t("find.matchCase"), "case", state.caseSensitive, () => { state.caseSensitive = !state.caseSensitive; pressed(bCase, state.caseSensitive); commit(); });
  const bWord = toggle(t("find.wholeWord"), "word", state.wholeWord, () => { state.wholeWord = !state.wholeWord; pressed(bWord, state.wholeWord); commit(); });
  const bRegex = toggle(t("find.regex"), "regex", state.regexp, () => { state.regexp = !state.regexp; pressed(bRegex, state.regexp); commit(); });
  const bPrev = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: `${t("find.previous")} (Shift+F3)`, "aria-label": t("find.previous"), onclick: () => findPrevious(view) }, icon("arrow-up"));
  const bNext = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: `${t("find.next")} (F3)`, "aria-label": t("find.next"), onclick: () => findNext(view) }, icon("arrow-down"));
  const bClose = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("common.close"), onclick: () => { closeSearchPanel(view); view.focus(); } }, icon("x"));
  const bReplace = h("button", { class: "btn btn-sm", type: "button", onclick: () => replaceNext(view) }, t("find.replace"));
  const bReplaceAll = h("button", { class: "btn btn-sm", type: "button", onclick: () => replaceAll(view) }, t("find.replaceAll"));
  const bExpand = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("find.toggleReplace"), "aria-pressed": String(wantReplace), onclick: () => setReplace(replaceRow.hidden) }, icon("replace"));

  const replaceRow = h("div", { class: "find-row" }, replaceInput, bReplace, bReplaceAll);
  replaceRow.hidden = !wantReplace;
  const setReplace = (on: boolean) => {
    replaceRow.hidden = !on;
    bExpand.setAttribute("aria-pressed", String(on));
    if (on) replaceInput.focus();
  };

  const dom = h("div", { class: "find", role: "search" }, h("div", { class: "find-row" }, bExpand, findInput, bCase, bWord, bRegex, count, bPrev, bNext, bClose), replaceRow);

  const updateCount = debounce(() => {
    const q = getSearchQuery(view.state);
    findInput.setAttribute("aria-invalid", String(!!q.search && !q.valid));
    if (!q.search || !q.valid) {
      count.textContent = q.search && !q.valid ? t("find.invalid") : "";
      return;
    }
    const sel = view.state.selection.main;
    let n = 0;
    let cur = 0;
    const cursor = q.getCursor(view.state);
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      n++;
      if (r.value.from === sel.from && r.value.to === sel.to) cur = n;
      if (n >= MAX_COUNT) break;
    }
    const total = n >= MAX_COUNT ? `${MAX_COUNT}+` : String(n);
    count.textContent = n === 0 ? t("find.noResults") : cur ? `${cur} / ${total}` : t("find.results", { n: total });
  }, 80);

  findInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);
  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.target === replaceInput) replaceNext(view);
      else (e.shiftKey ? findPrevious : findNext)(view);
    }
  });
  updateCount();

  return {
    dom,
    top: true,
    mount() {
      if (wantReplace) setReplace(true);
      findInput.focus();
      findInput.select();
    },
    update(u: ViewUpdate) {
      const q = getSearchQuery(u.state);
      if (q.search !== findInput.value && document.activeElement !== findInput) findInput.value = q.search;
      if (q.replace !== replaceInput.value && document.activeElement !== replaceInput) replaceInput.value = q.replace;
      if (q.caseSensitive !== state.caseSensitive) { state.caseSensitive = q.caseSensitive; pressed(bCase, state.caseSensitive); }
      if (q.wholeWord !== state.wholeWord) { state.wholeWord = q.wholeWord; pressed(bWord, state.wholeWord); }
      if (q.regexp !== state.regexp) { state.regexp = q.regexp; pressed(bRegex, state.regexp); }
      updateCount();
    },
    destroy() {
      updateCount.cancel();
    },
  };
}

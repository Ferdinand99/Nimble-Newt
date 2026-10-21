import { macroCommand, recorder, viewRunner } from "../editor/macroRecorder";
import { api } from "../lib/api";
import { isMac } from "../lib/dom";
import { t } from "../lib/i18n";
import { formatShortcut } from "../lib/logic";
import { parseMacros, playMacro, upsertMacro, type Macro, type MacroStep, type PlayResult } from "../lib/macro";
import { promptNumber, promptText } from "../ui/dialog";
import { quickPick } from "../ui/palette";
import { toast } from "../ui/toast";
import { workspace } from "./workspace";

let last: MacroStep[] | null = null;
let saved: Macro[] = [];
let runApp: (id: string) => boolean = () => false;
let cancelRequested = false;

export function initMacros(app: (id: string) => boolean): void {
  runApp = app;
  void api
    .docRead("macros")
    .then((raw) => {
      try {
        saved = parseMacros(raw ? JSON.parse(raw) : null);
      } catch {
        saved = [];
      }
    })
    .catch(() => {});
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && recorder.playing) cancelRequested = true;
  }, true);
}

const persist = () => void api.docWrite("macros", JSON.stringify({ macros: saved })).catch(() => {});

export function toggleRecording(): void {
  if (!recorder.recording) {
    recorder.start();
    workspace.focus();
    return;
  }
  const steps = recorder.stop();
  if (!steps.length) {
    toast(t("macro.nothingRecorded"), "info");
    return;
  }
  last = steps;
  toast(t("macro.recorded", { n: steps.length, key: formatShortcut("CmdOrCtrl+Alt+P", isMac) }), "success");
  workspace.focus();
}

function report(r: PlayResult, untilEnd: boolean): void {
  const n = r.passes;
  switch (r.stopped) {
    case "failed": return void toast(t("macro.stoppedFailed", { n }), "warning");
    case "no-progress": return void toast(t("macro.stoppedNoProgress", { n }), "info");
    case "cancelled": return void toast(t("macro.cancelled", { n }), "info");
    default: return void toast(t(untilEnd ? "macro.playedEnd" : "macro.played", { n }), "success");
  }
}

async function play(steps: MacroStep[], mode: { times: number } | { untilEnd: true }): Promise<void> {
  if (recorder.recording) toggleRecording();
  const view = workspace.view;
  recorder.playing = true;
  cancelRequested = false;
  try {
    const result = await playMacro({ steps }, viewRunner(view, runApp), mode, {
      yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
      shouldCancel: () => cancelRequested,
    });
    report(result, "untilEnd" in mode);
  } finally {
    recorder.playing = false;
    workspace.focus();
  }
}

const need = (): MacroStep[] | null => {
  if (!last) toast(t("macro.noMacro"), "info");
  return last;
};

export async function playLast(): Promise<void> {
  const s = need();
  if (s) await play(s, { times: 1 });
}
export async function playMany(): Promise<void> {
  const s = need();
  if (!s) return;
  const n = await promptNumber(t("macro.times"), t("macro.timesRange"), 1, 100000);
  if (n !== null) await play(s, { times: n });
}
export async function playToEnd(): Promise<void> {
  const s = need();
  if (s) await play(s, { untilEnd: true });
}

export async function saveLast(): Promise<void> {
  const s = need();
  if (!s) return;
  const name = await promptText(t("macro.name"), t("macro.namePlaceholder"));
  if (!name) return;
  saved = upsertMacro(saved, { name, steps: s });
  persist();
  toast(t("macro.saved", { name }), "success");
}

async function pickSaved(title: string): Promise<Macro | null> {
  if (!saved.length) {
    toast(t("macro.noSaved"), "info");
    return null;
  }
  const name = await quickPick(saved.map((m) => ({ label: m.name, detail: t("macro.steps", { n: m.steps.length }), value: m.name })), title);
  return saved.find((m) => m.name === name) ?? null;
}

export async function runSaved(): Promise<void> {
  const m = await pickSaved(t("macro.pick"));
  if (!m) return;
  last = m.steps;
  await play(m.steps, { times: 1 });
}

export async function deleteSaved(): Promise<void> {
  const m = await pickSaved(t("macro.pickDelete"));
  if (!m) return;
  saved = saved.filter((x) => x !== m);
  persist();
  toast(t("macro.deleted", { name: m.name }), "info");
}

export { macroCommand };

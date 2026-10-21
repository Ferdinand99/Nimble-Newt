import { getVersion } from "@tauri-apps/api/app";
import { api, type UpdateFailure, type UpdateInfo } from "../lib/api";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import { settings } from "../lib/settings";
import { openSheet } from "../ui/dialog";
import { toast } from "../ui/toast";
import { workspace } from "./workspace";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing" };

let state: UpdateState = { kind: "idle" };
let listener: (v: string | null) => void = () => {};
let busy = false;

export function onUpdateAvailable(fn: (version: string | null) => void): void {
  listener = fn;
}

export function failureMessage(f: UpdateFailure): string {
  switch (f.kind) {
    case "offline": return t("update.errOffline");
    case "invalidSignature": return t("update.errSignature");
    case "notConfigured": return t("update.errNotConfigured");
    case "badManifest": return t("update.errManifest");
    default: return t("update.errOther", { error: f.message });
  }
}

const asFailure = (e: unknown): UpdateFailure =>
  e && typeof e === "object" && "kind" in e ? (e as UpdateFailure) : { kind: "other", message: String(e) };

/**
 * Checks GitHub for a newer release. `manual` checks report every outcome; automatic ones stay
 * quiet unless there is something to install.
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (busy || state.kind === "installing") return;
  busy = true;
  try {
    const info = await api.checkUpdate();
    if (!info) {
      state = { kind: "idle" };
      listener(null);
      if (manual) toast(t("update.upToDate", { version: await getVersion() }), "success");
      return;
    }
    state = { kind: "available", info };
    listener(info.version);
    if (manual) await showAvailable();
    else toast(t("update.available", { version: info.version }), "info", 8000);
  } catch (e) {
    const f = asFailure(e);
    // Unconfigured builds (development, forks) should not nag on every start.
    if (manual || (f.kind !== "notConfigured" && f.kind !== "offline")) toast(failureMessage(f), manual || f.kind === "invalidSignature" ? "error" : "warning", 8000);
    if (!manual) console.warn("update check failed:", f);
  } finally {
    busy = false;
  }
}

/** The "update available" sheet: version, release notes, install button. */
export async function showAvailable(): Promise<void> {
  if (state.kind !== "available") {
    await checkForUpdates(true);
    return;
  }
  const { info } = state;
  const current = await getVersion();
  const choice = await openSheet<"install" | "later">({
    title: t("update.sheetTitle", { version: info.version }),
    body: [
      h("p", {}, t("update.sheetBody", { current })),
      info.notes ? h("div", { class: "sheet-notes", tabIndex: 0 }, info.notes) : h("p", {}, t("update.noNotes")),
    ],
    dismissValue: "later",
    choices: [
      { value: "later", label: t("update.later") },
      { value: "install", label: t("update.install"), kind: "primary" },
    ],
  });
  if (choice === "install") await install();
}

async function install(): Promise<void> {
  if (state.kind !== "available") return;
  state = { kind: "installing" };
  const bar = h("div", { class: "progress indeterminate" }, h("i"));
  const label = h("p", {}, t("update.downloading"));
  let finish: (() => void) | undefined;
  const dialog = openSheet<null>({
    title: t("update.installing"),
    alert: true,
    closable: false,
    body: [label, bar],
    dismissValue: null,
    onOpen: (_d, close) => (finish = () => close(null)),
  });
  try {
    // Unsaved tabs live in the session store, so they come back after the restart. Make sure it is current.
    await workspace.flush();
    let received = 0;
    await api.installUpdate((e) => {
      if (e.event === "progress") {
        received += e.chunk;
        if (e.total) {
          bar.classList.remove("indeterminate");
          bar.style.setProperty("--p", `${Math.min(100, (received / e.total) * 100).toFixed(1)}%`);
          label.textContent = t("update.downloadingPct", { pct: Math.round((received / e.total) * 100) });
        }
      } else {
        label.textContent = t("update.installingNow");
        bar.classList.add("indeterminate");
      }
    });
    finish?.();
    await dialog;
    const restart = await openSheet<boolean>({
      title: t("update.readyTitle"),
      alert: true,
      body: h("p", {}, t("update.readyBody")),
      dismissValue: false,
      choices: [
        { value: false, label: t("update.restartLater") },
        { value: true, label: t("update.restart"), kind: "primary" },
      ],
    });
    state = { kind: "idle" };
    listener(null);
    if (restart) {
      await workspace.flush();
      await api.restartApp();
    } else {
      toast(t("update.appliedOnRestart"), "info");
    }
  } catch (e) {
    finish?.();
    await dialog;
    state = { kind: "idle" };
    toast(failureMessage(asFailure(e)), "error", 10000);
    // The update is still available; allow another attempt.
    void checkForUpdates(false);
  }
}

/** Checks on start and then every six hours while the setting is on. */
export function startAutoUpdates(): void {
  const tick = () => {
    if (settings.value.autoUpdate) void checkForUpdates(false);
  };
  window.setTimeout(tick, 4000);
  window.setInterval(tick, SIX_HOURS);
}

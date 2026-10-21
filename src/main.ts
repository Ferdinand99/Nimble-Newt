import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./styles/style.css";
import { accelFor, COMMAND_DEFS, matchesAccel } from "./app/commandDefs";
import { openPalette, runCommand } from "./app/commands";
import { loadFolderState } from "./app/folderState";
import { restoreFolderPanel } from "./app/panels";
import { onUpdateAvailable, showAvailable, startAutoUpdates } from "./app/updater";
import { workspace } from "./app/workspace";
import { api, errorMessage, listEncodings } from "./lib/api";
import { isMac } from "./lib/dom";
import { setLocale, t } from "./lib/i18n";
import { PathInbox } from "./lib/pathInbox";
import { applyTheme, settings } from "./lib/settings";
import { initStatusbar } from "./ui/statusbar";
import { initTabbar } from "./ui/tabbar";
import { openSheet } from "./ui/dialog";
import { h } from "./lib/dom";
import { toast } from "./ui/toast";

function applySettings(): void {
  const s = settings.value;
  applyTheme(s.theme);
  document.documentElement.style.setProperty("--editor-size", `${s.fontSize}px`);
}

function localize(): void {
  const set = (id: string, key: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute("aria-label", t(key));
      el.title = t(key);
    }
  };
  set("open-palette", "cmd.view.palette");
  set("open-settings", "cmd.app.settings");
  const empty = document.getElementById("empty");
  if (empty) empty.replaceChildren(h("strong", {}, "Nimble Newt"), h("span", {}, t("empty.hint")));
}

const stages: Record<string, number> = { scriptStart: Math.round(performance.now()) };
const mark = (name: string) => (stages[name] = Math.round(performance.now()));

async function boot(): Promise<void> {
  // Listen before asking for pending paths: the backend switches from queueing to emitting events
  // the moment we take the queue, and events that arrive while we still start up must not be lost.
  const inbox = new PathInbox();
  await listen<string[]>("open-paths", (e) => inbox.push(e.payload));
  const root = document.documentElement;
  root.classList.add(isMac ? "mac" : "win");

  // Settings, session and files passed on the command line load in parallel.
  const [, session, pending] = await Promise.all([
    settings.load(),
    api.sessionLoad().catch(() => ({ tabs: [], active: null })),
    api.takePendingPaths().catch(() => [] as string[]),
    workspace.loadRecent(),
  ]);
  mark("dataLoaded");
  const locale = setLocale(settings.value.locale);
  applySettings();
  localize();
  void api.setLocale(locale).catch(() => {});

  workspace.mount(document.getElementById("editor")!);
  initTabbar();
  const status = initStatusbar();

  mark("mounted");
  // Show the window as soon as theme and chrome are in place; restoring tabs overlaps with the OS mapping it.
  const shown = getCurrentWindow().show().then(() => mark("shown"));
  if (settings.value.restoreSession && session.tabs.length) await workspace.restore(session.tabs, session.active);
  if (pending.length) await workspace.openPaths(pending);
  if (workspace.docs.length === 0) workspace.newDoc();
  await workspace.activate(workspace.activeId ?? workspace.docs[0].id);

  mark("restored");
  // rAF does not run while the window is hidden, so wait for show() before reporting readiness after the first painted frame.
  await shown;
  workspace.focus();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      mark("painted");
      void api.appReady(stages);
    }),
  );

  settings.onChange((_s, changed) => {
    applySettings();
    if (changed.includes("locale")) {
      void workspace.flush().then(() => location.reload());
    }
    if (changed.includes("restoreSession")) workspace.persist();
  });

  wireShortcuts();
  wireWindow();
  inbox.attach((paths) => void workspace.openPaths(paths));
  document.getElementById("new-tab")!.addEventListener("click", () => {});
  document.getElementById("open-palette")!.addEventListener("click", () => void openPalette());
  document.getElementById("open-settings")!.addEventListener("click", () => runCommand("app.settings"));

  onUpdateAvailable((v) => status.setUpdate(v, () => void showAvailable()));
  startAutoUpdates();
  // Extension manifests are read after the first paint; their scripts only load when a command runs.
  void import("./ext/host").then((m) => m.initExtensions()).catch(() => {});
  if (settings.value.minimap) void workspace.ensureMinimap();
  if (settings.value.wordCompletion) void workspace.ensureCompletion();
  void loadFolderState().then(() => restoreFolderPanel());
  // A hand-edited or outdated default encoding must not break saving later.
  void listEncodings().then((list) => {
    if (!list.some((e) => e.label === settings.value.defaultEncoding)) settings.set({ defaultEncoding: "UTF-8" });
  }).catch(() => {});
  // Custom languages load after the first paint; open tabs pick them up when they are registered.
  void import("./lib/userLanguageStore").then((m) => m.loadUserLanguages())
    .then(() => workspace.redetectLanguages())
    .catch(() => {});
  void workspace.checkExternal();
}

function wireShortcuts(): void {
  const defs = COMMAND_DEFS.filter((c) => !c.editor).flatMap((c) => {
    const a = accelFor(c, isMac);
    return a ? [{ id: c.id, accel: a }] : [];
  });
  // Capture phase so shortcuts also work while an input has focus, except plain text-editing keys.
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    for (const d of defs) {
      if (matchesAccel(e, d.accel, isMac)) {
        e.preventDefault();
        runCommand(d.id);
        return;
      }
    }
  }, true);
  // Ctrl/Cmd + wheel zooms the editor.
  document.getElementById("editor")!.addEventListener("wheel", (e) => {
    if (!(isMac ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    runCommand(e.deltaY < 0 ? "view.zoomIn" : "view.zoomOut");
  }, { passive: false });
}

function wireWindow(): void {
  void listen<string>("menu", (e) => runCommand(e.payload));

  const overlay = document.getElementById("drop-overlay")!;
  overlay.textContent = t("drop.hint");
  void getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") overlay.hidden = false;
    else if (p.type === "drop") {
      overlay.hidden = true;
      void workspace.openPaths(p.paths);
    } else overlay.hidden = true;
  });

  // macOS: the traffic lights hide in full screen, so the tab bar needs no inset there.
  const win = getCurrentWindow();
  const syncFullscreen = () => void win.isFullscreen().then((f) => document.documentElement.classList.toggle("fullscreen", f)).catch(() => {});
  void win.onResized(syncFullscreen);

  window.addEventListener("focus", () => void workspace.checkExternal());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void workspace.flush();
    else void workspace.checkExternal();
  });
  window.addEventListener("blur", () => workspace.persist());

  let closing = false;
  void getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      const dirty = workspace.docs.filter((d) => workspace.isDirty(d));
      if (!settings.value.restoreSession && dirty.length) {
        const choice = await openSheet<"save" | "discard" | "cancel">({
          title: t("quit.title"),
          alert: true,
          body: h("p", {}, t("quit.message", { n: dirty.length })),
          dismissValue: "cancel",
          choices: [
            { value: "discard", label: t("close.discard"), kind: "danger" },
            { value: "cancel", label: t("common.cancel") },
            { value: "save", label: t("quit.saveAll"), kind: "primary" },
          ],
        });
        if (choice === "cancel" || (choice === "save" && !(await workspace.saveAll()))) return;
      }
      await workspace.flush();
      await getCurrentWindow().destroy();
    } finally {
      closing = false;
    }
  });

  window.addEventListener("error", (e) => toast(e.message, "error"));
  window.addEventListener("unhandledrejection", (e) => toast(errorMessage(e.reason), "error"));
}

boot().catch((e) => {
  console.error(e);
  void getCurrentWindow().show();
  document.body.textContent = `Nimble Newt failed to start: ${errorMessage(e)}`;
});

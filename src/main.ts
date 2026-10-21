import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./styles/style.css";
import { accelFor, COMMAND_DEFS, matchesAccel } from "./app/commandDefs";
import { openPalette, runCommand } from "./app/commands";
import { onUpdateAvailable, showAvailable, startAutoUpdates } from "./app/updater";
import { workspace } from "./app/workspace";
import { api, errorMessage } from "./lib/api";
import { isMac } from "./lib/dom";
import { setLocale, t } from "./lib/i18n";
import { applyTheme, settings } from "./lib/settings";
import { openSettings } from "./ui/settings";
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

async function boot(): Promise<void> {
  const root = document.documentElement;
  root.classList.add(isMac ? "mac" : "win");

  // Settings, session and files passed on the command line load in parallel.
  const [, session, pending] = await Promise.all([
    settings.load(),
    api.sessionLoad().catch(() => ({ tabs: [], active: null })),
    api.takePendingPaths().catch(() => [] as string[]),
    workspace.loadRecent(),
  ]);
  const locale = setLocale(settings.value.locale);
  applySettings();
  localize();
  void api.setLocale(locale).catch(() => {});

  workspace.mount(document.getElementById("editor")!);
  initTabbar();
  const status = initStatusbar();

  if (settings.value.restoreSession && session.tabs.length) await workspace.restore(session.tabs, session.active);
  if (pending.length) await workspace.openPaths(pending);
  if (workspace.docs.length === 0) workspace.newDoc();
  await workspace.activate(workspace.activeId ?? workspace.docs[0].id);

  // Show the window now (rAF does not run while it is hidden), then report readiness after the first painted frame.
  await getCurrentWindow().show();
  workspace.focus();
  requestAnimationFrame(() => requestAnimationFrame(() => void api.appReady()));

  settings.onChange((_s, changed) => {
    applySettings();
    if (changed.includes("locale")) {
      void workspace.flush().then(() => location.reload());
    }
    if (changed.includes("restoreSession")) workspace.persist();
  });

  wireShortcuts();
  wireWindow();
  document.getElementById("new-tab")!.addEventListener("click", () => {});
  document.getElementById("open-palette")!.addEventListener("click", () => void openPalette());
  document.getElementById("open-settings")!.addEventListener("click", () => void openSettings());

  onUpdateAvailable((v) => status.setUpdate(v, () => void showAvailable()));
  startAutoUpdates();
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
  void listen<string[]>("open-paths", (e) => void workspace.openPaths(e.payload));

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

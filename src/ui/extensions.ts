import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h } from "../lib/dom";
import { t } from "../lib/i18n";
import { openSheet } from "./dialog";
import { toast } from "./toast";

/** The Extensions sheet: installed and built-in extensions, with enable/disable, remove and install. */
export async function openExtensionsSheet(): Promise<void> {
  const host = await import("../ext/host");
  const list = h("div", {});
  let close: (v: null) => void = () => {};

  const render = () => {
    const rows = host.listExtensions();
    list.replaceChildren(
      ...(rows.length
        ? [
            h("ul", { class: "inset-list" }, ...rows.map((r) => {
              const sw = h("input", { class: "switch-input", type: "checkbox", role: "switch", checked: r.enabled, "aria-label": t("ext.enable", { name: r.name }) });
              sw.addEventListener("change", () => void host.setEnabled(r.id, sw.checked).then(render).catch((e) => toast(String(e), "error")));
              const perms = r.permissions.length ? r.permissions.map(host.permissionText).join(" · ") : t("ext.wantsNothing");
              const actions: Node[] = [h("label", { class: "switch" }, sw, h("span", { class: "switch-ui" }))];
              if (!r.builtin) {
                actions.unshift(h("button", { class: "btn btn-sm btn-danger", type: "button", onclick: () => void host.removeExtension(r.id).then(render).catch((e) => toast(String(e), "error")) }, t("ext.remove")));
              }
              return h("li", { class: "list-row", style: "align-items:flex-start" },
                h("div", { class: "list-row-text" },
                  h("div", { class: "list-row-label" }, r.name, " ", h("span", { class: "muted" }, `${r.version}${r.builtin ? " · " + t("ext.builtin") : ""}`)),
                  h("div", { class: "list-row-hint" }, r.description),
                  h("div", { class: "list-row-hint" }, perms),
                  r.problem ? h("div", { class: "list-row-hint", style: "color:var(--bad-text)" }, t("ext.problem", { reason: r.problem })) : null),
                h("div", { style: "display:flex;gap:8px;align-items:center" }, ...actions));
            })),
          ]
        : [h("p", { class: "muted" }, t("ext.none"))]),
    );
  };
  render();

  const install = async (directory: boolean) => {
    const sel = await openDialog({ multiple: false, directory, title: t(directory ? "ext.pickFolder" : "ext.pickFile"), filters: directory ? undefined : [{ name: "Nimble Newt extension", extensions: ["nnext", "zip"] }] });
    if (typeof sel === "string" && (await host.installFrom(sel))) render();
  };

  const body = [
    h("p", {}, t("ext.intro")),
    h("div", { class: "find-row", style: "margin-bottom:12px" },
      h("button", { class: "btn btn-sm", type: "button", onclick: () => void install(false) }, t("ext.installFile")),
      h("button", { class: "btn btn-sm", type: "button", onclick: () => void install(true) }, t("ext.installFolder"))),
    list,
    h("p", { class: "muted", style: "margin-top:12px;font-size:0.75rem" }, t("ext.sandboxNote")),
  ];
  await openSheet<null>({ title: t("cmd.app.extensions"), body, dismissValue: null, choices: [{ value: null, label: t("common.done"), kind: "primary" }], onOpen: (_d, c) => (close = c) });
  void close;
}

//! Native application menu. Item ids are forwarded to the frontend as `menu` events;
//! the frontend owns what each id does so the menu, the palette and shortcuts stay in sync.

use serde_json::Value;
use std::collections::HashMap;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Wry};

const EN: &str = include_str!("../../src/locales/en.json");
const NB: &str = include_str!("../../src/locales/nb.json");

fn table(locale: &str) -> HashMap<String, String> {
    let parse = |s: &str| -> HashMap<String, String> {
        serde_json::from_str::<HashMap<String, Value>>(s)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned())))
            .collect()
    };
    let mut t = parse(EN);
    if locale.starts_with("nb") || locale.starts_with("no") || locale.starts_with("nn") {
        t.extend(parse(NB));
    }
    t
}

pub fn build(app: &AppHandle, locale: &str) -> tauri::Result<Menu<Wry>> {
    let t = table(locale);
    let l = |key: &str| {
        t.get(&format!("menu.{key}"))
            .cloned()
            .unwrap_or_else(|| key.to_owned())
    };
    let mac = cfg!(target_os = "macos");

    let item = |id: &str, accel: Option<&str>| -> tauri::Result<tauri::menu::MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, l(id));
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let mut file = SubmenuBuilder::new(app, l("file"))
        .item(&item("file.new", Some("CmdOrCtrl+N"))?)
        .item(&item("file.open", Some("CmdOrCtrl+O"))?)
        .item(&item("file.quickOpen", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("file.save", Some("CmdOrCtrl+S"))?)
        .item(&item("file.saveAs", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item(
            "file.saveAll",
            Some(if mac {
                "Alt+CmdOrCtrl+S"
            } else {
                "CmdOrCtrl+Alt+S"
            }),
        )?)
        .separator()
        .item(&item("file.close", Some("CmdOrCtrl+W"))?)
        .item(&item("file.closeOthers", None)?)
        .item(&item("file.reopenClosed", Some("CmdOrCtrl+Shift+T"))?);
    if !mac {
        file = file
            .separator()
            .item(&item("app.settings", Some("CmdOrCtrl+,"))?)
            .separator()
            .item(&item("file.quit", Some("Alt+F4"))?);
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, l("edit"))
        .item(&item("edit.undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(
            "edit.redo",
            Some(if mac {
                "CmdOrCtrl+Shift+Z"
            } else {
                "CmdOrCtrl+Y"
            }),
        )?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(&l("edit.cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(&l("edit.copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(&l("edit.paste")))?)
        .item(&item("edit.selectAll", Some("CmdOrCtrl+A"))?)
        .separator()
        .item(&item("edit.find", Some("CmdOrCtrl+F"))?)
        .item(&item(
            "edit.replace",
            Some(if mac {
                "Alt+CmdOrCtrl+F"
            } else {
                "CmdOrCtrl+H"
            }),
        )?)
        .item(&item("edit.findNext", Some("F3"))?)
        .item(&item("edit.findPrev", Some("Shift+F3"))?)
        .item(&item("edit.findInFiles", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item(
            "edit.gotoLine",
            Some(if mac { "CmdOrCtrl+L" } else { "CmdOrCtrl+G" }),
        )?)
        .build()?;

    let view = SubmenuBuilder::new(app, l("view"))
        .item(&item("view.palette", Some("CmdOrCtrl+Shift+P"))?)
        .separator()
        .item(&item("view.wrap", Some("Alt+Z"))?)
        .item(&item("view.whitespace", None)?)
        .separator()
        .item(&item("view.zoomIn", Some("CmdOrCtrl+="))?)
        .item(&item("view.zoomOut", Some("CmdOrCtrl+-"))?)
        .item(&item("view.zoomReset", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&item("view.nextTab", Some("Ctrl+Tab"))?)
        .item(&item("view.prevTab", Some("Ctrl+Shift+Tab"))?)
        .build()?;

    let mut help = SubmenuBuilder::new(app, l("help"));
    if !mac {
        help = help.item(&item("app.checkUpdates", None)?).separator();
    }
    let help = help.item(&item("app.about", None)?).build()?;

    let mut menu = MenuBuilder::new(app);
    if mac {
        let appm = SubmenuBuilder::new(app, "Nimble Newt")
            .item(&item("app.about", None)?)
            .item(&item("app.checkUpdates", None)?)
            .separator()
            .item(&item("app.settings", Some("Cmd+,"))?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, Some(&l("app.hide")))?)
            .item(&PredefinedMenuItem::hide_others(
                app,
                Some(&l("app.hideOthers")),
            )?)
            .separator()
            .item(&item("file.quit", Some("Cmd+Q"))?)
            .build()?;
        menu = menu.item(&appm);
    }
    menu = menu.item(&file).item(&edit).item(&view);
    if mac {
        let window = SubmenuBuilder::new(app, l("window"))
            .item(&PredefinedMenuItem::minimize(
                app,
                Some(&l("app.minimize")),
            )?)
            .item(&PredefinedMenuItem::maximize(app, Some(&l("app.zoom")))?)
            .build()?;
        menu = menu.item(&window);
    }
    menu.item(&help).build()
}

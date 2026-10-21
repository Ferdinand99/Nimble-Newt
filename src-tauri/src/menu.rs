//! Native application menu, built from `src/app/commands.json` (the same file the frontend reads
//! for command ids and shortcuts). Item ids are forwarded to the frontend as `menu` events; the
//! frontend owns what each id does so the menu, the palette and shortcuts stay in sync.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::menu::{
    Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Wry};

const EN: &str = include_str!("../../src/locales/en.json");
/// Every shipped interface language, compiled in so the native menu can follow the app language.
const LOCALES: &[(&str, &str)] = &[
    ("ar", include_str!("../../src/locales/ar.json")),
    ("cs", include_str!("../../src/locales/cs.json")),
    ("da", include_str!("../../src/locales/da.json")),
    ("de", include_str!("../../src/locales/de.json")),
    ("es", include_str!("../../src/locales/es.json")),
    ("fa", include_str!("../../src/locales/fa.json")),
    ("fi", include_str!("../../src/locales/fi.json")),
    ("fr", include_str!("../../src/locales/fr.json")),
    ("he", include_str!("../../src/locales/he.json")),
    ("hu", include_str!("../../src/locales/hu.json")),
    ("it", include_str!("../../src/locales/it.json")),
    ("ja", include_str!("../../src/locales/ja.json")),
    ("ko", include_str!("../../src/locales/ko.json")),
    ("nb", include_str!("../../src/locales/nb.json")),
    ("nl", include_str!("../../src/locales/nl.json")),
    ("pl", include_str!("../../src/locales/pl.json")),
    ("pt-BR", include_str!("../../src/locales/pt-BR.json")),
    ("pt-PT", include_str!("../../src/locales/pt-PT.json")),
    ("ro", include_str!("../../src/locales/ro.json")),
    ("ru", include_str!("../../src/locales/ru.json")),
    ("sv", include_str!("../../src/locales/sv.json")),
    ("tr", include_str!("../../src/locales/tr.json")),
    ("uk", include_str!("../../src/locales/uk.json")),
    ("zh-CN", include_str!("../../src/locales/zh-CN.json")),
    ("zh-TW", include_str!("../../src/locales/zh-TW.json")),
];
const COMMANDS: &str = include_str!("../../src/app/commands.json");

#[derive(Deserialize)]
struct Spec {
    commands: Vec<Command>,
    menu: Vec<Top>,
}

#[derive(Deserialize)]
struct Command {
    id: String,
    accel: Option<String>,
    #[serde(rename = "accelMac")]
    accel_mac: Option<String>,
    #[serde(default)]
    editor: bool,
}

#[derive(Deserialize)]
struct Top {
    id: String,
    items: Vec<Node>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Node {
    Leaf(String),
    Sub(Top),
}

fn parse(s: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, Value>>(s)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned())))
        .collect()
}

fn raw_locale(locale: &str) -> Option<&'static str> {
    let l = locale.replace('_', "-").to_lowercase();
    let base = l.split('-').next().unwrap_or("");
    let code = LOCALES
        .iter()
        .find(|(c, _)| c.to_lowercase() == l)
        .map(|(c, _)| *c)
        .or(match base {
            "no" | "nn" => Some("nb"),
            "zh" if ["hant", "tw", "hk", "mo"].iter().any(|p| l.contains(p)) => Some("zh-TW"),
            "zh" => Some("zh-CN"),
            "pt" => Some("pt-BR"),
            _ => LOCALES
                .iter()
                .map(|(c, _)| *c)
                .find(|c| c.to_lowercase() == base),
        })?;
    LOCALES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, raw)| *raw)
}

fn table(locale: &str) -> HashMap<String, String> {
    let mut t = parse(EN);
    if let Some(raw) = raw_locale(locale) {
        t.extend(parse(raw));
    }
    t
}

/// `menu.<id>` first (menu-specific wording), then the palette title `cmd.<id>`.
fn label(t: &HashMap<String, String>, id: &str) -> Option<String> {
    t.get(&format!("menu.{id}"))
        .or_else(|| t.get(&format!("cmd.{id}")))
        .cloned()
}

struct Ctx<'a> {
    app: &'a AppHandle,
    t: HashMap<String, String>,
    cmds: HashMap<String, Command>,
    mac: bool,
}

impl Ctx<'_> {
    fn l(&self, id: &str) -> String {
        label(&self.t, id).unwrap_or_else(|| id.to_owned())
    }

    fn accel(&self, id: &str) -> Option<String> {
        let c = self.cmds.get(id)?;
        // Keys the editor handles itself must not also be claimed by the menu.
        if c.editor {
            return None;
        }
        if self.mac {
            c.accel_mac.clone().or_else(|| c.accel.clone())
        } else {
            c.accel.clone()
        }
    }

    fn item(&self, id: &str, accel: Option<&str>) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, self.l(id));
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(self.app)
    }

    fn fill<'m>(
        &self,
        mut sub: SubmenuBuilder<'m, Wry, AppHandle>,
        items: &[Node],
    ) -> tauri::Result<SubmenuBuilder<'m, Wry, AppHandle>> {
        for node in items {
            match node {
                Node::Sub(top) => {
                    let s: Submenu<Wry> = self.submenu(top)?;
                    sub = sub.item(&s);
                }
                Node::Leaf(id) => match id.as_str() {
                    "-" => sub = sub.separator(),
                    "@cut" => {
                        sub = sub.item(&PredefinedMenuItem::cut(
                            self.app,
                            Some(&self.l("edit.cut")),
                        )?)
                    }
                    "@copy" => {
                        sub = sub.item(&PredefinedMenuItem::copy(
                            self.app,
                            Some(&self.l("edit.copy")),
                        )?)
                    }
                    "@paste" => {
                        sub = sub.item(&PredefinedMenuItem::paste(
                            self.app,
                            Some(&self.l("edit.paste")),
                        )?)
                    }
                    // Settings and Quit live in the app menu on macOS.
                    "@settings" if !self.mac => {
                        sub = sub
                            .separator()
                            .item(
                                &self
                                    .item("app.settings", self.accel("app.settings").as_deref())?,
                            )
                            .separator();
                    }
                    "@quit" if !self.mac => {
                        sub = sub.item(&self.item("file.quit", Some("Alt+F4"))?)
                    }
                    "@checkUpdates" if !self.mac => {
                        sub = sub.item(&self.item("app.checkUpdates", None)?).separator();
                    }
                    id if id.starts_with('@') => {}
                    id => sub = sub.item(&self.item(id, self.accel(id).as_deref())?),
                },
            }
        }
        Ok(sub)
    }

    fn submenu(&self, top: &Top) -> tauri::Result<Submenu<Wry>> {
        self.fill(SubmenuBuilder::new(self.app, self.l(&top.id)), &top.items)?
            .build()
    }
}

/// A menu entry contributed by an extension; `id` is forwarded to the frontend like any other.
#[derive(Debug, Clone, Deserialize)]
pub struct Extra {
    pub id: String,
    pub label: String,
}

pub fn build(app: &AppHandle, locale: &str, extras: &[Extra]) -> tauri::Result<Menu<Wry>> {
    let spec: Spec = serde_json::from_str(COMMANDS).expect("commands.json is valid");
    let mac = cfg!(target_os = "macos");
    let ctx = Ctx {
        app,
        t: table(locale),
        cmds: spec
            .commands
            .into_iter()
            .map(|c| (c.id.clone(), c))
            .collect(),
        mac,
    };

    let mut menu = MenuBuilder::new(app);
    if mac {
        let appm = SubmenuBuilder::new(app, "Nimble Newt")
            .item(&ctx.item("app.about", None)?)
            .item(&ctx.item("app.checkUpdates", None)?)
            .separator()
            .item(&ctx.item("app.settings", Some("Cmd+,"))?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, Some(&ctx.l("app.hide")))?)
            .item(&PredefinedMenuItem::hide_others(
                app,
                Some(&ctx.l("app.hideOthers")),
            )?)
            .separator()
            .item(&ctx.item("file.quit", Some("Cmd+Q"))?)
            .build()?;
        menu = menu.item(&appm);
    }
    for top in &spec.menu {
        // The Help menu comes after the macOS Window menu.
        if top.id == "help" && mac {
            let window = SubmenuBuilder::new(app, ctx.l("window"))
                .item(&PredefinedMenuItem::minimize(
                    app,
                    Some(&ctx.l("app.minimize")),
                )?)
                .item(&PredefinedMenuItem::maximize(
                    app,
                    Some(&ctx.l("app.zoom")),
                )?)
                .build()?;
            menu = menu.item(&window);
        }
        let sub = ctx.submenu(top)?;
        if top.id == "tools" && !extras.is_empty() {
            let mut ext = SubmenuBuilder::new(app, ctx.l("tools.extensions"));
            for e in extras {
                ext = ext.item(&MenuItemBuilder::with_id(&e.id, &e.label).build(app)?);
            }
            sub.append(&ext.build()?)?;
        }
        menu = menu.item(&sub);
    }
    menu.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaves<'a>(items: &'a [Node], out: &mut Vec<&'a str>, subs: &mut Vec<&'a str>) {
        for n in items {
            match n {
                Node::Leaf(id) if !id.starts_with('@') && id != "-" => out.push(id),
                Node::Leaf(_) => {}
                Node::Sub(top) => {
                    subs.push(&top.id);
                    leaves(&top.items, out, subs);
                }
            }
        }
    }

    #[test]
    fn every_menu_entry_is_a_known_command_with_a_label_in_both_languages() {
        let spec: Spec = serde_json::from_str(COMMANDS).unwrap();
        let known: Vec<&str> = spec.commands.iter().map(|c| c.id.as_str()).collect();
        let (mut ids, mut subs) = (Vec::new(), Vec::new());
        for top in &spec.menu {
            subs.push(top.id.as_str());
            leaves(&top.items, &mut ids, &mut subs);
        }
        for t in LOCALES.iter().map(|(c, _)| table(c)).chain([table("en")]) {
            for id in &ids {
                assert!(known.contains(id), "menu entry {id} is not in commands");
                assert!(label(&t, id).is_some(), "no label for {id}");
            }
            for id in &subs {
                assert!(
                    t.contains_key(&format!("menu.{id}")),
                    "no title for submenu {id}"
                );
            }
        }
        // Both locale files carry every key (checked on the raw files, not the merged table).
        for (name, raw) in LOCALES
            .iter()
            .map(|(c, r)| (*c, parse(r)))
            .chain([("en", parse(EN))])
        {
            for id in ids.iter().chain(subs.iter()) {
                assert!(
                    raw.contains_key(&format!("menu.{id}"))
                        || raw.contains_key(&format!("cmd.{id}")),
                    "{name} lacks a label for {id}"
                );
            }
        }
    }

    #[test]
    fn accelerators_are_unique_per_platform() {
        let spec: Spec = serde_json::from_str(COMMANDS).unwrap();
        for mac in [false, true] {
            let mut seen: HashMap<String, &str> = HashMap::new();
            for c in &spec.commands {
                let a = if mac {
                    c.accel_mac.as_ref().or(c.accel.as_ref())
                } else {
                    c.accel.as_ref()
                };
                if let Some(a) = a {
                    let key = a.to_lowercase();
                    assert!(
                        seen.insert(key.clone(), &c.id).is_none(),
                        "{} clashes on {key}",
                        c.id
                    );
                }
            }
        }
    }
}

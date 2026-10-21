//! On-disk side of extensions: manifest validation, safe installation from a folder or a `.nnext`
//! zip, enabled state and a tiny per-extension key-value store. Nothing from an extension is ever
//! executed here; see `docs/extensions.md` for the design.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::{fileio, Error, Result};

pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_PACKAGE_ENTRIES: usize = 200;
pub const MAX_COMMANDS: usize = 50;
pub const MAX_STORAGE_KEY: usize = 100;
pub const MAX_STORAGE_VALUE: usize = 64 * 1024;
pub const MAX_STORAGE_TOTAL: u64 = 1024 * 1024;
const MAX_DEPTH: usize = 8;
const MAX_PATH_LEN: usize = 200;
const MANIFEST_FILE: &str = "manifest.json";
const STORAGE_FILE: &str = ".storage.json";
const STATE_FILE: &str = "state.json";

fn bad<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error::Msg(msg.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "editor.read")]
    EditorRead,
    #[serde(rename = "editor.write")]
    EditorWrite,
    #[serde(rename = "ui")]
    Ui,
    #[serde(rename = "clipboard.write")]
    ClipboardWrite,
    #[serde(rename = "storage")]
    Storage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MenuKind {
    Tools,
    Edit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuItem {
    pub command: String,
    pub menu: MenuKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributes {
    #[serde(default)]
    pub commands: Vec<CommandDef>,
    #[serde(default)]
    pub menus: Vec<MenuItem>,
}

fn default_main() -> String {
    "main.js".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default)]
    pub contributes: Contributes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    pub manifest: Manifest,
    pub enabled: bool,
    /// Folder of the extension, for display only.
    pub dir: String,
    pub builtin: bool,
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

fn id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9]+(\.[a-z0-9-]+)+$").expect("static regex"))
}

fn command_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,39}$").expect("static regex"))
}

fn check_id(id: &str) -> Result<()> {
    if id.chars().count() > 64 || !id_re().is_match(id) {
        return bad("id must look like \"com.example.name\" (lowercase letters, digits, dots and dashes, at most 64 characters)");
    }
    // Names that Windows reserves, even with an extension, cannot be folder names.
    let first = id.split('.').next().unwrap_or("");
    let reserved = matches!(first, "con" | "prn" | "aux" | "nul")
        || ((first.starts_with("com") || first.starts_with("lpt"))
            && first.len() == 4
            && first.as_bytes()[3].is_ascii_digit()
            && first.as_bytes()[3] != b'0');
    if reserved {
        return bad(format!(
            "id must not start with the reserved name \"{first}\""
        ));
    }
    Ok(())
}

fn check_text(field: &str, s: &str, min: usize, max: usize, allow_newline: bool) -> Result<()> {
    let n = s.chars().count();
    if n < min || n > max {
        return if min == 0 {
            bad(format!("{field} must be at most {max} characters"))
        } else {
            bad(format!("{field} must be {min}-{max} characters"))
        };
    }
    if s.chars()
        .any(|c| c.is_control() && !(allow_newline && c == '\n'))
    {
        return bad(format!("{field} must not contain control characters"));
    }
    if min > 0 && s.trim().is_empty() {
        return bad(format!("{field} must not be blank"));
    }
    Ok(())
}

fn check_main(main: &str) -> Result<()> {
    if main.is_empty()
        || main.len() > 64
        || main.contains(['/', '\\', ':', '\0'])
        || main == ".."
        || main.contains("..")
    {
        return bad("main must be a plain file name such as \"main.js\" (no folders, no \"..\")");
    }
    if !main.ends_with(".js") || main.len() <= 3 {
        return bad("main must be a JavaScript file name ending in .js");
    }
    Ok(())
}

fn check_shortcut(s: &str) -> Result<()> {
    let err = || {
        bad(format!(
            "shortcut \"{s}\" is not a valid accelerator (examples: CmdOrCtrl+Alt+H, Ctrl+Shift+F7, F7)"
        ))
    };
    if s.len() > 40 {
        return err();
    }
    let parts: Vec<&str> = s.split('+').collect();
    let (key, mods) = match parts.split_last() {
        Some(x) => x,
        None => return err(),
    };
    const MODS: [&str; 11] = [
        "cmdorctrl",
        "commandorcontrol",
        "cmd",
        "command",
        "ctrl",
        "control",
        "alt",
        "option",
        "shift",
        "super",
        "meta",
    ];
    let mut seen = HashSet::new();
    for m in mods {
        let l = m.to_ascii_lowercase();
        if !MODS.contains(&l.as_str()) || !seen.insert(l) {
            return err();
        }
    }
    let kl = key.to_ascii_lowercase();
    let is_f = kl.len() >= 2
        && kl.starts_with('f')
        && kl[1..].chars().all(|c| c.is_ascii_digit())
        && matches!(kl[1..].parse::<u32>(), Ok(1..=24));
    let named = [
        "enter",
        "tab",
        "space",
        "backspace",
        "delete",
        "insert",
        "home",
        "end",
        "pageup",
        "pagedown",
        "up",
        "down",
        "left",
        "right",
        "escape",
        "esc",
    ]
    .contains(&kl.as_str());
    let single = key.chars().count() == 1
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ",./;'[]\\-=`".contains(c));
    if !(is_f || named || single) {
        return err();
    }
    // A bare letter would hijack typing; only function keys may stand alone.
    if mods.is_empty() && !is_f {
        return err();
    }
    Ok(())
}

/// Parses and checks every manifest rule except `minAppVersion`.
fn parse_manifest(json: &str) -> Result<Manifest> {
    if json.len() > MAX_MANIFEST_BYTES {
        return bad("manifest is too large (at most 16 KB)");
    }
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| Error::Msg(format!("manifest is not valid JSON: {e}")))?;
    if let Some(perms) = value.get("permissions").and_then(|p| p.as_array()) {
        for p in perms {
            let known = p.as_str().is_some_and(|s| {
                serde_json::from_value::<Permission>(serde_json::Value::String(s.to_string()))
                    .is_ok()
            });
            if !known {
                return bad(format!(
                    "permissions: unknown permission {p} (known: editor.read, editor.write, ui, clipboard.write, storage)"
                ));
            }
        }
    }
    if let Some(menus) = value
        .get("contributes")
        .and_then(|c| c.get("menus"))
        .and_then(|m| m.as_array())
    {
        for m in menus {
            if let Some(k) = m.get("menu") {
                if !matches!(k.as_str(), Some("tools" | "edit")) {
                    return bad(format!("menus: menu {k} must be \"tools\" or \"edit\""));
                }
            }
        }
    }
    let m: Manifest = serde_json::from_value(value)
        .map_err(|e| Error::Msg(format!("manifest is invalid: {e}")))?;

    check_id(&m.id)?;
    if semver::Version::parse(&m.version).is_err() {
        return bad(format!(
            "version \"{}\" is not a valid semantic version (like 1.2.3)",
            m.version
        ));
    }
    check_text("name", &m.name, 1, 60, false)?;
    check_text("description", &m.description, 0, 280, true)?;
    check_text("author", &m.author, 0, 80, false)?;
    check_main(&m.main)?;
    let mut perms = HashSet::new();
    for p in &m.permissions {
        if !perms.insert(*p) {
            return bad("permissions contains a duplicate entry");
        }
    }
    if m.contributes.commands.len() > MAX_COMMANDS {
        return bad(format!(
            "commands: at most {MAX_COMMANDS} commands are allowed"
        ));
    }
    let mut ids = HashSet::new();
    for c in &m.contributes.commands {
        if !command_re().is_match(&c.id) {
            return bad(format!(
                "command id \"{}\" is invalid (a letter, then letters, digits, _ or -, at most 40 characters)",
                c.id
            ));
        }
        if !ids.insert(c.id.as_str()) {
            return bad(format!("command id \"{}\" is used more than once", c.id));
        }
        check_text(
            &format!("title of command \"{}\"", c.id),
            &c.title,
            1,
            60,
            false,
        )?;
        if let Some(s) = &c.shortcut {
            check_shortcut(s)?;
        }
    }
    for item in &m.contributes.menus {
        if !ids.contains(item.command.as_str()) {
            return bad(format!(
                "menus: command \"{}\" is not defined in commands",
                item.command
            ));
        }
    }
    Ok(m)
}

/// Validates a manifest document against every rule of the design note and against the running
/// app version (`minAppVersion`).
pub fn validate_manifest(json: &str, app_version: &str) -> Result<Manifest> {
    let m = parse_manifest(json)?;
    if let Some(min) = &m.min_app_version {
        let min_v = semver::Version::parse(min).map_err(|_| {
            Error::Msg(format!(
                "minAppVersion \"{min}\" is not a valid semantic version"
            ))
        })?;
        let mut app = semver::Version::parse(app_version).map_err(|_| {
            Error::Msg(format!(
                "app version \"{app_version}\" is not a valid semantic version"
            ))
        })?;
        // Pre-release builds count as their release for compatibility checks.
        app.pre = semver::Prerelease::EMPTY;
        app.build = semver::BuildMetadata::EMPTY;
        if min_v > app {
            return bad(format!(
                "minAppVersion: this extension needs Nimble Newt {min} or newer (you have {app_version})"
            ));
        }
    }
    Ok(m)
}

/// Permissions in `new` that the installed version `old` did not have (all of them when nothing
/// is installed yet).
pub fn needs_consent(old: Option<&Manifest>, new: &Manifest) -> Vec<Permission> {
    let mut out = Vec::new();
    for p in &new.permissions {
        let had = old.is_some_and(|o| o.permissions.contains(p));
        if !had && !out.contains(p) {
            out.push(*p);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------------------------

struct Budget {
    entries: usize,
    total: u64,
}

impl Budget {
    fn new() -> Self {
        Budget {
            entries: 0,
            total: 0,
        }
    }
    fn entry(&mut self) -> Result<()> {
        self.entries += 1;
        if self.entries > MAX_PACKAGE_ENTRIES {
            return bad(format!(
                "package has more than {MAX_PACKAGE_ENTRIES} entries"
            ));
        }
        Ok(())
    }
    /// Copies at most the remaining budget from `r`, counting the bytes actually read.
    fn copy(&mut self, r: &mut dyn Read, w: &mut dyn Write) -> Result<()> {
        let left = MAX_PACKAGE_BYTES - self.total;
        let n = std::io::copy(&mut r.take(left + 1), w)?;
        if n > left {
            return bad("package is larger than 5 MB when unpacked");
        }
        self.total += n;
        Ok(())
    }
}

/// Removes a staging or backup folder when dropped.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unique_name(prefix: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        ".{prefix}-{}-{}-{nanos}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// Checks one path inside a package; returns its components.
fn check_entry_name(name: &str) -> Result<Vec<&str>> {
    let fail = || {
        bad(format!(
            "package contains an unsafe path: \"{}\"",
            name.escape_default()
        ))
    };
    if name.is_empty()
        || name.len() > MAX_PATH_LEN
        || name.starts_with('/')
        || name.contains(['\\', ':', '\0'])
        || name.chars().any(|c| c.is_control())
    {
        return fail();
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() > MAX_DEPTH
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return fail();
    }
    Ok(parts)
}

fn copy_dir(src: &Path, dst: &Path, depth: usize, budget: &mut Budget) -> Result<()> {
    if depth > MAX_DEPTH {
        return bad("package folders are nested too deeply");
    }
    let mut names: Vec<_> = std::fs::read_dir(src)?.collect::<std::io::Result<Vec<_>>>()?;
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return bad("package contains a file name that is not valid text");
        };
        if depth == 0 && name == STORAGE_FILE {
            continue;
        }
        check_entry_name(name)?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path)?;
        let target = dst.join(name);
        if meta.file_type().is_symlink() {
            return bad(format!("package contains a symbolic link: \"{name}\""));
        } else if meta.is_dir() {
            budget.entry()?;
            std::fs::create_dir(&target)?;
            copy_dir(&path, &target, depth + 1, budget)?;
        } else if meta.is_file() {
            budget.entry()?;
            let mut r = std::fs::File::open(&path)?;
            let mut w = std::fs::File::create_new(&target)?;
            budget.copy(&mut r, &mut w)?;
        } else {
            return bad(format!("package contains a special file: \"{name}\""));
        }
    }
    Ok(())
}

fn zip_err(e: zip::result::ZipError) -> Error {
    Error::Msg(format!("not a valid extension package: {e}"))
}

fn is_special_mode(mode: Option<u32>) -> bool {
    matches!(mode.map(|m| m & 0o170000), Some(t) if t != 0 && t != 0o100000 && t != 0o040000)
}

fn extract_zip(zip_path: &Path, dst: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    if file.metadata()?.len() > MAX_PACKAGE_BYTES {
        return bad("package file is larger than 5 MB");
    }
    let mut ar = zip::ZipArchive::new(file).map_err(zip_err)?;
    if ar.len() > MAX_PACKAGE_ENTRIES {
        return bad(format!(
            "package has more than {MAX_PACKAGE_ENTRIES} entries"
        ));
    }
    // Pass 1: names and kinds only, nothing is written.
    let mut items: Vec<(usize, String, bool)> = Vec::new();
    for i in 0..ar.len() {
        let f = ar.by_index_raw(i).map_err(zip_err)?;
        let name = f.name().to_string();
        if name.starts_with("__MACOSX/") {
            continue;
        }
        check_entry_name(&name)?;
        if f.is_symlink() || is_special_mode(f.unix_mode()) {
            return bad(format!(
                "package contains a symbolic link or special file: \"{name}\""
            ));
        }
        if f.size() > MAX_PACKAGE_BYTES {
            return bad("package is larger than 5 MB when unpacked");
        }
        items.push((i, name.clone(), name.ends_with('/')));
    }
    let names: HashSet<&str> = items.iter().map(|(_, n, _)| n.as_str()).collect();
    if names.len() != items.len() {
        return bad("package contains the same path twice");
    }
    let prefix = if names.contains(MANIFEST_FILE) {
        String::new()
    } else {
        let tops: BTreeSet<&str> = items
            .iter()
            .filter_map(|(_, n, _)| n.split('/').next())
            .collect();
        match (tops.len(), tops.iter().next()) {
            (1, Some(top)) if names.contains(format!("{top}/{MANIFEST_FILE}").as_str()) => {
                format!("{top}/")
            }
            _ => return bad("manifest.json not found at the root of the package or in a single top-level folder"),
        }
    };
    // Pass 2: extract, counting the bytes really produced.
    let mut budget = Budget::new();
    for (i, name, is_dir) in &items {
        let rel = &name[prefix.len()..];
        let rel = rel.strip_suffix('/').unwrap_or(rel);
        if rel.is_empty() {
            continue;
        }
        budget.entry()?;
        let target = dst.join(rel);
        if *is_dir {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if rel == STORAGE_FILE {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = ar.by_index(*i).map_err(zip_err)?;
        let mut out = std::fs::File::create_new(&target)?;
        budget.copy(&mut f, &mut out)?;
    }
    Ok(())
}

/// Packs `dir` into a zip at `out`, with the same limits an install enforces.
pub fn pack_zip(dir: &Path, out: &Path) -> Result<()> {
    fn walk(
        dir: &Path,
        rel: &str,
        depth: usize,
        budget: &mut Budget,
        w: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
    ) -> Result<()> {
        if depth > MAX_DEPTH {
            return bad("folders are nested too deeply");
        }
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut entries = std::fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name();
            let Some(name) = name.to_str() else {
                return bad("file name is not valid text");
            };
            if depth == 0 && name == STORAGE_FILE {
                continue;
            }
            check_entry_name(name)?;
            let path = e.path();
            let meta = std::fs::symlink_metadata(&path)?;
            let full = format!("{rel}{name}");
            if meta.file_type().is_symlink() {
                return bad(format!("symbolic links cannot be packed: \"{full}\""));
            } else if meta.is_dir() {
                budget.entry()?;
                w.add_directory(format!("{full}/"), opts).map_err(zip_err)?;
                walk(&path, &format!("{full}/"), depth + 1, budget, w)?;
            } else if meta.is_file() {
                budget.entry()?;
                let mut data = Vec::new();
                budget.copy(&mut std::fs::File::open(&path)?, &mut data)?;
                w.start_file(full, opts).map_err(zip_err)?;
                w.write_all(&data)?;
            } else {
                return bad(format!("special files cannot be packed: \"{full}\""));
            }
        }
        Ok(())
    }
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    walk(dir, "", 0, &mut Budget::new(), &mut w)?;
    let bytes = w.finish().map_err(zip_err)?.into_inner();
    fileio::write_bytes_atomic(out, &bytes)
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

pub struct ExtensionStore {
    root: PathBuf,
}

impl ExtensionStore {
    pub fn new(root: PathBuf) -> Self {
        ExtensionStore { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn ext_dir(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(self.root.join(id))
    }

    fn read_state(&self) -> State {
        std::fs::read(self.root.join(STATE_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_state(&self, st: &State) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        fileio::write_bytes_atomic(&self.root.join(STATE_FILE), &serde_json::to_vec_pretty(st)?)
    }

    fn read_installed_manifest(dir: &Path) -> Result<Manifest> {
        let path = dir.join(MANIFEST_FILE);
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES as u64 {
            return bad("manifest.json is missing, not a regular file or too large");
        }
        let text = String::from_utf8(std::fs::read(&path)?)
            .map_err(|_| Error::Msg("manifest.json is not valid UTF-8".into()))?;
        parse_manifest(&text)
    }

    /// Installed extensions sorted by id, plus a human-readable line for every folder that was
    /// skipped because it is broken.
    pub fn list(&self) -> (Vec<InstalledExtension>, Vec<String>) {
        let mut out = Vec::new();
        let mut problems = Vec::new();
        let rd = match std::fs::read_dir(&self.root) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (out, problems),
            Err(e) => {
                problems.push(format!("cannot read the extensions folder: {e}"));
                return (out, problems);
            }
        };
        let state = self.read_state();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == STATE_FILE {
                continue;
            }
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    problems.push(format!("{name}: not a folder, ignored"));
                    continue;
                }
                Err(e) => {
                    problems.push(format!("{name}: {e}"));
                    continue;
                }
            }
            match Self::read_installed_manifest(&path) {
                Ok(m) if m.id == name => {
                    let enabled = !state.disabled.contains(&m.id);
                    out.push(InstalledExtension {
                        manifest: m,
                        enabled,
                        dir: path.to_string_lossy().into_owned(),
                        builtin: false,
                    });
                }
                Ok(m) => problems.push(format!(
                    "{name}: folder name does not match the manifest id \"{}\"",
                    m.id
                )),
                Err(e) => problems.push(format!("{name}: {e}")),
            }
        }
        out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        problems.sort();
        (out, problems)
    }

    /// The installed extension with this id, if any.
    pub fn get(&self, id: &str) -> Result<Option<InstalledExtension>> {
        let dir = self.ext_dir(id)?;
        if !dir.is_dir() {
            return Ok(None);
        }
        let manifest = Self::read_installed_manifest(&dir)?;
        let enabled = !self.read_state().disabled.contains(id);
        Ok(Some(InstalledExtension {
            manifest,
            enabled,
            dir: dir.to_string_lossy().into_owned(),
            builtin: false,
        }))
    }

    /// The script of an installed extension (at most 1 MB of UTF-8 text).
    pub fn read_main(&self, id: &str) -> Result<String> {
        let dir = self.ext_dir(id)?;
        let manifest = Self::read_installed_manifest(&dir)?;
        let path = dir.join(&manifest.main);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| Error::Msg(format!("script \"{}\" not found", manifest.main)))?;
        if !meta.is_file() {
            return bad("script is not a regular file");
        }
        if meta.len() > MAX_SCRIPT_BYTES {
            return bad("script is larger than 1 MB");
        }
        String::from_utf8(std::fs::read(&path)?)
            .map_err(|_| Error::Msg("script is not valid UTF-8".into()))
    }

    fn stage(&self, src: &Path) -> Result<TempDir> {
        std::fs::create_dir_all(&self.root)?;
        let guard = TempDir(self.root.join(unique_name("tmp")));
        std::fs::create_dir(&guard.0)?;
        let meta = std::fs::symlink_metadata(src)?;
        if meta.file_type().is_symlink() {
            return bad("the package must not be a symbolic link");
        }
        if meta.is_dir() {
            copy_dir(src, &guard.0, 0, &mut Budget::new())?;
        } else {
            extract_zip(src, &guard.0)?;
        }
        Ok(guard)
    }

    fn staged_manifest(staged: &Path, app_version: &str) -> Result<Manifest> {
        let path = staged.join(MANIFEST_FILE);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| Error::Msg("manifest.json not found in the package".into()))?;
        if !meta.is_file() {
            return bad("manifest.json is not a regular file");
        }
        if meta.len() > MAX_MANIFEST_BYTES as u64 {
            return bad("manifest is too large (at most 16 KB)");
        }
        let text = String::from_utf8(std::fs::read(&path)?)
            .map_err(|_| Error::Msg("manifest.json is not valid UTF-8".into()))?;
        let m = validate_manifest(&text, app_version)?;
        let main = staged.join(&m.main);
        match std::fs::symlink_metadata(&main) {
            Ok(mm) if mm.is_file() => {
                if mm.len() > MAX_SCRIPT_BYTES {
                    return bad("main: the script is larger than 1 MB");
                }
            }
            _ => {
                return bad(format!(
                    "main: the script \"{}\" is missing from the package",
                    m.main
                ))
            }
        }
        Ok(m)
    }

    /// Reads and validates a package (a folder, or a `.nnext`/`.zip` file) with the same limits
    /// and rules as an install, but installs nothing and leaves nothing behind. The UI shows the
    /// permissions for consent first; pair with [`needs_consent`] and [`ExtensionStore::get`].
    pub fn inspect(&self, src: &Path, app_version: &str) -> Result<Manifest> {
        let staged = self.stage(src)?;
        Self::staged_manifest(&staged.0, app_version)
    }

    fn install(&self, src: &Path, app_version: &str, allow_same: bool) -> Result<Manifest> {
        let staged = self.stage(src)?;
        let manifest = Self::staged_manifest(&staged.0, app_version)?;
        let target = self.ext_dir(&manifest.id)?;
        let mut backup = None;
        if target.exists() {
            if let Ok(old) = Self::read_installed_manifest(&target) {
                if let (Ok(ov), Ok(nv)) = (
                    semver::Version::parse(&old.version),
                    semver::Version::parse(&manifest.version),
                ) {
                    if nv < ov {
                        return bad(format!(
                            "version {nv} is older than the installed version {ov}; downgrades are not allowed"
                        ));
                    }
                    if nv == ov && !allow_same {
                        return bad(format!("version {nv} is already installed"));
                    }
                }
            }
            // Keep the extension's stored data across updates.
            let old_storage = target.join(STORAGE_FILE);
            if old_storage.is_file() {
                let _ = std::fs::copy(&old_storage, staged.0.join(STORAGE_FILE));
            }
            let b = TempDir(self.root.join(unique_name("old")));
            std::fs::rename(&target, &b.0)?;
            backup = Some(b);
        }
        if let Err(e) = std::fs::rename(&staged.0, &target) {
            if let Some(b) = &backup {
                let _ = std::fs::rename(&b.0, &target);
            }
            return Err(e.into());
        }
        // `staged` now points at a moved folder; dropping it is a no-op. The backup is deleted
        // when `backup` drops.
        drop(backup);
        Ok(manifest)
    }

    /// Installs (or updates) an extension from a folder. A same-version reinstall needs
    /// `allow_same`; downgrades are always refused. The enabled state is kept.
    pub fn install_from_dir(
        &self,
        src: &Path,
        app_version: &str,
        allow_same: bool,
    ) -> Result<Manifest> {
        if !std::fs::symlink_metadata(src)?.is_dir() {
            return bad("the source is not a folder");
        }
        self.install(src, app_version, allow_same)
    }

    /// Installs (or updates) an extension from a `.nnext` zip; see [`install_from_dir`](Self::install_from_dir).
    pub fn install_from_zip(
        &self,
        zip_path: &Path,
        app_version: &str,
        allow_same: bool,
    ) -> Result<Manifest> {
        if !std::fs::symlink_metadata(zip_path)?.is_file() {
            return bad("the package is not a file");
        }
        self.install(zip_path, app_version, allow_same)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let dir = self.ext_dir(id)?;
        if !dir.is_dir() {
            return bad(format!("extension \"{id}\" is not installed"));
        }
        std::fs::remove_dir_all(&dir)?;
        let mut st = self.read_state();
        if st.disabled.remove(id) {
            self.write_state(&st)?;
        }
        Ok(())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        let dir = self.ext_dir(id)?;
        if !dir.is_dir() {
            return bad(format!("extension \"{id}\" is not installed"));
        }
        let mut st = self.read_state();
        let changed = if enabled {
            st.disabled.remove(id)
        } else {
            st.disabled.insert(id.to_string())
        };
        if changed {
            self.write_state(&st)?;
        }
        Ok(())
    }

    // -- storage ------------------------------------------------------------------------------

    fn storage_path(&self, id: &str) -> Result<PathBuf> {
        let dir = self.ext_dir(id)?;
        if !dir.is_dir() {
            return bad(format!("extension \"{id}\" is not installed"));
        }
        Ok(dir.join(STORAGE_FILE))
    }

    fn load_storage(path: &Path) -> BTreeMap<String, serde_json::Value> {
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() && m.len() <= MAX_STORAGE_TOTAL => std::fs::read(path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default(),
            _ => BTreeMap::new(),
        }
    }

    fn check_key(key: &str) -> Result<()> {
        let n = key.chars().count();
        if n == 0 || n > MAX_STORAGE_KEY {
            return bad(format!(
                "storage key must be 1-{MAX_STORAGE_KEY} characters"
            ));
        }
        Ok(())
    }

    pub fn storage_get(&self, id: &str, key: &str) -> Result<Option<serde_json::Value>> {
        Self::check_key(key)?;
        let path = self.storage_path(id)?;
        Ok(Self::load_storage(&path).get(key).cloned())
    }

    pub fn storage_set(&self, id: &str, key: &str, value: &serde_json::Value) -> Result<()> {
        Self::check_key(key)?;
        let path = self.storage_path(id)?;
        if serde_json::to_vec(value)?.len() > MAX_STORAGE_VALUE {
            return bad("storage value is larger than 64 KB");
        }
        let mut map = Self::load_storage(&path);
        map.insert(key.to_string(), value.clone());
        let bytes = serde_json::to_vec(&map)?;
        if bytes.len() as u64 > MAX_STORAGE_TOTAL {
            return bad("storage would exceed 1 MB in total");
        }
        fileio::write_bytes_atomic(&path, &bytes)
    }

    pub fn storage_remove(&self, id: &str, key: &str) -> Result<()> {
        Self::check_key(key)?;
        let path = self.storage_path(id)?;
        let mut map = Self::load_storage(&path);
        if map.remove(key).is_some() {
            fileio::write_bytes_atomic(&path, &serde_json::to_vec(&map)?)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir as TD;

    const APP: &str = "0.2.0";

    fn manifest_json() -> serde_json::Value {
        json!({
            "id": "com.example.hello", "name": "Hello", "version": "1.0.0",
            "description": "Says hello.", "author": "Ada", "minAppVersion": "0.2.0",
            "main": "main.js", "permissions": ["editor.read", "ui"],
            "contributes": {
                "commands": [{ "id": "sayHi", "title": "Say hi", "shortcut": "CmdOrCtrl+Alt+H" }],
                "menus": [{ "command": "sayHi", "menu": "tools" }]
            }
        })
    }

    fn with(f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v = manifest_json();
        f(&mut v);
        v.to_string()
    }

    fn err_of(json: &str) -> String {
        validate_manifest(json, APP).unwrap_err().to_string()
    }

    fn rejects(f: impl FnOnce(&mut serde_json::Value), needle: &str) {
        let e = err_of(&with(f));
        assert!(e.contains(needle), "error {e:?} should mention {needle:?}");
    }

    fn make_dir(parent: &Path, id: &str, version: &str) -> PathBuf {
        let d = parent.join(format!("src-{id}-{version}"));
        fs::create_dir_all(&d).unwrap();
        let mut m = manifest_json();
        m["id"] = json!(id);
        m["version"] = json!(version);
        fs::write(d.join("manifest.json"), m.to_string()).unwrap();
        fs::write(
            d.join("main.js"),
            "nimble.commands.register('sayHi', () => {});",
        )
        .unwrap();
        d
    }

    fn opts() -> zip::write::SimpleFileOptions {
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
    }

    fn build_zip(path: &Path, files: &[(&str, Vec<u8>)]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (n, data) in files {
            w.start_file(*n, opts()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    fn std_files(prefix: &str) -> Vec<(String, Vec<u8>)> {
        vec![
            (
                format!("{prefix}manifest.json"),
                manifest_json().to_string().into_bytes(),
            ),
            (format!("{prefix}main.js"), b"// js".to_vec()),
        ]
    }

    fn zip_std(path: &Path, prefix: &str) {
        let f = std_files(prefix);
        let refs: Vec<(&str, Vec<u8>)> = f.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
        build_zip(path, &refs);
    }

    fn store() -> (TD, ExtensionStore) {
        let t = TD::new().unwrap();
        let s = ExtensionStore::new(t.path().join("extensions"));
        (t, s)
    }

    fn store_is_empty(s: &ExtensionStore) -> bool {
        match fs::read_dir(s.root()) {
            Ok(rd) => rd.count() == 0,
            Err(_) => true,
        }
    }

    fn install_default(s: &ExtensionStore, t: &TD) -> Manifest {
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        s.install_from_dir(&d, APP, false).unwrap()
    }

    // -- manifest -----------------------------------------------------------------------------

    #[test]
    fn valid_manifest() {
        let m = validate_manifest(&manifest_json().to_string(), APP).unwrap();
        assert_eq!(m.id, "com.example.hello");
        assert_eq!(m.permissions, vec![Permission::EditorRead, Permission::Ui]);
        assert_eq!(
            m.contributes.commands[0].shortcut.as_deref(),
            Some("CmdOrCtrl+Alt+H")
        );
        assert_eq!(m.contributes.menus[0].menu, MenuKind::Tools);
    }

    #[test]
    fn minimal_manifest_gets_defaults() {
        let m = validate_manifest(r#"{"id":"a.b","name":"X","version":"0.0.1"}"#, APP).unwrap();
        assert_eq!(m.main, "main.js");
        assert!(m.description.is_empty() && m.author.is_empty());
        assert!(m.permissions.is_empty() && m.contributes.commands.is_empty());
    }

    #[test]
    fn serializes_camel_case() {
        let m = validate_manifest(&manifest_json().to_string(), APP).unwrap();
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["minAppVersion"], "0.2.0");
        assert_eq!(v["permissions"][0], "editor.read");
        let ie = InstalledExtension {
            manifest: m,
            enabled: true,
            dir: "x".into(),
            builtin: false,
        };
        let v = serde_json::to_value(&ie).unwrap();
        assert_eq!(v["builtin"], false);
        assert_eq!(v["manifest"]["contributes"]["menus"][0]["menu"], "tools");
    }

    #[test]
    fn not_json() {
        assert!(err_of("{nope").contains("JSON"));
    }

    #[test]
    fn unknown_field_rejected() {
        rejects(|v| v["evil"] = json!(1), "evil");
        rejects(|v| v["contributes"]["commands"][0]["x"] = json!(1), "x");
    }

    #[test]
    fn huge_manifest_rejected() {
        let e = err_of(&with(|v| v["description"] = json!("a".repeat(20_000))));
        assert!(e.contains("too large"), "{e}");
    }

    #[test]
    fn bad_ids() {
        for id in [
            "Hello", "nodots", "a..b", ".a.b", "a.b.", "a.B", "a. b", "a/b.c", "../a.b", "con.x",
            "com1.x",
        ] {
            let e = err_of(&with(|v| v["id"] = json!(id)));
            assert!(e.contains("id"), "{id}: {e}");
        }
        let long = format!("a.{}", "b".repeat(63));
        rejects(|v| v["id"] = json!(long), "id");
        for id in ["a.b", "com.example.my-ext", "x1.y2.z3", "com0.x"] {
            validate_manifest(&with(|v| v["id"] = json!(id)), APP).unwrap();
        }
    }

    #[test]
    fn bad_version() {
        rejects(|v| v["version"] = json!("1.0"), "version");
        rejects(|v| v["version"] = json!("latest"), "version");
    }

    #[test]
    fn bad_name() {
        rejects(|v| v["name"] = json!(""), "name");
        rejects(|v| v["name"] = json!("   "), "name");
        rejects(|v| v["name"] = json!("n".repeat(61)), "name");
        rejects(|v| v["name"] = json!("a\nb"), "name");
    }

    #[test]
    fn bad_description_and_author() {
        rejects(|v| v["description"] = json!("d".repeat(281)), "description");
        rejects(|v| v["author"] = json!("a".repeat(81)), "author");
        validate_manifest(&with(|v| v["description"] = json!("d".repeat(280))), APP).unwrap();
    }

    #[test]
    fn bad_main() {
        for main in [
            "../x.js",
            "sub/main.js",
            "sub\\main.js",
            "main.txt",
            "..",
            "",
            ".js",
            "C:main.js",
            "a..js",
            "/etc/x.js",
        ] {
            let e = err_of(&with(|v| v["main"] = json!(main)));
            assert!(e.contains("main"), "{main:?}: {e}");
        }
        validate_manifest(&with(|v| v["main"] = json!("my.script.js")), APP).unwrap();
    }

    #[test]
    fn bad_permissions() {
        rejects(|v| v["permissions"] = json!(["files.read"]), "permissions");
        rejects(|v| v["permissions"] = json!([5]), "permissions");
        rejects(|v| v["permissions"] = json!(["ui", "ui"]), "permissions");
        validate_manifest(
            &with(|v| {
                v["permissions"] = json!([
                    "editor.read",
                    "editor.write",
                    "ui",
                    "clipboard.write",
                    "storage"
                ])
            }),
            APP,
        )
        .unwrap();
    }

    #[test]
    fn bad_command_ids() {
        for id in ["1abc", "a b", "", "a.b", &"a".repeat(41)] {
            let e = err_of(&with(|v| {
                v["contributes"]["commands"][0]["id"] = json!(id);
                v["contributes"]["menus"] = json!([]);
            }));
            assert!(e.contains("command id"), "{id}: {e}");
        }
    }

    #[test]
    fn duplicate_command_ids() {
        rejects(
            |v| {
                v["contributes"]["commands"] =
                    json!([{"id":"a","title":"A"},{"id":"a","title":"B"}]);
                v["contributes"]["menus"] = json!([]);
            },
            "more than once",
        );
    }

    #[test]
    fn too_many_commands() {
        let cmds: Vec<_> = (0..51)
            .map(|i| json!({"id": format!("c{i}"), "title": "T"}))
            .collect();
        rejects(
            |v| {
                v["contributes"]["commands"] = json!(cmds);
                v["contributes"]["menus"] = json!([]);
            },
            "commands",
        );
        let ok: Vec<_> = (0..50)
            .map(|i| json!({"id": format!("c{i}"), "title": "T"}))
            .collect();
        validate_manifest(
            &with(|v| {
                v["contributes"]["commands"] = json!(ok);
                v["contributes"]["menus"] = json!([]);
            }),
            APP,
        )
        .unwrap();
    }

    #[test]
    fn bad_titles() {
        rejects(
            |v| v["contributes"]["commands"][0]["title"] = json!(""),
            "title",
        );
        rejects(
            |v| v["contributes"]["commands"][0]["title"] = json!("t".repeat(61)),
            "title",
        );
    }

    #[test]
    fn shortcuts() {
        for ok in [
            "CmdOrCtrl+Alt+H",
            "F7",
            "Ctrl+Shift+F12",
            "Alt+1",
            "ctrl+,",
            "Ctrl+PageUp",
        ] {
            validate_manifest(
                &with(|v| v["contributes"]["commands"][0]["shortcut"] = json!(ok)),
                APP,
            )
            .unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        for bad in [
            "",
            "H",
            "Ctrl+",
            "Ctrl+Ctrl+H",
            "Hyper+H",
            "Ctrl+Nope",
            "Ctrl+F99",
            "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s",
        ] {
            let e = err_of(&with(|v| {
                v["contributes"]["commands"][0]["shortcut"] = json!(bad)
            }));
            assert!(e.contains("shortcut"), "{bad}: {e}");
        }
    }

    #[test]
    fn menu_must_reference_command() {
        rejects(
            |v| v["contributes"]["menus"][0]["command"] = json!("ghost"),
            "menus",
        );
        rejects(
            |v| v["contributes"]["menus"][0]["menu"] = json!("file"),
            "menu",
        );
    }

    #[test]
    fn min_app_version() {
        let e = validate_manifest(&with(|v| v["minAppVersion"] = json!("0.3.0")), APP)
            .unwrap_err()
            .to_string();
        assert!(e.contains("minAppVersion") && e.contains("0.3.0"), "{e}");
        rejects(|v| v["minAppVersion"] = json!("x"), "minAppVersion");
        // Pre-release app builds count as their release.
        validate_manifest(
            &with(|v| v["minAppVersion"] = json!("0.2.0")),
            "0.2.0-beta.1",
        )
        .unwrap();
        validate_manifest(&with(|v| v["minAppVersion"] = json!("0.1.0")), "1.0.0").unwrap();
        assert!(validate_manifest(&manifest_json().to_string(), "nope").is_err());
    }

    // -- consent ------------------------------------------------------------------------------

    #[test]
    fn consent() {
        let new = validate_manifest(&manifest_json().to_string(), APP).unwrap();
        assert_eq!(
            needs_consent(None, &new),
            vec![Permission::EditorRead, Permission::Ui]
        );
        assert!(needs_consent(Some(&new), &new).is_empty());
        let mut old = new.clone();
        old.permissions = vec![Permission::Ui];
        assert_eq!(
            needs_consent(Some(&old), &new),
            vec![Permission::EditorRead]
        );
        let mut fewer = new.clone();
        fewer.permissions = vec![Permission::Ui];
        assert!(needs_consent(Some(&new), &fewer).is_empty());
    }

    // -- install from dir ---------------------------------------------------------------------

    #[test]
    fn install_dir_and_read() {
        let (t, s) = store();
        let m = install_default(&s, &t);
        assert_eq!(m.id, "com.example.hello");
        let (list, problems) = s.list();
        assert!(problems.is_empty());
        assert_eq!(list.len(), 1);
        assert!(list[0].enabled && !list[0].builtin);
        assert!(s
            .read_main("com.example.hello")
            .unwrap()
            .contains("register"));
        assert!(s.get("com.example.hello").unwrap().is_some());
        assert!(s.get("com.example.none").unwrap().is_none());
        // No staging leftovers.
        let names: Vec<_> = fs::read_dir(s.root())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn install_dir_missing_main() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        fs::remove_file(d.join("main.js")).unwrap();
        let e = s.install_from_dir(&d, APP, false).unwrap_err().to_string();
        assert!(e.contains("main"), "{e}");
        assert!(store_is_empty(&s));
    }

    #[test]
    fn install_dir_missing_or_bad_manifest() {
        let (t, s) = store();
        let d = t.path().join("empty");
        fs::create_dir_all(&d).unwrap();
        assert!(s.install_from_dir(&d, APP, false).is_err());
        fs::write(d.join("manifest.json"), "{}").unwrap();
        assert!(s.install_from_dir(&d, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[test]
    fn install_dir_requires_new_enough_app() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        assert!(s.install_from_dir(&d, "0.1.0", false).is_err());
        assert!(store_is_empty(&s));
    }

    #[cfg(unix)]
    #[test]
    fn install_dir_rejects_symlink() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        std::os::unix::fs::symlink("/etc/passwd", d.join("link.txt")).unwrap();
        let e = s.install_from_dir(&d, APP, false).unwrap_err().to_string();
        assert!(e.contains("symbolic"), "{e}");
        assert!(store_is_empty(&s));
    }

    #[test]
    fn install_dir_too_many_entries() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        for i in 0..200 {
            fs::write(d.join(format!("f{i}.txt")), "x").unwrap();
        }
        assert!(s.install_from_dir(&d, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[test]
    fn install_dir_too_big() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        fs::write(d.join("big.bin"), vec![1u8; 5 * 1024 * 1024 + 10]).unwrap();
        assert!(s.install_from_dir(&d, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[test]
    fn install_dir_ignores_preseeded_storage() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        fs::write(d.join(".storage.json"), r#"{"k":"planted"}"#).unwrap();
        s.install_from_dir(&d, APP, false).unwrap();
        assert_eq!(s.storage_get("com.example.hello", "k").unwrap(), None);
    }

    // -- install from zip ---------------------------------------------------------------------

    #[test]
    fn zip_at_root() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        zip_std(&z, "");
        s.install_from_zip(&z, APP, false).unwrap();
        assert!(s.read_main("com.example.hello").unwrap().contains("js"));
    }

    #[test]
    fn zip_in_top_level_folder() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        zip_std(&z, "hello/");
        s.install_from_zip(&z, APP, false).unwrap();
        assert!(s.read_main("com.example.hello").is_ok());
        assert!(!s.root().join("com.example.hello").join("hello").exists());
    }

    #[test]
    fn zip_with_macosx_junk_and_dirs() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        let mut w = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        w.add_directory("hello/", opts()).unwrap();
        w.start_file("hello/manifest.json", opts()).unwrap();
        w.write_all(manifest_json().to_string().as_bytes()).unwrap();
        w.start_file("hello/main.js", opts()).unwrap();
        w.write_all(b"1").unwrap();
        w.start_file("__MACOSX/hello/._main.js", opts()).unwrap();
        w.write_all(b"junk").unwrap();
        w.finish().unwrap();
        s.install_from_zip(&z, APP, false).unwrap();
    }

    #[test]
    fn zip_without_manifest_or_two_top_folders() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        build_zip(&z, &[("main.js", b"x".to_vec())]);
        assert!(s.install_from_zip(&z, APP, false).is_err());
        build_zip(
            &z,
            &[
                ("a/manifest.json", manifest_json().to_string().into_bytes()),
                ("a/main.js", b"x".to_vec()),
                ("b/other.txt", b"x".to_vec()),
            ],
        );
        assert!(s.install_from_zip(&z, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[test]
    fn zip_not_a_zip() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        fs::write(&z, b"this is not a zip").unwrap();
        assert!(s.install_from_zip(&z, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    fn assert_rejected_zip(files: &[(&str, Vec<u8>)], needle: &str) {
        let (t, s) = store();
        let z = t.path().join("bad.nnext");
        build_zip(&z, files);
        let e = s.install_from_zip(&z, APP, false).unwrap_err().to_string();
        assert!(e.contains(needle), "{e}");
        assert!(store_is_empty(&s), "store must stay empty");
        assert!(!t.path().join("evil").exists());
    }

    fn m() -> Vec<u8> {
        manifest_json().to_string().into_bytes()
    }

    #[test]
    fn zip_path_traversal_rejected() {
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("../evil", b"x".to_vec()),
            ],
            "unsafe",
        );
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("a/../../evil", b"x".to_vec()),
            ],
            "unsafe",
        );
    }

    #[test]
    fn zip_absolute_and_drive_and_backslash_rejected() {
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("/tmp/evil", b"x".to_vec()),
            ],
            "unsafe",
        );
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("C:/evil", b"x".to_vec()),
            ],
            "unsafe",
        );
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("..\\evil", b"x".to_vec()),
            ],
            "unsafe",
        );
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("a\\b", b"x".to_vec()),
            ],
            "unsafe",
        );
    }

    #[test]
    fn zip_symlink_rejected() {
        let (t, s) = store();
        let z = t.path().join("bad.nnext");
        let mut w = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        w.start_file("manifest.json", opts()).unwrap();
        w.write_all(&m()).unwrap();
        w.start_file("main.js", opts()).unwrap();
        w.write_all(b"x").unwrap();
        w.add_symlink("link", "/etc/passwd", opts()).unwrap();
        w.finish().unwrap();
        let e = s.install_from_zip(&z, APP, false).unwrap_err().to_string();
        assert!(e.contains("symbolic"), "{e}");
        assert!(store_is_empty(&s));
    }

    #[test]
    fn zip_201_entries_rejected() {
        let mut files: Vec<(String, Vec<u8>)> = (0..201)
            .map(|i| (format!("f{i}.txt"), vec![b'x']))
            .collect();
        files[0] = ("manifest.json".into(), m());
        files[1] = ("main.js".into(), b"x".to_vec());
        let refs: Vec<(&str, Vec<u8>)> =
            files.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
        assert_rejected_zip(&refs, "entries");
    }

    #[test]
    fn zip_200_entries_accepted() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        let mut files: Vec<(String, Vec<u8>)> = (0..200)
            .map(|i| (format!("f{i}.txt"), vec![b'x']))
            .collect();
        files[0] = ("manifest.json".into(), m());
        files[1] = ("main.js".into(), b"x".to_vec());
        let refs: Vec<(&str, Vec<u8>)> =
            files.iter().map(|(n, d)| (n.as_str(), d.clone())).collect();
        build_zip(&z, &refs);
        s.install_from_zip(&z, APP, false).unwrap();
    }

    #[test]
    fn zip_bomb_single_entry_rejected() {
        let bomb = vec![0u8; 8 * 1024 * 1024];
        let (t, _) = store();
        let z = t.path().join("bomb.nnext");
        build_zip(
            &z,
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("bomb.bin", bomb.clone()),
            ],
        );
        assert!(
            fs::metadata(&z).unwrap().len() < 100 * 1024,
            "the zip itself must be small"
        );
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("bomb.bin", bomb),
            ],
            "5 MB",
        );
    }

    #[test]
    fn zip_bomb_total_rejected() {
        let chunk = vec![0u8; 2 * 1024 * 1024];
        assert_rejected_zip(
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("a.bin", chunk.clone()),
                ("b.bin", chunk.clone()),
                ("c.bin", chunk),
            ],
            "5 MB",
        );
    }

    #[test]
    fn zip_with_lying_header_is_still_bounded() {
        // Header sizes are not trusted: even when the declared size is small, the bytes actually
        // read are counted. Here we rely on the real data being larger than the budget.
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        build_zip(
            &z,
            &[
                ("manifest.json", m()),
                ("main.js", vec![b'a'; 6 * 1024 * 1024]),
            ],
        );
        assert!(s.install_from_zip(&z, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[test]
    fn zip_duplicate_entries_rejected() {
        let (t, s) = store();
        let z = t.path().join("a.nnext");
        build_zip(&z, &[("manifest.json", m()), ("main.js", b"1".to_vec())]);
        // Same path twice is refused by the writer; emulate with directory + file of same name.
        let mut w = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        w.start_file("manifest.json", opts()).unwrap();
        w.write_all(&m()).unwrap();
        w.start_file("main.js", opts()).unwrap();
        w.write_all(b"1").unwrap();
        w.finish().unwrap();
        s.install_from_zip(&z, APP, false).unwrap();
    }

    // -- updates ------------------------------------------------------------------------------

    #[test]
    fn same_version_and_downgrade_refused() {
        let (t, s) = store();
        install_default(&s, &t);
        let same = make_dir(t.path(), "com.example.hello", "1.0.0");
        let e = s
            .install_from_dir(&same, APP, false)
            .unwrap_err()
            .to_string();
        assert!(e.contains("already installed"), "{e}");
        s.install_from_dir(&same, APP, true).unwrap();

        let up = make_dir(t.path(), "com.example.hello", "1.2.0");
        s.install_from_dir(&up, APP, false).unwrap();
        let down = make_dir(t.path(), "com.example.hello", "1.1.0");
        let e = s
            .install_from_dir(&down, APP, true)
            .unwrap_err()
            .to_string();
        assert!(e.contains("downgrade"), "{e}");
        assert_eq!(
            s.get("com.example.hello")
                .unwrap()
                .unwrap()
                .manifest
                .version,
            "1.2.0"
        );
        let names = fs::read_dir(s.root()).unwrap().count();
        assert_eq!(names, 1, "no staging or backup folders left");
    }

    #[test]
    fn upgrade_keeps_enabled_state_and_storage() {
        let (t, s) = store();
        install_default(&s, &t);
        s.set_enabled("com.example.hello", false).unwrap();
        s.storage_set("com.example.hello", "k", &json!({"a": 1}))
            .unwrap();
        let up = make_dir(t.path(), "com.example.hello", "2.0.0");
        fs::write(up.join("main.js"), "// v2").unwrap();
        s.install_from_dir(&up, APP, false).unwrap();
        let e = s.get("com.example.hello").unwrap().unwrap();
        assert_eq!(e.manifest.version, "2.0.0");
        assert!(!e.enabled);
        assert_eq!(s.read_main("com.example.hello").unwrap(), "// v2");
        assert_eq!(
            s.storage_get("com.example.hello", "k").unwrap(),
            Some(json!({"a": 1}))
        );
    }

    #[test]
    fn failed_update_keeps_old_version() {
        let (t, s) = store();
        install_default(&s, &t);
        let up = make_dir(t.path(), "com.example.hello", "2.0.0");
        fs::remove_file(up.join("main.js")).unwrap();
        assert!(s.install_from_dir(&up, APP, false).is_err());
        assert_eq!(
            s.get("com.example.hello")
                .unwrap()
                .unwrap()
                .manifest
                .version,
            "1.0.0"
        );
        assert!(s.read_main("com.example.hello").is_ok());
    }

    // -- inspect ------------------------------------------------------------------------------

    #[test]
    fn inspect_dir_and_zip_leave_nothing() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        assert_eq!(s.inspect(&d, APP).unwrap().id, "com.example.hello");
        assert!(store_is_empty(&s));
        let z = t.path().join("a.nnext");
        zip_std(&z, "hello/");
        assert_eq!(s.inspect(&z, APP).unwrap().version, "1.0.0");
        assert!(store_is_empty(&s));
    }

    #[test]
    fn inspect_applies_same_rules() {
        let (t, s) = store();
        let z = t.path().join("bad.nnext");
        build_zip(
            &z,
            &[
                ("manifest.json", m()),
                ("main.js", b"x".to_vec()),
                ("../evil", b"x".to_vec()),
            ],
        );
        assert!(s.inspect(&z, APP).is_err());
        assert!(s.inspect(&z, "0.1.0").is_err());
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        assert!(s.inspect(&d, "0.1.0").is_err());
        assert!(store_is_empty(&s));
    }

    // -- remove / enabled / list --------------------------------------------------------------

    #[test]
    fn remove_extension() {
        let (t, s) = store();
        install_default(&s, &t);
        s.set_enabled("com.example.hello", false).unwrap();
        s.remove("com.example.hello").unwrap();
        assert!(s.list().0.is_empty());
        assert!(s.remove("com.example.hello").is_err());
        // Reinstalling starts enabled again.
        install_default(&s, &t);
        assert!(s.get("com.example.hello").unwrap().unwrap().enabled);
    }

    #[test]
    fn enable_disable_roundtrip() {
        let (t, s) = store();
        install_default(&s, &t);
        s.set_enabled("com.example.hello", false).unwrap();
        assert!(!s.list().0[0].enabled);
        // A fresh store object sees the persisted state.
        let s2 = ExtensionStore::new(s.root().to_path_buf());
        assert!(!s2.list().0[0].enabled);
        s2.set_enabled("com.example.hello", true).unwrap();
        assert!(s.list().0[0].enabled);
        assert!(s.set_enabled("com.example.nothere", false).is_err());
    }

    #[test]
    fn list_empty_and_missing_root() {
        let (_t, s) = store();
        let (l, p) = s.list();
        assert!(l.is_empty() && p.is_empty());
    }

    #[test]
    fn list_skips_broken_folders() {
        let (t, s) = store();
        install_default(&s, &t);
        let root = s.root();
        fs::create_dir_all(root.join("junk.one")).unwrap();
        fs::create_dir_all(root.join("junk.two")).unwrap();
        fs::write(root.join("junk.two").join("manifest.json"), "{ nope").unwrap();
        fs::create_dir_all(root.join("junk.three")).unwrap();
        fs::write(
            root.join("junk.three").join("manifest.json"),
            manifest_json().to_string(),
        )
        .unwrap();
        fs::write(root.join("loose.txt"), "x").unwrap();
        fs::write(root.join("state.json"), "garbage").unwrap();
        fs::create_dir_all(root.join(".tmp-old")).unwrap();
        let (list, problems) = s.list();
        assert_eq!(list.len(), 1);
        assert_eq!(problems.len(), 4, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("does not match")));
    }

    // -- read_main ----------------------------------------------------------------------------

    #[test]
    fn read_main_limits() {
        let (t, s) = store();
        install_default(&s, &t);
        let main = s.root().join("com.example.hello").join("main.js");
        fs::write(&main, vec![b'a'; 1024 * 1024]).unwrap();
        assert_eq!(s.read_main("com.example.hello").unwrap().len(), 1024 * 1024);
        fs::write(&main, vec![b'a'; 1024 * 1024 + 1]).unwrap();
        assert!(s
            .read_main("com.example.hello")
            .unwrap_err()
            .to_string()
            .contains("1 MB"));
        fs::write(&main, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(s
            .read_main("com.example.hello")
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
        fs::remove_file(&main).unwrap();
        assert!(s.read_main("com.example.hello").is_err());
    }

    #[test]
    fn main_traversal_in_installed_manifest_is_not_followed() {
        let (t, s) = store();
        install_default(&s, &t);
        fs::write(t.path().join("secret.js"), "secret").unwrap();
        let mp = s.root().join("com.example.hello").join("manifest.json");
        let mut v = manifest_json();
        v["main"] = json!("../../secret.js");
        fs::write(&mp, v.to_string()).unwrap();
        assert!(s.read_main("com.example.hello").is_err());
    }

    #[test]
    fn main_traversal_rejected_at_install() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        let mut v = manifest_json();
        v["main"] = json!("../main.js");
        fs::write(d.join("manifest.json"), v.to_string()).unwrap();
        fs::write(t.path().join("main.js"), "x").unwrap();
        assert!(s.install_from_dir(&d, APP, false).is_err());
        assert!(store_is_empty(&s));
    }

    #[cfg(unix)]
    #[test]
    fn read_main_refuses_symlinked_script() {
        let (t, s) = store();
        install_default(&s, &t);
        let main = s.root().join("com.example.hello").join("main.js");
        fs::remove_file(&main).unwrap();
        fs::write(t.path().join("outside.js"), "x").unwrap();
        std::os::unix::fs::symlink(t.path().join("outside.js"), &main).unwrap();
        assert!(s.read_main("com.example.hello").is_err());
    }

    // -- ids as folder names ------------------------------------------------------------------

    #[test]
    fn ids_cannot_escape_the_root() {
        let (t, s) = store();
        install_default(&s, &t);
        fs::write(t.path().join("victim"), "x").unwrap();
        for id in [
            "..",
            "../victim",
            "a/../..",
            "/etc",
            "..\\x",
            "",
            "a.b/../../c.d",
            "C:\\x.y",
        ] {
            assert!(s.read_main(id).is_err(), "{id}");
            assert!(s.remove(id).is_err(), "{id}");
            assert!(s.set_enabled(id, false).is_err(), "{id}");
            assert!(s.storage_get(id, "k").is_err(), "{id}");
            assert!(s.storage_set(id, "k", &json!(1)).is_err(), "{id}");
            assert!(s.storage_remove(id, "k").is_err(), "{id}");
            assert!(s.get(id).is_err(), "{id}");
        }
        assert!(t.path().join("victim").exists());
    }

    // -- storage ------------------------------------------------------------------------------

    #[test]
    fn storage_basic() {
        let (t, s) = store();
        install_default(&s, &t);
        let id = "com.example.hello";
        assert_eq!(s.storage_get(id, "a").unwrap(), None);
        s.storage_set(id, "a", &json!("hello")).unwrap();
        s.storage_set(id, "n", &json!(42)).unwrap();
        assert_eq!(s.storage_get(id, "a").unwrap(), Some(json!("hello")));
        s.storage_set(id, "a", &json!("again")).unwrap();
        assert_eq!(s.storage_get(id, "a").unwrap(), Some(json!("again")));
        s.storage_remove(id, "a").unwrap();
        assert_eq!(s.storage_get(id, "a").unwrap(), None);
        assert_eq!(s.storage_get(id, "n").unwrap(), Some(json!(42)));
        s.storage_remove(id, "never-set").unwrap();
    }

    #[test]
    fn storage_key_and_value_limits() {
        let (t, s) = store();
        install_default(&s, &t);
        let id = "com.example.hello";
        assert!(s.storage_set(id, "", &json!(1)).is_err());
        assert!(s.storage_set(id, &"k".repeat(101), &json!(1)).is_err());
        s.storage_set(id, &"k".repeat(100), &json!(1)).unwrap();
        let big = json!("v".repeat(MAX_STORAGE_VALUE));
        let e = s.storage_set(id, "big", &big).unwrap_err().to_string();
        assert!(e.contains("64 KB"), "{e}");
        s.storage_set(id, "ok", &json!("v".repeat(MAX_STORAGE_VALUE - 2)))
            .unwrap();
    }

    #[test]
    fn storage_total_limit() {
        let (t, s) = store();
        install_default(&s, &t);
        let id = "com.example.hello";
        let v = json!("v".repeat(60 * 1024));
        let mut stored = 0;
        let mut err = None;
        for i in 0..30 {
            match s.storage_set(id, &format!("key{i}"), &v) {
                Ok(()) => stored += 1,
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        assert!(err.expect("limit must trigger").contains("1 MB"));
        assert!((15..=17).contains(&stored), "{stored}");
        let size = fs::metadata(s.root().join(id).join(".storage.json"))
            .unwrap()
            .len();
        assert!(size <= MAX_STORAGE_TOTAL);
        // Removing makes room again.
        s.storage_remove(id, "key0").unwrap();
        s.storage_set(id, "again", &v).unwrap();
    }

    #[test]
    fn storage_is_isolated_between_extensions() {
        let (t, s) = store();
        let a = make_dir(t.path(), "com.example.aaa", "1.0.0");
        let b = make_dir(t.path(), "com.example.bbb", "1.0.0");
        s.install_from_dir(&a, APP, false).unwrap();
        s.install_from_dir(&b, APP, false).unwrap();
        s.storage_set("com.example.aaa", "k", &json!("A")).unwrap();
        s.storage_set("com.example.bbb", "k", &json!("B")).unwrap();
        assert_eq!(
            s.storage_get("com.example.aaa", "k").unwrap(),
            Some(json!("A"))
        );
        assert_eq!(
            s.storage_get("com.example.bbb", "k").unwrap(),
            Some(json!("B"))
        );
        s.remove("com.example.aaa").unwrap();
        assert_eq!(
            s.storage_get("com.example.bbb", "k").unwrap(),
            Some(json!("B"))
        );
    }

    #[test]
    fn storage_requires_installed_extension() {
        let (_t, s) = store();
        assert!(s.storage_set("com.example.ghost", "k", &json!(1)).is_err());
        assert!(!s.root().join("com.example.ghost").exists());
    }

    #[test]
    fn storage_corrupt_file_is_treated_as_empty() {
        let (t, s) = store();
        install_default(&s, &t);
        let id = "com.example.hello";
        fs::write(s.root().join(id).join(".storage.json"), "garbage").unwrap();
        assert_eq!(s.storage_get(id, "k").unwrap(), None);
        s.storage_set(id, "k", &json!(true)).unwrap();
        assert_eq!(s.storage_get(id, "k").unwrap(), Some(json!(true)));
    }

    // -- pack_zip -----------------------------------------------------------------------------

    #[test]
    fn pack_and_install_roundtrip() {
        let (t, s) = store();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        fs::create_dir_all(d.join("lib")).unwrap();
        fs::write(d.join("lib").join("util.js"), "1").unwrap();
        fs::write(d.join(".storage.json"), "{}").unwrap();
        let z = t.path().join("out.nnext");
        pack_zip(&d, &z).unwrap();
        s.install_from_zip(&z, APP, false).unwrap();
        assert!(s.root().join("com.example.hello/lib/util.js").is_file());
        assert!(!s.root().join("com.example.hello/.storage.json").exists());
    }

    #[test]
    fn pack_enforces_limits() {
        let t = TD::new().unwrap();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        fs::write(d.join("big.bin"), vec![1u8; 5 * 1024 * 1024 + 1]).unwrap();
        assert!(pack_zip(&d, &t.path().join("o.nnext")).is_err());
        let d2 = make_dir(t.path(), "com.example.other", "1.0.0");
        for i in 0..200 {
            fs::write(d2.join(format!("f{i}")), "x").unwrap();
        }
        assert!(pack_zip(&d2, &t.path().join("o2.nnext")).is_err());
        assert!(!t.path().join("o.nnext").exists());
    }

    #[cfg(unix)]
    #[test]
    fn pack_refuses_symlinks() {
        let t = TD::new().unwrap();
        let d = make_dir(t.path(), "com.example.hello", "1.0.0");
        std::os::unix::fs::symlink("/etc/passwd", d.join("l")).unwrap();
        assert!(pack_zip(&d, &t.path().join("o.nnext")).is_err());
    }
}

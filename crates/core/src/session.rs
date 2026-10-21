//! Session storage: open tabs and their unsaved content live in the app data directory,
//! never next to the user's files.

use crate::encoding::TextEncoding;
use crate::eol::Eol;
use crate::fileio::write_bytes_atomic;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMeta {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub encoding: Option<TextEncoding>,
    pub eol: Option<Eol>,
    pub language: Option<String>,
    pub dirty: bool,
    pub selection_anchor: usize,
    pub selection_head: usize,
    pub scroll_top: f64,
    pub scroll_left: f64,
    pub saved_mtime_ms: Option<i64>,
    /// 1-based numbers of bookmarked lines. Added after the first release: older sessions lack it.
    #[serde(default)]
    pub bookmarks: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub tabs: Vec<TabMeta>,
    pub active: Option<String>,
}

/// A restored tab: metadata plus the unsaved text when the tab was dirty or untitled.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RestoredTab {
    #[serde(flatten)]
    pub meta: TabMeta,
    /// `Some` for tabs whose content only exists in the session store.
    pub buffer: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RestoredSession {
    pub tabs: Vec<RestoredTab>,
    pub active: Option<String>,
}

pub struct SessionStore {
    dir: PathBuf,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_doc(name: &str) -> bool {
    valid_id(name)
}

impl SessionStore {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(dir.join("buffers"))?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn buffer_path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(Error::Msg(format!("invalid buffer id: {id}")));
        }
        Ok(self.dir.join("buffers").join(format!("{id}.txt")))
    }

    /// Stores the content of one unsaved tab.
    pub fn write_buffer(&self, id: &str, text: &str) -> Result<()> {
        write_bytes_atomic(&self.buffer_path(id)?, text.as_bytes())
    }

    pub fn read_buffer(&self, id: &str) -> Result<Option<String>> {
        match std::fs::read(self.buffer_path(id)?) {
            Ok(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn delete_buffer(&self, id: &str) -> Result<()> {
        match std::fs::remove_file(self.buffer_path(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes tab metadata and removes buffers that no tab refers to any more.
    pub fn write_meta(&self, meta: &SessionMeta) -> Result<()> {
        let json = serde_json::to_vec_pretty(meta)?;
        write_bytes_atomic(&self.dir.join("session.json"), &json)?;
        let keep: std::collections::HashSet<&str> =
            meta.tabs.iter().map(|t| t.id.as_str()).collect();
        for entry in std::fs::read_dir(self.dir.join("buffers"))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".txt") {
                if !keep.contains(id) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    /// Loads the session. A corrupt or missing file yields an empty session, never an error:
    /// the editor must always start.
    pub fn load(&self) -> RestoredSession {
        let meta: SessionMeta = std::fs::read(self.dir.join("session.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut tabs = Vec::new();
        for t in meta.tabs {
            if !valid_id(&t.id) {
                continue;
            }
            let buffer = self.read_buffer(&t.id).ok().flatten();
            // An untitled tab whose buffer is gone has nothing left to restore.
            if t.path.is_none() && buffer.is_none() {
                continue;
            }
            tabs.push(RestoredTab { meta: t, buffer });
        }
        let active = meta.active.filter(|a| tabs.iter().any(|t| &t.meta.id == a));
        RestoredSession { tabs, active }
    }

    /// Small JSON documents owned by the frontend (settings, recent files).
    pub fn read_doc(&self, name: &str) -> Result<Option<String>> {
        if !valid_doc(name) {
            return Err(Error::Msg(format!("invalid document name: {name}")));
        }
        match std::fs::read_to_string(self.dir.join(format!("{name}.json"))) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_doc(&self, name: &str, json: &str) -> Result<()> {
        if !valid_doc(name) {
            return Err(Error::Msg(format!("invalid document name: {name}")));
        }
        serde_json::from_str::<serde_json::Value>(json)?;
        write_bytes_atomic(&self.dir.join(format!("{name}.json")), json.as_bytes())
    }
}

/// Convenience for loading a buffer map in tests and tools.
pub fn buffers_of(s: &RestoredSession) -> HashMap<&str, &str> {
    s.tabs
        .iter()
        .filter_map(|t| t.buffer.as_deref().map(|b| (t.meta.id.as_str(), b)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, path: Option<&str>, dirty: bool) -> TabMeta {
        TabMeta {
            id: id.into(),
            path: path.map(Into::into),
            title: id.into(),
            dirty,
            ..Default::default()
        }
    }

    #[test]
    fn untitled_and_dirty_content_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let s = SessionStore::new(dir.path()).unwrap();
            s.write_buffer("t1", "Untitled draft\nline 2").unwrap();
            s.write_buffer("t2", "edited but unsaved").unwrap();
            s.write_meta(&SessionMeta {
                tabs: vec![
                    tab("t1", None, true),
                    tab("t2", Some("/tmp/x.txt"), true),
                    tab("t3", Some("/tmp/y.txt"), false),
                ],
                active: Some("t2".into()),
            })
            .unwrap();
        }
        let s = SessionStore::new(dir.path()).unwrap();
        let r = s.load();
        assert_eq!(r.tabs.len(), 3);
        assert_eq!(r.active.as_deref(), Some("t2"));
        let b = buffers_of(&r);
        assert_eq!(b["t1"], "Untitled draft\nline 2");
        assert_eq!(b["t2"], "edited but unsaved");
        assert!(!b.contains_key("t3"));
    }

    #[test]
    fn unreferenced_buffers_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        s.write_buffer("gone", "x").unwrap();
        s.write_buffer("kept", "y").unwrap();
        s.write_meta(&SessionMeta {
            tabs: vec![tab("kept", None, true)],
            active: None,
        })
        .unwrap();
        assert_eq!(s.read_buffer("gone").unwrap(), None);
        assert_eq!(s.read_buffer("kept").unwrap().as_deref(), Some("y"));
    }

    #[test]
    fn corrupt_session_file_gives_empty_session() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        std::fs::write(dir.path().join("session.json"), "{ not json").unwrap();
        assert!(s.load().tabs.is_empty());
    }

    #[test]
    fn untitled_tab_without_buffer_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        s.write_meta(&SessionMeta {
            tabs: vec![tab("a", None, true)],
            active: Some("a".into()),
        })
        .unwrap();
        let r = s.load();
        assert!(r.tabs.is_empty());
        assert_eq!(r.active, None);
    }

    #[test]
    fn path_traversal_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        assert!(s.write_buffer("../evil", "x").is_err());
        assert!(s.read_doc("../settings").is_err());
    }

    #[test]
    fn docs_round_trip_and_validate_json() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        assert_eq!(s.read_doc("settings").unwrap(), None);
        s.write_doc("settings", "{\"fontSize\":14}").unwrap();
        assert_eq!(
            s.read_doc("settings").unwrap().as_deref(),
            Some("{\"fontSize\":14}")
        );
        assert!(s.write_doc("settings", "nope").is_err());
    }

    #[test]
    fn sessions_from_the_first_release_still_load() {
        // Exactly what version 0.1.0 wrote: no `bookmarks` field.
        let old = r#"{"tabs":[{"id":"a","path":"/p","title":"p","encoding":"UTF-8","eol":"LF","language":null,"dirty":false,
            "selectionAnchor":3,"selectionHead":4,"scrollTop":1.5,"scrollLeft":0.0,"savedMtimeMs":99}],"active":"a"}"#;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("session.json"), old).unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        let r = s.load();
        assert_eq!(r.tabs.len(), 1);
        assert_eq!(r.tabs[0].meta.selection_head, 4);
        assert!(r.tabs[0].meta.bookmarks.is_empty());
    }

    #[test]
    fn bookmarks_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        let mut t = tab("a", Some("/p"), false);
        t.bookmarks = vec![2, 40];
        s.write_meta(&SessionMeta {
            tabs: vec![t],
            active: Some("a".into()),
        })
        .unwrap();
        assert_eq!(s.load().tabs[0].meta.bookmarks, vec![2, 40]);
    }

    #[test]
    fn cursor_and_scroll_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionStore::new(dir.path()).unwrap();
        let mut t = tab("a", Some("/p"), false);
        t.selection_anchor = 5;
        t.selection_head = 9;
        t.scroll_top = 120.5;
        s.write_meta(&SessionMeta {
            tabs: vec![t.clone()],
            active: Some("a".into()),
        })
        .unwrap();
        assert_eq!(s.load().tabs[0].meta, t);
    }
}

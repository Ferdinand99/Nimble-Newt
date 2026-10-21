//! Folder browsing for the "folder as workspace" panel.

use crate::{Error, Result};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ListOptions {
    pub show_hidden: bool,
    pub respect_gitignore: bool,
}

fn walker(root: &Path, o: ListOptions) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(!o.show_hidden)
        .git_ignore(o.respect_gitignore)
        .git_global(o.respect_gitignore)
        .git_exclude(o.respect_gitignore)
        .ignore(o.respect_gitignore)
        .require_git(false)
        .follow_links(false)
        .sort_by_file_name(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    b
}

/// The direct children of `dir`: folders first, then files, each sorted by name (case-insensitive).
pub fn list_dir(dir: &Path, o: ListOptions) -> Result<Vec<Entry>> {
    if !dir.is_dir() {
        return Err(Error::Msg(format!("{} is not a folder", dir.display())));
    }
    let mut out = Vec::new();
    for item in walker(dir, o).max_depth(Some(1)).build().flatten() {
        if item.depth() == 0 {
            continue;
        }
        let meta = item.metadata().ok();
        out.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: item.file_type().is_some_and(|t| t.is_dir()),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Files below `root` whose relative path contains every word of `query` (case-insensitive),
/// best matches first (file name hits, then shorter paths). Stops scanning after `scan_limit` files.
pub fn find_files(
    root: &Path,
    query: &str,
    limit: usize,
    scan_limit: usize,
    o: ListOptions,
) -> Result<Vec<String>> {
    if !root.is_dir() {
        return Err(Error::Msg(format!("{} is not a folder", root.display())));
    }
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits: Vec<(u8, usize, String)> = Vec::new();
    let mut scanned = 0usize;
    for item in walker(root, o).build().flatten() {
        if !item.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        scanned += 1;
        if scanned > scan_limit {
            break;
        }
        let rel = item
            .path()
            .strip_prefix(root)
            .unwrap_or(item.path())
            .to_string_lossy()
            .replace('\\', "/");
        let lower = rel.to_lowercase();
        if !words.iter().all(|w| lower.contains(w)) {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_lowercase();
        let in_name = words.iter().all(|w| name.contains(w));
        hits.push((
            u8::from(!in_name),
            rel.len(),
            item.path().to_string_lossy().into_owned(),
        ));
    }
    hits.sort();
    Ok(hits.into_iter().take(limit).map(|h| h.2).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const OPTS: ListOptions = ListOptions {
        show_hidden: false,
        respect_gitignore: true,
    };

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("src/inner")).unwrap();
        fs::create_dir_all(r.join("Docs")).unwrap();
        fs::create_dir_all(r.join("target")).unwrap();
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::write(r.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(r.join(".hidden"), "x").unwrap();
        fs::write(r.join("zeta.txt"), "z").unwrap();
        fs::write(r.join("Alpha.md"), "a").unwrap();
        fs::write(r.join("debug.log"), "l").unwrap();
        fs::write(r.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(r.join("src/inner/lib.rs"), "").unwrap();
        fs::write(r.join("target/out.bin"), "").unwrap();
        d
    }

    fn names(v: &[Entry]) -> Vec<&str> {
        v.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_then_files_case_insensitively() {
        let d = tree();
        let l = list_dir(d.path(), OPTS).unwrap();
        assert_eq!(names(&l), ["Docs", "src", "Alpha.md", "zeta.txt"]);
        assert!(l[0].is_dir && !l[2].is_dir);
        assert_eq!(l[3].size, 1);
    }

    #[test]
    fn hidden_and_ignored_entries_can_be_shown() {
        let d = tree();
        let l = list_dir(
            d.path(),
            ListOptions {
                show_hidden: true,
                respect_gitignore: false,
            },
        )
        .unwrap();
        let n = names(&l);
        assert!(
            n.contains(&".hidden")
                && n.contains(&"target")
                && n.contains(&"debug.log")
                && n.contains(&".gitignore")
        );
        let l = list_dir(
            d.path(),
            ListOptions {
                show_hidden: false,
                respect_gitignore: false,
            },
        )
        .unwrap();
        assert!(names(&l).contains(&"target"));
        assert!(!names(&l).contains(&".hidden"));
    }

    #[test]
    fn lists_only_direct_children() {
        let d = tree();
        let l = list_dir(&d.path().join("src"), OPTS).unwrap();
        assert_eq!(names(&l), ["inner", "main.rs"]);
    }

    #[test]
    fn missing_or_file_paths_are_errors() {
        let d = tree();
        assert!(list_dir(&d.path().join("nope"), OPTS).is_err());
        assert!(list_dir(&d.path().join("zeta.txt"), OPTS).is_err());
        assert!(find_files(&d.path().join("zeta.txt"), "a", 10, 100, OPTS).is_err());
    }

    #[test]
    fn finds_files_by_words_in_the_path() {
        let d = tree();
        let hits = find_files(d.path(), "rs", 10, 1000, OPTS).unwrap();
        let rel: Vec<String> = hits
            .iter()
            .map(|h| {
                Path::new(h)
                    .strip_prefix(d.path())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(rel, ["src/main.rs", "src/inner/lib.rs"]);
        let hits = find_files(d.path(), "SRC lib", 10, 1000, OPTS).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(find_files(d.path(), "   ", 10, 1000, OPTS)
            .unwrap()
            .is_empty());
        assert!(
            find_files(d.path(), "out.bin", 10, 1000, OPTS)
                .unwrap()
                .is_empty(),
            "ignored files stay hidden"
        );
    }

    #[test]
    fn file_name_matches_rank_before_directory_matches() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("config")).unwrap();
        fs::write(d.path().join("config/a.txt"), "").unwrap();
        fs::write(d.path().join("config.toml"), "").unwrap();
        let hits = find_files(d.path(), "config", 10, 100, OPTS).unwrap();
        assert!(hits[0].ends_with("config.toml"));
    }

    #[test]
    fn limit_and_scan_limit_apply() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..20 {
            fs::write(d.path().join(format!("f{i}.txt")), "").unwrap();
        }
        assert_eq!(find_files(d.path(), "f", 5, 1000, OPTS).unwrap().len(), 5);
        assert!(find_files(d.path(), "f", 100, 3, OPTS).unwrap().len() <= 3);
    }
}

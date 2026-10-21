//! Search and replace across files and folders.

use crate::encoding;
use crate::eol::Eol;
use crate::fileio::{self, looks_binary};
use crate::{Error, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    pub root: String,
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Comma- or semicolon-separated globs, e.g. `*.rs, src/**/*.ts`. Empty means everything.
    pub include: String,
    /// Same syntax; matching files and folders are skipped.
    pub exclude: String,
    pub respect_gitignore: bool,
    pub include_hidden: bool,
    pub max_results: usize,
    pub max_file_bytes: u64,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            root: String::new(),
            query: String::new(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
            respect_gitignore: true,
            include_hidden: false,
            max_results: 5000,
            max_file_bytes: 20 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// 1-based line number.
    pub line: usize,
    /// 0-based column in UTF-16 units (matches CodeMirror offsets).
    pub column: usize,
    /// Length of the match in UTF-16 units.
    pub length: usize,
    /// The matching line, trimmed to a readable window.
    pub preview: String,
    /// Offset of the match inside `preview` (UTF-16 units).
    pub preview_offset: usize,
    /// The line as it would read after replacement, when a replacement was requested.
    pub replaced: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport {
    pub files: Vec<FileMatches>,
    pub total_matches: usize,
    pub files_scanned: usize,
    pub files_skipped_binary: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub files_changed: usize,
    pub replacements: usize,
    pub errors: Vec<String>,
}

pub fn build_regex(
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Regex> {
    if query.is_empty() {
        return Err(Error::Pattern("empty search".into()));
    }
    let mut pat = if is_regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    if whole_word {
        pat = format!(r"\b(?:{pat})\b");
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .crlf(true)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| Error::Pattern(e.to_string()))
}

fn glob_set(spec: &str) -> Result<Option<GlobSet>> {
    let mut b = GlobSetBuilder::new();
    let mut any = false;
    for raw in spec.split([',', ';']) {
        let g = raw.trim();
        if g.is_empty() {
            continue;
        }
        any = true;
        // A bare name like `*.rs` should match at any depth, like in .gitignore.
        let pat = if g.contains('/') {
            g.to_owned()
        } else {
            format!("**/{g}")
        };
        b.add(Glob::new(&pat).map_err(|e| Error::Pattern(e.to_string()))?);
        if !g.contains('*') && !g.contains('?') && !g.contains('[') {
            // `node_modules` also excludes everything below it.
            b.add(Glob::new(&format!("{pat}/**")).map_err(|e| Error::Pattern(e.to_string()))?);
        }
    }
    if !any {
        return Ok(None);
    }
    Ok(Some(b.build().map_err(|e| Error::Pattern(e.to_string()))?))
}

fn collect_files(o: &SearchOptions) -> Result<Vec<PathBuf>> {
    let root = Path::new(&o.root);
    if !root.is_dir() {
        return Err(Error::Msg(format!("{} is not a folder", o.root)));
    }
    let include = glob_set(&o.include)?;
    let exclude = glob_set(&o.exclude)?;
    let mut wb = ignore::WalkBuilder::new(root);
    wb.hidden(!o.include_hidden)
        .git_ignore(o.respect_gitignore)
        .git_global(o.respect_gitignore)
        .git_exclude(o.respect_gitignore)
        .ignore(o.respect_gitignore)
        .require_git(false)
        .follow_links(false);
    let mut files = Vec::new();
    for entry in wb.build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(path);
        if exclude.as_ref().is_some_and(|g| g.is_match(rel)) {
            continue;
        }
        if include.as_ref().is_some_and(|g| !g.is_match(rel)) {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > o.max_file_bytes)
            .unwrap_or(false)
        {
            continue;
        }
        files.push(path.to_path_buf());
    }
    files.sort();
    Ok(files)
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Matches of `re` in `text` with line/column info. `replacement` fills `Match::replaced`.
pub fn find_in_text(
    re: &Regex,
    text: &str,
    replacement: Option<(&str, bool)>,
    limit: usize,
) -> Vec<Match> {
    let mut out = Vec::new();
    // Byte offset of the start of each line, built lazily as we advance.
    let mut line_no = 1usize;
    let mut line_start = 0usize;
    let mut cursor = 0usize;
    for m in re.find_iter(text) {
        if out.len() >= limit {
            break;
        }
        if m.is_empty() {
            continue;
        }
        // Advance the line counter up to the match start.
        for (i, b) in text.as_bytes()[cursor..m.start()].iter().enumerate() {
            if *b == b'\n' {
                line_no += 1;
                line_start = cursor + i + 1;
            }
        }
        cursor = m.start();
        let line_end = text[m.start()..]
            .find('\n')
            .map(|i| m.start() + i)
            .unwrap_or(text.len());
        let line = text[line_start..line_end].trim_end_matches('\r');
        let col_bytes = m.start() - line_start;
        let match_end_in_line = (m.end() - line_start).min(line.len());
        let column = utf16_len(&line[..col_bytes.min(line.len())]);
        let length = utf16_len(&line[col_bytes.min(line.len())..match_end_in_line]).max(1);
        let (preview, preview_offset) = window(line, column);
        let replaced = replacement.map(|(rep, is_regex)| {
            let new_line = if is_regex {
                re.replace_all(line, rep).into_owned()
            } else {
                re.replace_all(line, NoExpand(rep)).into_owned()
            };
            window(&new_line, column).0
        });
        out.push(Match {
            line: line_no,
            column,
            length,
            preview,
            preview_offset,
            replaced,
        });
    }
    out
}

/// Trims a long line to ~160 chars around the match so huge minified files stay readable.
fn window(line: &str, column_utf16: usize) -> (String, usize) {
    const BEFORE: usize = 40;
    const TOTAL: usize = 160;
    let chars: Vec<char> = line.chars().collect();
    // Convert the UTF-16 column to a char index.
    let mut units = 0;
    let mut col = chars.len();
    for (i, c) in chars.iter().enumerate() {
        if units >= column_utf16 {
            col = i;
            break;
        }
        units += c.len_utf16();
    }
    let start = col.saturating_sub(BEFORE);
    let end = (start + TOTAL).min(chars.len());
    let s: String = chars[start..end].iter().collect();
    let offset: usize = chars[start..col.min(end)]
        .iter()
        .map(|c| c.len_utf16())
        .sum();
    (s, offset)
}

fn read_text(path: &Path) -> Option<(encoding::Decoded, bool)> {
    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return Some((encoding::decode(b""), true));
    }
    Some((encoding::decode(&bytes), false))
}

/// Searches a folder. `replacement` is only used to build previews.
pub fn search(o: &SearchOptions, replacement: Option<&str>) -> Result<SearchReport> {
    let re = build_regex(&o.query, o.regex, o.case_sensitive, o.whole_word)?;
    let files = collect_files(o)?;
    let mut report = SearchReport::default();
    for path in files {
        if report.total_matches >= o.max_results {
            report.truncated = true;
            break;
        }
        let Some((decoded, binary)) = read_text(&path) else {
            continue;
        };
        report.files_scanned += 1;
        if binary {
            report.files_skipped_binary += 1;
            continue;
        }
        let room = o.max_results - report.total_matches;
        let matches = find_in_text(&re, &decoded.text, replacement.map(|r| (r, o.regex)), room);
        if matches.is_empty() {
            continue;
        }
        report.total_matches += matches.len();
        report.files.push(FileMatches {
            path: path.to_string_lossy().into_owned(),
            matches,
        });
    }
    Ok(report)
}

/// Replaces in the given files only (the user's confirmed selection from the preview),
/// preserving each file's encoding and line endings.
pub fn replace_in_files(
    o: &SearchOptions,
    replacement: &str,
    paths: &[String],
) -> Result<ReplaceReport> {
    let re = build_regex(&o.query, o.regex, o.case_sensitive, o.whole_word)?;
    let allowed: std::collections::HashSet<PathBuf> = collect_files(o)?.into_iter().collect();
    let mut report = ReplaceReport::default();
    for p in paths {
        let path = PathBuf::from(p);
        if !allowed.contains(&path) {
            report.errors.push(format!("{p}: not part of the search"));
            continue;
        }
        let Some((decoded, binary)) = read_text(&path) else {
            report.errors.push(format!("{p}: could not be read"));
            continue;
        };
        if binary {
            continue;
        }
        let count = re
            .find_iter(&decoded.text)
            .filter(|m| !m.is_empty())
            .count();
        if count == 0 {
            continue;
        }
        let new_text = if o.regex {
            re.replace_all(&decoded.text, replacement).into_owned()
        } else {
            re.replace_all(&decoded.text, NoExpand(replacement))
                .into_owned()
        };
        let eol = decoded.eol.unwrap_or(Eol::Lf);
        match fileio::write(&path, &new_text, decoded.encoding, eol) {
            Ok(_) => {
                report.files_changed += 1;
                report.replacements += count;
            }
            Err(e) => report.errors.push(format!("{p}: {e}")),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn opts(root: &Path, q: &str) -> SearchOptions {
        SearchOptions {
            root: root.to_string_lossy().into_owned(),
            query: q.into(),
            ..Default::default()
        }
    }

    fn tree() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        fs::create_dir_all(r.join("src")).unwrap();
        fs::create_dir_all(r.join("target")).unwrap();
        fs::create_dir_all(r.join(".hidden")).unwrap();
        fs::write(r.join(".gitignore"), "target/\n").unwrap();
        fs::write(r.join("src/a.rs"), "fn main() {}\nlet Foo = 1;\n").unwrap();
        fs::write(r.join("src/b.txt"), "foo and FOO\n").unwrap();
        fs::write(r.join("target/out.rs"), "foo ignored\n").unwrap();
        fs::write(r.join(".hidden/h.txt"), "foo hidden\n").unwrap();
        fs::write(r.join("bin.dat"), [b'f', b'o', b'o', 0, 0, 1, 2, 3]).unwrap();
        d
    }

    #[test]
    fn finds_case_insensitively_and_skips_ignored_hidden_and_binary() {
        let d = tree();
        let r = search(&opts(d.path(), "foo"), None).unwrap();
        let names: Vec<_> = r
            .files
            .iter()
            .map(|f| {
                Path::new(&f.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, ["a.rs", "b.txt"]);
        assert_eq!(r.total_matches, 3);
        assert_eq!(r.files_skipped_binary, 1);
    }

    #[test]
    fn gitignore_can_be_turned_off() {
        let d = tree();
        let mut o = opts(d.path(), "foo");
        o.respect_gitignore = false;
        let r = search(&o, None).unwrap();
        assert!(r.files.iter().any(|f| f.path.contains("target")));
    }

    #[test]
    fn case_sensitive_and_whole_word() {
        let d = tree();
        let mut o = opts(d.path(), "foo");
        o.case_sensitive = true;
        assert_eq!(search(&o, None).unwrap().total_matches, 1);
        let mut o = opts(d.path(), "fo");
        o.whole_word = true;
        assert_eq!(search(&o, None).unwrap().total_matches, 0);
    }

    #[test]
    fn regex_and_invalid_regex() {
        let d = tree();
        let mut o = opts(d.path(), r"f\w+\(\)");
        o.regex = true;
        assert_eq!(search(&o, None).unwrap().total_matches, 0);
        let mut o = opts(d.path(), r"fn \w+");
        o.regex = true;
        assert_eq!(search(&o, None).unwrap().total_matches, 1);
        let mut o = opts(d.path(), "(");
        o.regex = true;
        assert!(matches!(search(&o, None), Err(Error::Pattern(_))));
    }

    #[test]
    fn glob_filters() {
        let d = tree();
        let mut o = opts(d.path(), "foo");
        o.include = "*.txt".into();
        let r = search(&o, None).unwrap();
        assert_eq!(r.files.len(), 1);
        let mut o = opts(d.path(), "foo");
        o.exclude = "src".into();
        assert!(search(&o, None).unwrap().files.is_empty());
        let mut o = opts(d.path(), "foo");
        o.include = "src/**/*.rs; *.md".into();
        assert_eq!(search(&o, None).unwrap().files.len(), 1);
    }

    #[test]
    fn line_and_column_are_utf16_based() {
        let re = build_regex("x", false, true, false).unwrap();
        let m = find_in_text(&re, "a\r\n😀x y\nx", None, 10);
        assert_eq!((m[0].line, m[0].column), (2, 2));
        assert_eq!((m[1].line, m[1].column), (3, 0));
    }

    #[test]
    fn dollar_matches_before_crlf() {
        let re = build_regex("foo$", true, true, false).unwrap();
        let m = find_in_text(&re, "foo\r\nbar", None, 10);
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].line, m[0].column, m[0].length), (1, 0, 3));
        // `.` must not swallow the carriage return.
        let dots = build_regex("o.$", true, true, false).unwrap();
        assert_eq!(find_in_text(&dots, "foo\r\nbar", None, 10)[0].length, 2);
    }

    #[test]
    fn replace_in_crlf_file_with_anchor() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.txt");
        fs::write(&f, "foo\r\nbar\r\n").unwrap();
        let mut o = opts(d.path(), "foo$");
        o.regex = true;
        let rep = replace_in_files(&o, "baz", &[f.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(rep.replacements, 1);
        assert_eq!(fs::read(&f).unwrap(), b"baz\r\nbar\r\n");
    }

    #[test]
    fn preview_shows_replacement() {
        let re = build_regex(r"(\w+)@", true, true, false).unwrap();
        let m = find_in_text(&re, "mail bob@example.com", Some(("<$1>@", true)), 10);
        assert_eq!(m[0].replaced.as_deref(), Some("mail <bob>@example.com"));
        let lit = build_regex("a.b", false, true, false).unwrap();
        let m = find_in_text(&lit, "a.b", Some(("$1", false)), 10);
        assert_eq!(m[0].replaced.as_deref(), Some("$1"));
    }

    #[test]
    fn max_results_truncates() {
        let d = tree();
        let mut o = opts(d.path(), "foo");
        o.max_results = 1;
        let r = search(&o, None).unwrap();
        assert_eq!(r.total_matches, 1);
        assert!(r.truncated);
    }

    #[test]
    fn replace_all_keeps_encoding_and_eol_and_honours_selection() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        let bytes: Vec<u8> = "\u{feff}hello\r\nhello"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        fs::write(&a, bytes).unwrap();
        fs::write(&b, "hello").unwrap();
        let o = opts(d.path(), "hello");
        let a_s = a.to_string_lossy().into_owned();
        let rep = replace_in_files(&o, "bye", &[a_s]).unwrap();
        assert_eq!((rep.files_changed, rep.replacements), (1, 2));
        let o2 = fileio::read(&a, Eol::Lf).unwrap();
        assert_eq!(o2.text, "bye\r\nbye");
        assert_eq!(o2.encoding, encoding::TextEncoding::Utf16Le);
        assert_eq!(fs::read_to_string(&b).unwrap(), "hello");
    }

    #[test]
    fn replace_rejects_paths_outside_the_search() {
        let d = tree();
        let outside = tempfile::tempdir().unwrap();
        let f = outside.path().join("x.txt");
        fs::write(&f, "foo").unwrap();
        let rep = replace_in_files(
            &opts(d.path(), "foo"),
            "bar",
            &[f.to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(rep.files_changed, 0);
        assert_eq!(rep.errors.len(), 1);
        assert_eq!(fs::read_to_string(&f).unwrap(), "foo");
    }

    #[test]
    fn long_lines_are_windowed() {
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let re = build_regex("needle", false, true, false).unwrap();
        let m = find_in_text(&re, &line, None, 1);
        assert!(m[0].preview.chars().count() <= 160);
        assert_eq!(
            &m[0].preview[m[0].preview_offset..m[0].preview_offset + 6],
            "needle"
        );
    }
}

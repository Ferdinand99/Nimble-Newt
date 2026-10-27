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
    /// Modification time of the file when it was searched. A replacement hands it back and is
    /// refused when the file has changed since.
    pub mtime_ms: i64,
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
    /// Files left untouched on purpose (they cannot be decoded without losing data).
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

/// A file picked from the search preview, with the modification time the preview saw.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    pub mtime_ms: i64,
}

/// At most this many matches are listed per file; a file hitting it marks the search as truncated.
pub const MAX_MATCHES_PER_FILE: usize = 1000;
/// Longest stretch of a line shown around a match (in characters).
const PREVIEW_CHARS: usize = 200;
/// Characters of context kept in front of the match.
const PREVIEW_BEFORE: usize = 40;

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
/// Line boundaries, columns and replaced lines are worked out once per line and never rescanned
/// per match, so a minified file with one huge line and many matches stays linear.
pub fn find_in_text(
    re: &Regex,
    text: &str,
    replacement: Option<(&str, bool)>,
    limit: usize,
) -> Vec<Match> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut line_no = 1usize;
    let mut line_start = 0usize;
    let mut cursor = 0usize;
    // State of the line the previous match was on; rebuilt when a match is on another line.
    let mut cur = LineState::default();
    for m in re.find_iter(text) {
        if out.len() >= limit {
            break;
        }
        if m.is_empty() {
            continue;
        }
        // Advance the line counter up to the match start.
        for i in memchr::memchr_iter(b'\n', &bytes[cursor..m.start()]) {
            line_no += 1;
            line_start = cursor + i + 1;
        }
        cursor = m.start();
        if cur.start != Some(line_start) {
            let line_end =
                memchr::memchr(b'\n', &bytes[line_start..]).map_or(text.len(), |i| line_start + i);
            cur = LineState {
                start: Some(line_start),
                end: line_end,
                ..LineState::default()
            };
        }
        let line = text[line_start..cur.end].trim_end_matches('\r');
        let col_bytes = (m.start() - line_start).min(line.len());
        let match_end_in_line = (m.end() - line_start).min(line.len());
        let column = cur.cursor.utf16_at_byte(line, col_bytes);
        let length = utf16_len(&line[col_bytes..match_end_in_line]).max(1);
        let (preview, preview_offset) = window(line, col_bytes);
        let replaced = replacement.map(|(rep, is_regex)| {
            let new_line = cur.replaced.get_or_insert_with(|| {
                if is_regex {
                    re.replace_all(line, rep).into_owned()
                } else {
                    re.replace_all(line, NoExpand(rep)).into_owned()
                }
            });
            // The replaced line is shown around the same column as the original one.
            let at = cur.replaced_cursor.byte_at_utf16(new_line, column);
            window(new_line, at).0
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

/// Progress through one line while its matches are listed in order.
#[derive(Default)]
struct LineState {
    start: Option<usize>,
    /// Byte offset of the line break (or the end of the text).
    end: usize,
    /// Position reached so far in the line.
    cursor: Cursor,
    /// The whole line after replacement, built on the first match.
    replaced: Option<String>,
    replaced_cursor: Cursor,
}

/// Monotonic position in a line, so moving on to the next match never restarts at the line start.
#[derive(Default)]
struct Cursor {
    byte: usize,
    utf16: usize,
}

impl Cursor {
    /// UTF-16 column of byte offset `byte` of `line`.
    fn utf16_at_byte(&mut self, line: &str, byte: usize) -> usize {
        if byte < self.byte {
            *self = Cursor::default();
        }
        self.utf16 += utf16_len(&line[self.byte..byte]);
        self.byte = byte;
        self.utf16
    }

    /// Byte offset of UTF-16 column `col` of `line` (its end when the column is past it).
    fn byte_at_utf16(&mut self, line: &str, col: usize) -> usize {
        if col < self.utf16 {
            *self = Cursor::default();
        }
        for c in line[self.byte..].chars() {
            if self.utf16 >= col {
                break;
            }
            self.utf16 += c.len_utf16();
            self.byte += c.len_utf8();
        }
        self.byte
    }
}

/// Trims a long line to ~200 chars around byte offset `at`, so huge minified files stay readable
/// and cost no more than the excerpt. Returns the text and the offset of `at` in it (UTF-16 units).
fn window(line: &str, at: usize) -> (String, usize) {
    let at = at.min(line.len());
    let start = line[..at]
        .char_indices()
        .rev()
        .nth(PREVIEW_BEFORE.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    let end = line[start..]
        .char_indices()
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(i, _)| start + i);
    (
        line[start..end].to_owned(),
        utf16_len(&line[start..at.min(end)]),
    )
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
        // Taken before reading: a change after this makes a later replace refuse the file.
        let mtime_ms = fileio::mtime_ms(&path).unwrap_or(0);
        let Some((decoded, binary)) = read_text(&path) else {
            continue;
        };
        report.files_scanned += 1;
        if binary {
            report.files_skipped_binary += 1;
            continue;
        }
        let room = (o.max_results - report.total_matches).min(MAX_MATCHES_PER_FILE);
        let matches = find_in_text(&re, &decoded.text, replacement.map(|r| (r, o.regex)), room);
        if matches.is_empty() {
            continue;
        }
        if matches.len() == MAX_MATCHES_PER_FILE {
            report.truncated = true;
        }
        report.total_matches += matches.len();
        report.files.push(FileMatches {
            path: path.to_string_lossy().into_owned(),
            mtime_ms,
            matches,
        });
    }
    Ok(report)
}

/// Replaces in the given files only (the user's confirmed selection from the preview),
/// preserving each file's encoding and line endings. A file that changed since the preview,
/// or that cannot be decoded without loss, is left alone and reported.
pub fn replace_in_files(
    o: &SearchOptions,
    replacement: &str,
    targets: &[ReplaceTarget],
) -> Result<ReplaceReport> {
    let re = build_regex(&o.query, o.regex, o.case_sensitive, o.whole_word)?;
    let allowed: std::collections::HashSet<PathBuf> = collect_files(o)?.into_iter().collect();
    let mut report = ReplaceReport::default();
    for target in targets {
        let p = &target.path;
        let path = PathBuf::from(p);
        if !allowed.contains(&path) {
            report.errors.push(format!("{p}: not part of the search"));
            continue;
        }
        if fileio::mtime_ms(&path) != Some(target.mtime_ms) {
            report
                .errors
                .push(format!("{p}: changed since the preview, search again"));
            continue;
        }
        let Some((decoded, binary)) = read_text(&path) else {
            report.errors.push(format!("{p}: could not be read"));
            continue;
        };
        if binary {
            continue;
        }
        if decoded.lossy {
            report
                .skipped
                .push(format!("{p}: not valid in its detected encoding"));
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
        match fileio::write_checked(
            &path,
            &new_text,
            decoded.encoding,
            eol,
            Some(target.mtime_ms),
            false,
        ) {
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

    /// A replace target with the file's current modification time, as a fresh preview would give.
    fn target(p: &Path) -> ReplaceTarget {
        ReplaceTarget {
            path: p.to_string_lossy().into_owned(),
            mtime_ms: fileio::mtime_ms(p).unwrap(),
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
        let rep = replace_in_files(&o, "baz", &[target(&f)]).unwrap();
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
        let rep = replace_in_files(&o, "bye", &[target(&a)]).unwrap();
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
        let rep = replace_in_files(&opts(d.path(), "foo"), "bar", &[target(&f)]).unwrap();
        assert_eq!(rep.files_changed, 0);
        assert_eq!(rep.errors.len(), 1);
        assert_eq!(fs::read_to_string(&f).unwrap(), "foo");
    }

    #[test]
    fn long_lines_are_windowed() {
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let re = build_regex("needle", false, true, false).unwrap();
        let m = find_in_text(&re, &line, None, 1);
        assert!(m[0].preview.chars().count() <= PREVIEW_CHARS);
        assert_eq!(
            &m[0].preview[m[0].preview_offset..m[0].preview_offset + 6],
            "needle"
        );
    }

    #[test]
    fn search_reports_the_mtime_the_replace_must_match() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.txt");
        fs::write(&f, "foo").unwrap();
        let r = search(&opts(d.path(), "foo"), None).unwrap();
        assert_eq!(r.files[0].mtime_ms, fileio::mtime_ms(&f).unwrap());
    }

    #[test]
    fn replace_refuses_a_file_changed_since_the_preview() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("a.txt");
        fs::write(&f, "foo").unwrap();
        let mut stale = target(&f);
        stale.mtime_ms -= 5000;
        let rep = replace_in_files(&opts(d.path(), "foo"), "bar", &[stale]).unwrap();
        assert_eq!(rep.files_changed, 0);
        assert_eq!(rep.errors.len(), 1);
        assert!(
            rep.errors[0].contains("changed since the preview"),
            "{rep:?}"
        );
        assert_eq!(fs::read_to_string(&f).unwrap(), "foo");
    }

    #[test]
    fn replace_skips_files_that_do_not_decode_cleanly() {
        let d = tempfile::tempdir().unwrap();
        let bad = d.path().join("bad.txt");
        let good = d.path().join("good.txt");
        // A UTF-8 byte order mark promises valid UTF-8, then a stray byte breaks the promise.
        let bytes = [[0xef, 0xbb, 0xbf].as_slice(), b"foo ", &[0xff], b" foo"].concat();
        assert!(encoding::decode(&bytes).lossy);
        fs::write(&bad, &bytes).unwrap();
        fs::write(&good, "foo").unwrap();
        let rep = replace_in_files(
            &opts(d.path(), "foo"),
            "bar",
            &[target(&bad), target(&good)],
        )
        .unwrap();
        assert_eq!(rep.skipped.len(), 1, "{rep:?}");
        assert_eq!(rep.files_changed, 1);
        assert_eq!(fs::read(&bad).unwrap(), bytes);
        assert_eq!(fs::read_to_string(&good).unwrap(), "bar");
    }

    #[test]
    fn a_20_mb_single_line_is_searched_quickly() {
        let line = "needle ".repeat(3_000_000); // about 21 MB, one line, 3 million matches
        let re = build_regex("needle", false, true, false).unwrap();
        let start = std::time::Instant::now();
        let m = find_in_text(&re, &line, Some(("pin", false)), MAX_MATCHES_PER_FILE);
        assert!(start.elapsed().as_secs() < 10, "{:?}", start.elapsed());
        assert_eq!(m.len(), MAX_MATCHES_PER_FILE);
        for x in &m {
            assert!(x.preview.chars().count() <= PREVIEW_CHARS);
            assert!(x.replaced.as_ref().unwrap().chars().count() <= PREVIEW_CHARS);
        }
        assert_eq!(m[999].column, 999 * 7);
        // A match near the far end is as cheap as one at the start.
        let re = build_regex("needle $", true, true, false).unwrap();
        let start = std::time::Instant::now();
        let end = find_in_text(&re, &line, Some(("pin", false)), 1);
        assert!(start.elapsed().as_secs() < 10, "{:?}", start.elapsed());
        assert_eq!(end[0].column, 7 * 2_999_999);
    }

    #[test]
    fn matches_per_file_are_capped() {
        let d = tempfile::tempdir().unwrap();
        let text = "x\n".repeat(MAX_MATCHES_PER_FILE + 50);
        fs::write(d.path().join("a.txt"), text).unwrap();
        let r = search(&opts(d.path(), "x"), None).unwrap();
        assert_eq!(r.total_matches, MAX_MATCHES_PER_FILE);
        assert!(r.truncated);
    }

    #[test]
    fn window_respects_multibyte_boundaries() {
        let line = format!("{}needle{}", "é😀".repeat(300), "ü".repeat(300));
        let re = build_regex("needle", false, true, false).unwrap();
        let m = find_in_text(&re, &line, Some(("pin", false)), 1);
        let units: Vec<u16> = m[0].preview.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&units[m[0].preview_offset..m[0].preview_offset + 6]),
            "needle"
        );
        assert!(m[0].replaced.as_ref().unwrap().contains("pin"));
    }
}

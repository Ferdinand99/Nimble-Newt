//! Line-based comparison of two texts, for files too large for the in-browser diff.

use crate::eol::Eol;
use crate::Result;
use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices_deadline, Algorithm, DiffOp};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Whitespace {
    /// Compare lines exactly.
    #[default]
    Exact,
    /// Ignore spaces and tabs at the end of lines.
    Trailing,
    /// Ignore leading and trailing whitespace.
    Edges,
    /// Ignore all whitespace, wherever it is.
    All,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffOptions {
    pub whitespace: Whitespace,
    pub ignore_case: bool,
    /// Stop refining after this long and report a coarser result (`timed_out`).
    pub timeout_ms: u64,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            whitespace: Whitespace::Exact,
            ignore_case: false,
            timeout_ms: 10_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HunkKind {
    Added,
    Removed,
    Changed,
}

/// A run of differing lines. Line numbers are 0-based; a side with `len == 0` has nothing in this hunk
/// (its `start` is where the other side's lines would be inserted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub kind: HunkKind,
    pub a_start: usize,
    pub a_len: usize,
    pub b_start: usize,
    pub b_len: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub hunks: Vec<Hunk>,
    pub a_lines: usize,
    pub b_lines: usize,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub identical: bool,
    pub timed_out: bool,
}

/// Splits into lines on `\n`, dropping a `\r` before it, so CRLF and LF files compare equal.
/// A trailing newline does not create an empty last line.
pub fn lines_of(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

fn key(line: &str, o: &DiffOptions) -> String {
    let t = match o.whitespace {
        Whitespace::Exact => line.to_owned(),
        Whitespace::Trailing => line.trim_end_matches([' ', '\t']).to_owned(),
        Whitespace::Edges => line.trim_matches([' ', '\t']).to_owned(),
        Whitespace::All => line.chars().filter(|c| !c.is_whitespace()).collect(),
    };
    if o.ignore_case {
        t.to_lowercase()
    } else {
        t
    }
}

/// Maps every distinct line key to a small integer so the diff runs on `u32` slices.
fn intern(lines: &[&str], o: &DiffOptions, table: &mut HashMap<String, u32>) -> Vec<u32> {
    let plain = o.whitespace == Whitespace::Exact && !o.ignore_case;
    lines
        .iter()
        .map(|l| {
            let k = if plain { (*l).to_owned() } else { key(l, o) };
            let next = table.len() as u32;
            *table.entry(k).or_insert(next)
        })
        .collect()
}

pub fn compare(a: &str, b: &str, o: &DiffOptions) -> Comparison {
    let (la, lb) = (lines_of(a), lines_of(b));
    let mut table = HashMap::new();
    let (ia, ib) = (intern(&la, o, &mut table), intern(&lb, o, &mut table));
    let deadline = Instant::now().checked_add(Duration::from_millis(o.timeout_ms.max(1)));
    let ops = capture_diff_slices_deadline(Algorithm::Myers, &ia, &ib, deadline);
    let mut out = Comparison {
        a_lines: la.len(),
        b_lines: lb.len(),
        ..Default::default()
    };
    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index,
                old_len,
                new_index,
            } => {
                out.removed_lines += old_len;
                out.hunks.push(Hunk {
                    kind: HunkKind::Removed,
                    a_start: old_index,
                    a_len: old_len,
                    b_start: new_index,
                    b_len: 0,
                });
            }
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => {
                out.added_lines += new_len;
                out.hunks.push(Hunk {
                    kind: HunkKind::Added,
                    a_start: old_index,
                    a_len: 0,
                    b_start: new_index,
                    b_len: new_len,
                });
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                out.removed_lines += old_len;
                out.added_lines += new_len;
                out.hunks.push(Hunk {
                    kind: HunkKind::Changed,
                    a_start: old_index,
                    a_len: old_len,
                    b_start: new_index,
                    b_len: new_len,
                });
            }
        }
    }
    out.identical = out.hunks.is_empty();
    out.timed_out = deadline.is_some_and(|d| Instant::now() >= d);
    out
}

/// Reads two files (any supported encoding) and compares them. Returns the line ending of each.
pub fn compare_files(
    a: &std::path::Path,
    b: &std::path::Path,
    o: &DiffOptions,
) -> Result<(Comparison, Eol, Eol)> {
    let fa = crate::fileio::read(a, Eol::Lf)?;
    let fb = crate::fileio::read(b, Eol::Lf)?;
    Ok((compare(&fa.text, &fb.text, o), fa.eol, fb.eol))
}

/// The lines `[start, start + len)` of `text`, for showing a hunk.
pub fn slice_lines(text: &str, start: usize, len: usize) -> Vec<String> {
    lines_of(text)
        .into_iter()
        .skip(start)
        .take(len)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmp(a: &str, b: &str) -> Comparison {
        compare(a, b, &DiffOptions::default())
    }

    #[test]
    fn identical_texts_have_no_hunks() {
        let c = cmp("a\nb\nc\n", "a\nb\nc\n");
        assert!(c.identical);
        assert_eq!((c.a_lines, c.b_lines), (3, 3));
        assert!(cmp("", "").identical);
    }

    #[test]
    fn detects_insert_delete_and_replace() {
        let c = cmp("a\nb\nc\n", "a\nx\nb\nc\nd\n");
        assert_eq!(c.added_lines, 2);
        assert_eq!(c.removed_lines, 0);
        assert_eq!(
            c.hunks[0],
            Hunk {
                kind: HunkKind::Added,
                a_start: 1,
                a_len: 0,
                b_start: 1,
                b_len: 1
            }
        );
        assert_eq!(
            c.hunks[1],
            Hunk {
                kind: HunkKind::Added,
                a_start: 3,
                a_len: 0,
                b_start: 4,
                b_len: 1
            }
        );

        let d = cmp("a\nb\nc\n", "a\nc\n");
        assert_eq!(
            d.hunks,
            vec![Hunk {
                kind: HunkKind::Removed,
                a_start: 1,
                a_len: 1,
                b_start: 1,
                b_len: 0
            }]
        );

        let r = cmp("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(
            r.hunks,
            vec![Hunk {
                kind: HunkKind::Changed,
                a_start: 1,
                a_len: 1,
                b_start: 1,
                b_len: 1
            }]
        );
        assert_eq!((r.added_lines, r.removed_lines), (1, 1));
    }

    #[test]
    fn whole_file_vs_empty() {
        let c = cmp("a\nb\n", "");
        assert_eq!(
            c.hunks,
            vec![Hunk {
                kind: HunkKind::Removed,
                a_start: 0,
                a_len: 2,
                b_start: 0,
                b_len: 0
            }]
        );
        let d = cmp("", "a\nb\n");
        assert_eq!(
            d.hunks,
            vec![Hunk {
                kind: HunkKind::Added,
                a_start: 0,
                a_len: 0,
                b_start: 0,
                b_len: 2
            }]
        );
    }

    #[test]
    fn crlf_and_lf_compare_equal_and_a_missing_final_newline_is_ignored() {
        assert!(cmp("a\r\nb\r\n", "a\nb\n").identical);
        assert!(cmp("a\nb", "a\nb\n").identical);
    }

    #[test]
    fn whitespace_and_case_options() {
        let o = |w, c| DiffOptions {
            whitespace: w,
            ignore_case: c,
            ..Default::default()
        };
        assert!(!compare("a  b\n", "a b\n", &o(Whitespace::Exact, false)).identical);
        assert!(compare("a  b\n", "ab\n", &o(Whitespace::All, false)).identical);
        assert!(compare("  a\t\n", "a\n", &o(Whitespace::Edges, false)).identical);
        assert!(compare("a \n", "a\n", &o(Whitespace::Trailing, false)).identical);
        assert!(!compare("  a\n", "a\n", &o(Whitespace::Trailing, false)).identical);
        assert!(compare("Hello\n", "hELLO\n", &o(Whitespace::Exact, true)).identical);
        assert!(!compare("Hello\n", "hELLO\n", &o(Whitespace::Exact, false)).identical);
    }

    #[test]
    fn moved_blocks_show_as_remove_plus_add() {
        let c = cmp("a\nb\nc\nd\n", "c\nd\na\nb\n");
        assert_eq!(c.added_lines, 2);
        assert_eq!(c.removed_lines, 2);
    }

    #[test]
    fn unicode_lines() {
        let c = cmp("blåbær\n日本語\n", "blåbær\n日本\n");
        assert_eq!(c.hunks.len(), 1);
        assert_eq!(c.hunks[0].kind, HunkKind::Changed);
    }

    #[test]
    fn large_inputs_with_scattered_changes_are_fast_and_exact() {
        let a: String = (0..200_000).map(|i| format!("line {i}\n")).collect();
        let mut b = String::new();
        for i in 0..200_000 {
            if i % 10_000 == 0 {
                b.push_str("changed\n");
            } else if i % 25_000 == 7 {
                continue; // deleted
            } else {
                b.push_str(&format!("line {i}\n"));
            }
        }
        let start = Instant::now();
        let c = cmp(&a, &b);
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "took {:?}",
            start.elapsed()
        );
        assert_eq!(c.removed_lines, 20 + 8);
        assert_eq!(c.added_lines, 20);
        assert!(!c.timed_out);
    }

    #[test]
    fn compare_files_reads_encodings() {
        let d = tempfile::tempdir().unwrap();
        let (pa, pb) = (d.path().join("a.txt"), d.path().join("b.txt"));
        std::fs::write(&pa, b"caf\xE9\nline\n").unwrap(); // Windows-1252
        std::fs::write(&pb, "café\nline\n").unwrap(); // UTF-8
        let (c, _, _) = compare_files(&pa, &pb, &DiffOptions::default()).unwrap();
        assert!(c.identical);
    }

    #[test]
    fn slice_lines_returns_the_hunk_text() {
        assert_eq!(slice_lines("a\nb\nc\nd\n", 1, 2), vec!["b", "c"]);
        assert!(slice_lines("a\n", 5, 2).is_empty());
    }
}

//! Read-only, chunked access to very large text files (multi-GB logs).
//!
//! Nothing is ever loaded whole. Opening reads only the head of the file; a background thread then
//! calls [`LargeFile::index_step`] repeatedly, which scans the file for `\n` and records the byte
//! offset of every `checkpoint_lines`-th line start (8 bytes per 1000 lines by default). Readers jump to
//! the nearest checkpoint and scan forward a few hundred lines, so a viewer can scroll anywhere that is
//! already indexed, and (more slowly) even into regions that are not.
//!
//! Only `\n` terminates a line; a trailing `\r` is stripped from the text. Lines are decoded one at a
//! time, so multi-byte sequences split across read chunks are never a problem. All ASCII-compatible
//! encodings are supported; UTF-16 is refused because its line breaks are not byte-addressable.

use crate::encoding::{self, TextEncoding};
use crate::eol::{self, Eol};
use crate::{fileio, search, Error, Result};
use memchr::{memchr, memchr_iter, memrchr};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs::File;
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// How much of the file `open` looks at to detect the encoding and line ending.
const HEAD_BYTES: usize = 64 * 1024;
/// No more than this many bytes of one line are ever read into memory.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// `read_lines` into a region that is not indexed scans at most this far from the last checkpoint.
const UNINDEXED_SCAN_CAP: u64 = 64 * 1024 * 1024;
/// Bytes of the indexed region kept to notice that the file was replaced.
const TAIL_FINGERPRINT: usize = 64;
const BOM_UTF8: &[u8] = &[0xEF, 0xBB, 0xBF];
/// Longest preview string in a [`Hit`], in UTF-16 units.
const PREVIEW_UNITS: usize = 240;

/// Message of the error returned by `search` and `count_matches` when `cancel` was set.
pub const CANCELLED: &str = "cancelled";

/// True when `e` is the error a cancelled `search` / `count_matches` returns.
pub fn is_cancelled(e: &Error) -> bool {
    matches!(e, Error::Msg(m) if m == CANCELLED)
}

fn cancelled() -> Error {
    Error::Msg(CANCELLED.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IndexOptions {
    /// One checkpoint (byte offset of a line start) is stored per this many lines.
    pub checkpoint_lines: u64,
    /// Size of one scan step; also bounds the memory the indexer uses.
    pub chunk_bytes: usize,
}

impl Default for IndexOptions {
    fn default() -> Self {
        IndexOptions {
            checkpoint_lines: 1000,
            chunk_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub path: String,
    pub size: u64,
    pub encoding: TextEncoding,
    /// Dominant line ending of the head of the file (platform default when it has none).
    pub eol: Eol,
    /// Length of the UTF-8 BOM at the start of the file (0 or 3). Line 0 starts after it.
    pub bom_len: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub indexed_bytes: u64,
    /// Lines that start inside the indexed region (a partial last line counts).
    pub indexed_lines: u64,
    pub size: u64,
    pub done: bool,
    /// Known exactly only once `done`.
    pub total_lines: Option<u64>,
    /// Set by `refresh` when the file shrank or was replaced and the index was thrown away.
    pub reset: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineText {
    pub text: String,
    /// The line was longer than `max_chars` (or than the safety limit) and was cut.
    pub truncated: bool,
    /// Byte offset of the start of the line in the file.
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinesChunk {
    pub first: u64,
    pub lines: Vec<LineText>,
    /// False when line `first` could not be located: it is past the end of the file, or so far past
    /// the indexed region that locating it would mean scanning more than 64 MiB. `lines` is empty then.
    pub available: bool,
    /// The end of the file was reached (fewer than `count` lines came back, or none).
    pub eof: bool,
    /// Known only once indexing is complete.
    pub total_lines: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeQuery {
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

impl LargeQuery {
    fn build(&self) -> Result<Regex> {
        search::build_regex(
            &self.pattern,
            self.regex,
            self.case_sensitive,
            self.whole_word,
        )
    }
}

/// A position in the file: 0-based line and UTF-16 column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPos {
    pub line: u64,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub line: u64,
    /// UTF-16 column of the match start within the line.
    pub column: usize,
    /// Length of the match in UTF-16 units.
    pub length: usize,
    /// Byte offset of the match start in the file (exact for UTF-8 and single-byte code pages).
    pub byte_offset: u64,
    /// The line, shortened around the match when it is very long.
    pub preview: String,
    pub wrapped: bool,
}

struct State {
    file: Arc<File>,
    size: u64,
    /// Line 0 starts here (after the BOM).
    base: u64,
    indexed_bytes: u64,
    newlines: u64,
    /// The last indexed byte was `\n` (the next line has not started yet).
    last_nl: bool,
    /// `checkpoints[i]` is the byte offset of the start of line `i * checkpoint_lines`.
    checkpoints: Vec<u64>,
    /// Last bytes of the indexed region, to notice a replaced file.
    tail: Vec<u8>,
}

impl State {
    fn fresh(file: Arc<File>, size: u64, base: u64) -> State {
        State {
            file,
            size,
            base,
            indexed_bytes: base.min(size),
            newlines: 0,
            last_nl: false,
            checkpoints: vec![base],
            tail: Vec::new(),
        }
    }

    fn lines(&self) -> u64 {
        self.newlines + u64::from(self.indexed_bytes > self.base && !self.last_nl)
    }
}

struct Snap {
    file: Arc<File>,
    size: u64,
    indexed_bytes: u64,
    indexed_lines: u64,
    /// Nearest checkpoint at or before the requested line.
    cp_line: u64,
    cp_off: u64,
}

enum Locate {
    Found(u64),
    /// The line does not exist (yet): past the end of the file or of the indexed region.
    Beyond,
    /// Gave up after scanning the allowed distance.
    Unreached,
}

/// A large file opened for chunked reading. `Send + Sync`: share it in an `Arc` between the thread
/// that runs [`LargeFile::index_step`] and the readers.
pub struct LargeFile {
    path: PathBuf,
    encoding: TextEncoding,
    eol: Eol,
    bom_len: u64,
    opts: IndexOptions,
    /// Serialises `index_step` / `refresh`; readers never take it.
    index_lock: Mutex<()>,
    state: Mutex<State>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], off: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, off)
}

#[cfg(windows)]
fn read_at(f: &File, buf: &mut [u8], off: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(f, buf, off)
}

/// Reads until `buf` is full or the file ends; returns the number of bytes read.
fn read_full_at(f: &File, buf: &mut [u8], mut off: u64) -> io::Result<usize> {
    let mut done = 0;
    while done < buf.len() {
        match read_at(f, &mut buf[done..], off) {
            Ok(0) => break,
            Ok(n) => {
                done += n;
                off += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(done)
}

#[derive(Clone, Copy)]
enum Loc {
    Buf(usize, usize),
    Scratch,
}

#[derive(Clone, Copy)]
struct LineRef {
    offset: u64,
    loc: Loc,
    truncated: bool,
}

/// Iterates the lines of a file forwards from a line start, reading block by block.
struct FwdLines {
    file: Arc<File>,
    pos: u64,
    end: u64,
    buf: Vec<u8>,
    bi: usize,
    bn: usize,
    scratch: Vec<u8>,
    line_off: u64,
    block: usize,
}

impl FwdLines {
    fn new(file: Arc<File>, start: u64, end: u64, block: usize) -> FwdLines {
        FwdLines {
            file,
            pos: start,
            end,
            buf: Vec::new(),
            bi: 0,
            bn: 0,
            scratch: Vec::new(),
            line_off: start,
            block: block.max(1),
        }
    }

    fn refill(&mut self) -> io::Result<bool> {
        self.bi = 0;
        self.bn = 0;
        if self.pos >= self.end {
            return Ok(false);
        }
        let n = (self.end - self.pos).min(self.block as u64) as usize;
        self.buf.resize(n, 0);
        let got = read_full_at(&self.file, &mut self.buf[..n], self.pos)?;
        self.bn = got;
        self.pos += got as u64;
        Ok(got > 0)
    }

    /// The next line, without its terminator. At most `cap` bytes are kept; the rest is skipped.
    fn next_line(&mut self, cap: usize) -> io::Result<Option<LineRef>> {
        if self.bi == self.bn && !self.refill()? {
            return Ok(None);
        }
        let offset = self.line_off;
        self.scratch.clear();
        let mut used = false;
        let mut truncated = false;
        let mut loc = Loc::Scratch;
        loop {
            if self.bi == self.bn && !self.refill()? {
                break; // an unterminated last line
            }
            let hay = &self.buf[self.bi..self.bn];
            let (plen, found) = match memchr(b'\n', hay) {
                Some(i) => (i, true),
                None => (hay.len(), false),
            };
            let st = self.bi;
            let used_bytes = plen + usize::from(found);
            self.bi += used_bytes;
            self.line_off += used_bytes as u64;
            if !used && found {
                truncated = plen > cap;
                loc = Loc::Buf(st, st + plen.min(cap));
                break;
            }
            used = true;
            let take = plen.min(cap.saturating_sub(self.scratch.len()));
            self.scratch.extend_from_slice(&self.buf[st..st + take]);
            truncated |= take < plen;
            if found {
                break;
            }
        }
        if !truncated {
            match loc {
                Loc::Buf(s, e) if e > s && self.buf[e - 1] == b'\r' => loc = Loc::Buf(s, e - 1),
                Loc::Scratch if self.scratch.last() == Some(&b'\r') => {
                    self.scratch.pop();
                }
                _ => {}
            }
        }
        Ok(Some(LineRef {
            offset,
            loc,
            truncated,
        }))
    }

    fn bytes(&self, r: &LineRef) -> &[u8] {
        match r.loc {
            Loc::Buf(s, e) => &self.buf[s..e],
            Loc::Scratch => &self.scratch,
        }
    }
}

/// Iterates the lines of a file backwards from a line start (or the end of the file).
struct BackLines {
    file: Arc<File>,
    lo: u64,
    block: usize,
    win: Vec<u8>,
    wstart: u64,
    wend: u64,
    /// Exclusive end (before the terminator) of the next line to yield; `None` when finished.
    cursor: Option<u64>,
    scratch: Vec<u8>,
}

impl BackLines {
    /// `boundary` must be the start of a line or the end of the file; `lo` is where line 0 starts.
    fn new(file: Arc<File>, lo: u64, boundary: u64, block: usize) -> io::Result<BackLines> {
        let cursor = if boundary <= lo {
            None
        } else {
            let mut b = [0u8; 1];
            read_full_at(&file, &mut b, boundary - 1)?;
            Some(if b[0] == b'\n' {
                boundary - 1
            } else {
                boundary
            })
        };
        Ok(BackLines {
            file,
            lo,
            block: block.max(1),
            win: Vec::new(),
            wstart: 0,
            wend: 0,
            cursor,
            scratch: Vec::new(),
        })
    }

    fn fill(&mut self, pos: u64) -> io::Result<()> {
        let from = pos.saturating_sub(self.block as u64).max(self.lo);
        self.win.resize((pos - from) as usize, 0);
        let got = read_full_at(&self.file, &mut self.win, from)?;
        self.win.truncate(got);
        self.wstart = from;
        self.wend = from + got as u64;
        if self.wend != pos {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file changed while reading",
            ));
        }
        Ok(())
    }

    fn prev_line(&mut self, cap: usize) -> io::Result<Option<LineRef>> {
        let Some(le) = self.cursor else {
            return Ok(None);
        };
        let mut pos = le;
        let mut parts: Vec<Vec<u8>> = Vec::new();
        let mut kept = 0usize;
        let mut overflow = false;
        let mut single: Option<Range<usize>> = None;
        let start;
        loop {
            if pos <= self.lo {
                start = self.lo;
                if parts.is_empty() {
                    single = Some(0..0);
                }
                break;
            }
            if !(self.wstart < pos && pos <= self.wend) {
                self.fill(pos)?;
            }
            let slice = &self.win[..(pos - self.wstart) as usize];
            match memrchr(b'\n', slice) {
                Some(i) => {
                    start = self.wstart + i as u64 + 1;
                    if parts.is_empty() && !overflow {
                        single = Some(i + 1..slice.len());
                    } else if !overflow {
                        parts.push(slice[i + 1..].to_vec());
                    }
                    break;
                }
                None => {
                    if !overflow {
                        parts.push(slice.to_vec());
                        kept += slice.len();
                        if kept > cap {
                            overflow = true;
                            parts.clear();
                        }
                    }
                    pos = self.wstart;
                }
            }
        }
        self.cursor = (start > self.lo).then(|| start - 1);
        let line_len = (le - start) as usize;
        let truncated = line_len > cap;
        let loc = if overflow {
            // Only the end of the line was seen; fetch the head.
            self.scratch.resize(cap, 0);
            let got = read_full_at(&self.file, &mut self.scratch, start)?;
            self.scratch.truncate(got);
            Loc::Scratch
        } else if let (Some(r), true) = (single, parts.is_empty()) {
            let r = r.start..r.start + r.len().min(cap);
            Loc::Buf(r.start, r.end)
        } else {
            self.scratch.clear();
            for p in parts.iter().rev() {
                self.scratch.extend_from_slice(p);
            }
            self.scratch.truncate(cap);
            Loc::Scratch
        };
        let mut r = LineRef {
            offset: start,
            loc,
            truncated,
        };
        if !truncated {
            match r.loc {
                Loc::Buf(s, e) if e > s && self.win[e - 1] == b'\r' => r.loc = Loc::Buf(s, e - 1),
                Loc::Scratch if self.scratch.last() == Some(&b'\r') => {
                    self.scratch.pop();
                }
                _ => {}
            }
        }
        Ok(Some(r))
    }

    fn bytes(&self, r: &LineRef) -> &[u8] {
        match r.loc {
            Loc::Buf(s, e) => &self.win[s..e],
            Loc::Scratch => &self.scratch,
        }
    }
}

fn utf16_len(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.chars().map(char::len_utf16).sum()
    }
}

/// Byte length of the longest prefix of `s` that is at most `max` UTF-16 units, and whether it cut.
fn cut_units(s: &str, max: usize) -> (usize, bool) {
    if s.len() <= max {
        return (s.len(), false);
    }
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let u = c.len_utf16();
        if units + u > max {
            return (i, true);
        }
        units += u;
    }
    (s.len(), false)
}

fn unit_to_byte(s: &str, unit: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= unit {
            return i;
        }
        units += c.len_utf16();
    }
    s.len()
}

fn preview(text: &str, col: usize) -> String {
    if text.len() <= PREVIEW_UNITS {
        return text.to_owned();
    }
    let rest = if utf16_len(text) <= PREVIEW_UNITS {
        text
    } else {
        &text[unit_to_byte(text, col.saturating_sub(60))..]
    };
    let (end, _) = cut_units(rest, PREVIEW_UNITS);
    rest[..end].to_owned()
}

fn line_matches<'r, 't>(
    re: &'r Regex,
    text: &'t str,
) -> impl Iterator<Item = regex::Match<'t>> + use<'r, 't> {
    re.find_iter(text).filter(|m| !m.is_empty())
}

fn file_len(f: &File) -> Result<u64> {
    Ok(f.metadata()?.len())
}

struct FwdPass {
    off: u64,
    end: u64,
    line0: u64,
    first_col: Option<usize>,
    last_line: Option<u64>,
}

impl LargeFile {
    pub fn open(path: &Path, opts: IndexOptions) -> Result<(LargeFile, OpenInfo)> {
        Self::open_with(path, opts, None)
    }

    /// Like `open`, with an explicit encoding instead of detection (e.g. the user picked one).
    pub fn open_with(
        path: &Path,
        opts: IndexOptions,
        encoding: Option<TextEncoding>,
    ) -> Result<(LargeFile, OpenInfo)> {
        let file = File::open(path)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(Error::Msg(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        let size = meta.len();
        let mut head = vec![0u8; HEAD_BYTES.min(size as usize)];
        let got = read_full_at(&file, &mut head, 0)?;
        head.truncate(got);
        let enc = encoding.unwrap_or_else(|| encoding::detect(&head));
        if matches!(enc, TextEncoding::Utf16Le | TextEncoding::Utf16Be) {
            return Err(Error::Msg(format!(
                "{} is UTF-16, which large-file mode cannot read (its line breaks are not byte-addressable)",
                path.display()
            )));
        }
        if fileio::looks_binary(&head) {
            return Err(Error::Msg(format!(
                "{} looks like a binary file",
                path.display()
            )));
        }
        let bom_len = match enc {
            TextEncoding::Utf8 | TextEncoding::Utf8Bom if head.starts_with(BOM_UTF8) => 3,
            _ => 0,
        };
        let mut body = &head[bom_len as usize..];
        if head.len() == HEAD_BYTES {
            body = body.strip_suffix(b"\r").unwrap_or(body);
        }
        let head_text = decode_bytes(enc, body, false);
        let eol = eol::detect(&head_text).unwrap_or_else(Eol::platform_default);
        let opts = IndexOptions {
            checkpoint_lines: opts.checkpoint_lines.max(1),
            chunk_bytes: opts.chunk_bytes.max(1),
        };
        let lf = LargeFile {
            path: path.to_path_buf(),
            encoding: enc,
            eol,
            bom_len,
            opts,
            index_lock: Mutex::new(()),
            state: Mutex::new(State::fresh(Arc::new(file), size, bom_len)),
        };
        let info = OpenInfo {
            path: path.to_string_lossy().into_owned(),
            size,
            encoding: enc,
            eol,
            bom_len,
        };
        Ok((lf, info))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn encoding(&self) -> TextEncoding {
        self.encoding
    }

    pub fn eol(&self) -> Eol {
        self.eol
    }

    fn io_block(&self, big: bool) -> usize {
        self.opts
            .chunk_bytes
            .min(if big { 256 * 1024 } else { 16 * 1024 })
            .max(1)
    }

    fn status_of(&self, s: &State, reset: bool) -> IndexStatus {
        let done = s.indexed_bytes >= s.size;
        let lines = s.lines();
        IndexStatus {
            indexed_bytes: s.indexed_bytes,
            indexed_lines: lines,
            size: s.size,
            done,
            total_lines: done.then_some(lines),
            reset,
        }
    }

    pub fn status(&self) -> IndexStatus {
        self.status_of(&lock(&self.state), false)
    }

    /// Scans roughly `budget_bytes` (at least one chunk) of the not yet indexed part of the file.
    /// Safe to call from a background thread while other threads read.
    pub fn index_step(&self, budget_bytes: usize) -> Result<IndexStatus> {
        let _g = lock(&self.index_lock);
        self.index_step_locked(budget_bytes)
    }

    fn index_step_locked(&self, budget_bytes: usize) -> Result<IndexStatus> {
        let (file, mut pos, size, mut nl, mut tail) = {
            let s = lock(&self.state);
            (
                s.file.clone(),
                s.indexed_bytes,
                s.size,
                s.newlines,
                s.tail.clone(),
            )
        };
        let k = self.opts.checkpoint_lines;
        let mut buf = vec![
            0u8;
            self.opts
                .chunk_bytes
                .min((size.saturating_sub(pos)) as usize)
        ];
        let mut scanned = 0usize;
        while pos < size {
            let n = self.opts.chunk_bytes.min((size - pos) as usize);
            buf.resize(n, 0);
            let got = read_full_at(&file, &mut buf[..n], pos)?;
            if got == 0 {
                // The file shrank under us; `refresh` sorts it out.
                lock(&self.state).size = pos;
                break;
            }
            let data = &buf[..got];
            let mut cps = Vec::new();
            for i in memchr_iter(b'\n', data) {
                nl += 1;
                if nl % k == 0 {
                    cps.push(pos + i as u64 + 1);
                }
            }
            pos += got as u64;
            scanned += got;
            tail.extend_from_slice(&data[got.saturating_sub(TAIL_FINGERPRINT)..]);
            if tail.len() > TAIL_FINGERPRINT {
                tail.drain(..tail.len() - TAIL_FINGERPRINT);
            }
            {
                let mut s = lock(&self.state);
                s.newlines = nl;
                s.checkpoints.extend(cps);
                s.indexed_bytes = pos;
                s.last_nl = data[got - 1] == b'\n';
                s.tail = tail.clone();
            }
            if scanned >= budget_bytes {
                break;
            }
        }
        Ok(self.status())
    }

    /// Indexes the whole file. Stops early (returning the partial status) when `cancel` is set.
    pub fn index_all(&self, cancel: &AtomicBool) -> Result<IndexStatus> {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(self.status());
            }
            let st = self.index_step(self.opts.chunk_bytes)?;
            if st.done {
                return Ok(st);
            }
        }
    }

    fn ensure_indexed(&self, cancel: &AtomicBool) -> Result<IndexStatus> {
        let st = self.index_all(cancel)?;
        if st.done {
            Ok(st)
        } else {
            Err(cancelled())
        }
    }

    /// Picks up changes to the file. Growth (`tail -f`) only indexes the new part; a smaller or
    /// replaced file resets the index (`reset: true` in the result). At most one chunk is indexed
    /// here; keep calling `index_step` until `done`.
    pub fn refresh(&self) -> Result<IndexStatus> {
        let _g = lock(&self.index_lock);
        let file = File::open(&self.path)?;
        let new_size = file.metadata()?.len();
        let (indexed, tail) = {
            let s = lock(&self.state);
            (s.indexed_bytes, s.tail.clone())
        };
        let mut reset = new_size < indexed;
        if !reset && !tail.is_empty() {
            let mut check = vec![0u8; tail.len()];
            let got = read_full_at(&file, &mut check, indexed - tail.len() as u64)?;
            reset = got != tail.len() || check != tail;
        }
        {
            let mut s = lock(&self.state);
            if reset {
                *s = State::fresh(Arc::new(file), new_size, self.bom_len);
            } else {
                s.file = Arc::new(file);
                s.size = new_size;
            }
        }
        let mut st = self.index_step_locked(self.opts.chunk_bytes)?;
        st.reset = reset;
        Ok(st)
    }

    fn snap(&self, line: u64) -> Snap {
        let s = lock(&self.state);
        let k = self.opts.checkpoint_lines;
        let c = ((line / k) as usize).min(s.checkpoints.len() - 1);
        Snap {
            file: s.file.clone(),
            size: s.size,
            indexed_bytes: s.indexed_bytes,
            indexed_lines: s.lines(),
            cp_line: c as u64 * k,
            cp_off: s.checkpoints[c],
        }
    }

    /// Finds the start of `line`. With `unindexed`, scans past the indexed region up to the real end
    /// of the file (limited by `cap` bytes from the checkpoint when given).
    fn locate(
        &self,
        line: u64,
        unindexed: bool,
        cap: Option<u64>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Locate> {
        let s = self.snap(line);
        if !unindexed && line >= s.indexed_lines {
            return Ok(Locate::Beyond);
        }
        let limit = if unindexed {
            file_len(&s.file)?
        } else {
            s.indexed_bytes
        };
        let mut remaining = line - s.cp_line;
        let mut pos = s.cp_off;
        if remaining == 0 {
            return Ok(if pos < limit {
                Locate::Found(pos)
            } else {
                Locate::Beyond
            });
        }
        let block = self.io_block(true);
        let mut buf = vec![0u8; block];
        while pos < limit {
            let n = (limit - pos).min(block as u64) as usize;
            let got = read_full_at(&s.file, &mut buf[..n], pos)?;
            if got == 0 {
                break;
            }
            for i in memchr_iter(b'\n', &buf[..got]) {
                remaining -= 1;
                if remaining == 0 {
                    let st = pos + i as u64 + 1;
                    return Ok(if st < limit {
                        Locate::Found(st)
                    } else {
                        Locate::Beyond
                    });
                }
            }
            pos += got as u64;
            if cap.is_some_and(|c| pos - s.cp_off > c) {
                return Ok(Locate::Unreached);
            }
            if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                return Err(cancelled());
            }
        }
        Ok(Locate::Beyond)
    }

    /// Byte offset of the start of 0-based `line`, or `None` when that line is not (yet) indexed.
    pub fn line_offset(&self, line: u64) -> Result<Option<u64>> {
        Ok(match self.locate(line, false, None, None)? {
            Locate::Found(o) => Some(o),
            _ => None,
        })
    }

    fn decode_line<'a>(&self, bytes: &'a [u8], truncated: bool) -> Cow<'a, str> {
        decode_bytes(self.encoding, bytes, truncated)
    }

    /// Decoded lines `[first, first + count)`, each cut to `max_chars` UTF-16 units.
    pub fn read_lines(&self, first: u64, count: usize, max_chars: usize) -> Result<LinesChunk> {
        let total_lines = self.status().total_lines;
        let empty = |available: bool, eof: bool| LinesChunk {
            first,
            lines: Vec::new(),
            available,
            eof,
            total_lines,
        };
        let off = match self.locate(first, true, Some(UNINDEXED_SCAN_CAP), None)? {
            Locate::Found(o) => o,
            Locate::Beyond => return Ok(empty(false, true)),
            Locate::Unreached => return Ok(empty(false, false)),
        };
        let file = lock(&self.state).file.clone();
        let end = file_len(&file)?;
        let mut f = FwdLines::new(file, off, end, self.io_block(false));
        let cap = MAX_LINE_BYTES.min(max_chars.saturating_mul(4).saturating_add(8));
        let mut lines = Vec::with_capacity(count.min(4096));
        while lines.len() < count {
            let Some(r) = f.next_line(cap)? else { break };
            let text = self.decode_line(f.bytes(&r), r.truncated);
            let (cut_at, cut) = cut_units(&text, max_chars);
            lines.push(LineText {
                text: text[..cut_at].to_owned(),
                truncated: r.truncated || cut,
                offset: r.offset,
            });
        }
        let eof = lines.len() < count;
        Ok(LinesChunk {
            first,
            lines,
            available: true,
            eof,
            total_lines,
        })
    }

    fn encoded_len(&self, s: &str) -> u64 {
        match self.encoding {
            TextEncoding::Legacy(e) if !s.is_ascii() || e == encoding_rs::ISO_2022_JP => {
                encoding::encode(s, self.encoding).bytes.len() as u64
            }
            _ => s.len() as u64,
        }
    }

    fn make_hit(
        &self,
        text: &str,
        line: u64,
        line_off: u64,
        range: Range<usize>,
        wrapped: bool,
    ) -> Hit {
        let column = utf16_len(&text[..range.start]);
        Hit {
            line,
            column,
            length: utf16_len(&text[range.clone()]),
            byte_offset: line_off + self.encoded_len(&text[..range.start]),
            preview: preview(text, column),
            wrapped,
        }
    }

    /// Next (`Forward`: first match starting at or after `from`) or previous (`Backward`: last match
    /// starting strictly before `from`) match. Matching is per line; empty matches are ignored. Wraps
    /// around the file once (`wrapped: true`). A position past the end of the file counts as the end.
    /// Returns `Err` with [`is_cancelled`] true when `cancel` was set. Backward wrap-around first
    /// completes the line index. Only the first 4 MiB of a line are searched.
    pub fn search(
        &self,
        q: &LargeQuery,
        from: SearchPos,
        dir: Direction,
        cancel: &AtomicBool,
    ) -> Result<Option<Hit>> {
        let re = q.build()?;
        match dir {
            Direction::Forward => self.search_forward(&re, from, cancel),
            Direction::Backward => self.search_backward(&re, from, cancel),
        }
    }

    fn fwd_pass(
        &self,
        re: &Regex,
        file: &Arc<File>,
        p: FwdPass,
        cancel: &AtomicBool,
    ) -> Result<Option<Hit>> {
        let mut f = FwdLines::new(file.clone(), p.off, p.end, self.io_block(true));
        let mut line = p.line0;
        while let Some(r) = f.next_line(MAX_LINE_BYTES)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            if p.last_line.is_some_and(|l| line > l) {
                break;
            }
            let text = self.decode_line(f.bytes(&r), r.truncated);
            let min_col = if line == p.line0 { p.first_col } else { None };
            for m in line_matches(re, &text) {
                if min_col.is_some_and(|c| utf16_len(&text[..m.start()]) < c) {
                    continue;
                }
                return Ok(Some(self.make_hit(&text, line, r.offset, m.range(), false)));
            }
            line += 1;
        }
        Ok(None)
    }

    fn search_forward(
        &self,
        re: &Regex,
        from: SearchPos,
        cancel: &AtomicBool,
    ) -> Result<Option<Hit>> {
        let first = self.locate(from.line, true, None, Some(cancel))?;
        let file = lock(&self.state).file.clone();
        let end = file_len(&file)?;
        let mut last_line = None;
        if let Locate::Found(off) = first {
            let p = FwdPass {
                off,
                end,
                line0: from.line,
                first_col: Some(from.column),
                last_line: None,
            };
            if let Some(h) = self.fwd_pass(re, &file, p, cancel)? {
                return Ok(Some(h));
            }
            last_line = Some(from.line);
        }
        let p = FwdPass {
            off: self.bom_len,
            end,
            line0: 0,
            first_col: None,
            last_line,
        };
        Ok(self.fwd_pass(re, &file, p, cancel)?.map(|mut h| {
            h.wrapped = true;
            h
        }))
    }

    fn back_pass(
        &self,
        re: &Regex,
        file: &Arc<File>,
        boundary: u64,
        top: u64,
        stop: u64,
        cancel: &AtomicBool,
    ) -> Result<Option<Hit>> {
        let mut b = BackLines::new(file.clone(), self.bom_len, boundary, self.io_block(true))?;
        let mut line = top;
        while let Some(r) = b.prev_line(MAX_LINE_BYTES)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let text = self.decode_line(b.bytes(&r), r.truncated);
            if let Some(m) = line_matches(re, &text).last() {
                return Ok(Some(self.make_hit(&text, line, r.offset, m.range(), false)));
            }
            if line <= stop {
                break;
            }
            line -= 1;
        }
        Ok(None)
    }

    fn search_backward(
        &self,
        re: &Regex,
        from: SearchPos,
        cancel: &AtomicBool,
    ) -> Result<Option<Hit>> {
        let first = self.locate(from.line, true, None, Some(cancel))?;
        let file = lock(&self.state).file.clone();
        let mut stop = 0;
        let mut wrapped = false;
        if let Locate::Found(off) = first {
            let end = file_len(&file)?;
            let mut f = FwdLines::new(file.clone(), off, end, self.io_block(true));
            if let Some(r) = f.next_line(MAX_LINE_BYTES)? {
                let text = self.decode_line(f.bytes(&r), r.truncated);
                let last = line_matches(re, &text)
                    .take_while(|m| utf16_len(&text[..m.start()]) < from.column)
                    .last();
                if let Some(m) = last {
                    return Ok(Some(self.make_hit(&text, from.line, off, m.range(), false)));
                }
            }
            if from.line > 0 {
                if let Some(h) = self.back_pass(re, &file, off, from.line - 1, 0, cancel)? {
                    return Ok(Some(h));
                }
            }
            wrapped = true;
            stop = from.line;
        }
        let st = self.ensure_indexed(cancel)?;
        let total = st.total_lines.unwrap_or(0);
        if total == 0 {
            return Ok(None);
        }
        let s = self.snap(0);
        let hit = self.back_pass(re, &s.file, s.size, total - 1, stop.min(total - 1), cancel)?;
        Ok(hit.map(|mut h| {
            h.wrapped = wrapped;
            h
        }))
    }

    /// Counts the matches in the whole file (per line, empty matches ignored). `progress` receives
    /// the number of bytes scanned so far, about once per 1024 lines. Returns `Err` with
    /// [`is_cancelled`] true when `cancel` was set.
    pub fn count_matches(
        &self,
        q: &LargeQuery,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<u64> {
        let re = q.build()?;
        let file = lock(&self.state).file.clone();
        let end = file_len(&file)?;
        let mut f = FwdLines::new(file, self.bom_len, end, self.io_block(true));
        let mut total = 0u64;
        let mut lines = 0u32;
        while let Some(r) = f.next_line(MAX_LINE_BYTES)? {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let text = self.decode_line(f.bytes(&r), r.truncated);
            total += line_matches(&re, &text).count() as u64;
            lines = lines.wrapping_add(1);
            if lines.is_multiple_of(1024) {
                progress(f.line_off);
            }
        }
        progress(f.line_off);
        Ok(total)
    }
}

/// Decodes one line (no BOM handling: a U+FEFF inside a file is data).
fn decode_bytes(enc: TextEncoding, bytes: &[u8], truncated: bool) -> Cow<'_, str> {
    let mut text = match enc {
        TextEncoding::Legacy(e) => e.decode_without_bom_handling(bytes).0,
        _ => String::from_utf8_lossy(bytes),
    };
    // A cut in the middle of a character leaves one replacement character at the end.
    if truncated && text.ends_with('\u{FFFD}') {
        match &mut text {
            Cow::Borrowed(s) => *s = &s[..s.len() - '\u{FFFD}'.len_utf8()],
            Cow::Owned(s) => {
                s.pop();
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;

    static NO: AtomicBool = AtomicBool::new(false);

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 33) as usize
        }
        fn below(&mut self, n: usize) -> usize {
            self.next() % n
        }
    }

    fn write_tmp(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.txt");
        std::fs::write(&p, bytes).unwrap();
        (d, p)
    }

    fn opts(chunk: usize, cp: u64) -> IndexOptions {
        IndexOptions {
            checkpoint_lines: cp,
            chunk_bytes: chunk,
        }
    }

    fn open_idx(p: &Path, chunk: usize, cp: u64, enc: Option<TextEncoding>) -> LargeFile {
        let (lf, _) = LargeFile::open_with(p, opts(chunk, cp), enc).unwrap();
        lf.index_all(&NO).unwrap();
        lf
    }

    /// (offset, content without `\n` and a trailing `\r`) of every line, split the naive way.
    fn split_ref(raw: &[u8], bom: usize) -> Vec<(u64, Vec<u8>)> {
        let mut out = Vec::new();
        let mut st = bom;
        let push = |out: &mut Vec<(u64, Vec<u8>)>, st: usize, end: usize| {
            let mut l = &raw[st..end];
            if l.last() == Some(&b'\r') {
                l = &l[..l.len() - 1];
            }
            out.push((st as u64, l.to_vec()));
        };
        for (i, &b) in raw.iter().enumerate().skip(bom) {
            if b == b'\n' {
                push(&mut out, st, i);
                st = i + 1;
            }
        }
        if st < raw.len() {
            push(&mut out, st, raw.len());
        }
        out
    }

    fn ref_text(enc: TextEncoding, b: &[u8]) -> String {
        decode_bytes(enc, b, false).into_owned()
    }

    fn encs() -> Vec<(TextEncoding, usize)> {
        vec![
            (TextEncoding::Utf8, 0),
            (TextEncoding::Utf8Bom, 3),
            (TextEncoding::Windows1252, 0),
            (TextEncoding::Legacy(encoding_rs::SHIFT_JIS), 0),
        ]
    }

    fn gen_file(
        rng: &mut Lcg,
        enc: TextEncoding,
        lines: usize,
        eol: usize,
        trailing: bool,
    ) -> Vec<u8> {
        const V: &[&str] = &[
            "foo",
            "Bar",
            "foobar",
            "æøå",
            "日本語",
            "😀",
            "x",
            " ",
            "",
            "foo bar",
            "FOO",
            "a.b",
            "\t",
            "bar",
        ];
        let mut text = String::new();
        for i in 0..lines {
            for _ in 0..rng.below(6) {
                text.push_str(V[rng.below(V.len())]);
            }
            if i + 1 < lines || trailing {
                match eol {
                    0 => text.push('\n'),
                    1 => text.push_str("\r\n"),
                    2 => text.push_str(if rng.below(2) == 0 { "\n" } else { "\r\n" }),
                    _ => text.push_str(["\n", "\r\n", "\r\n\r", "\r"][rng.below(4)]),
                }
            }
        }
        encoding::encode(&text, enc).bytes
    }

    fn all_lines(lf: &LargeFile, max_chars: usize) -> Vec<LineText> {
        lf.read_lines(0, usize::MAX >> 4, max_chars).unwrap().lines
    }

    #[test]
    fn is_send_and_sync() {
        fn check<T: Send + Sync>() {}
        check::<LargeFile>();
    }

    #[test]
    fn open_reports_encoding_eol_and_size() {
        let (_d, p) = write_tmp(b"a\r\nb\r\nc");
        let (lf, info) = LargeFile::open(&p, IndexOptions::default()).unwrap();
        assert_eq!(info.size, 7);
        assert_eq!(info.encoding, TextEncoding::Utf8);
        assert_eq!(info.eol, Eol::Crlf);
        assert_eq!(info.bom_len, 0);
        assert_eq!(lf.encoding(), TextEncoding::Utf8);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["bomLen"], 0);
        assert_eq!(json["encoding"], "UTF-8");
    }

    #[test]
    fn bom_is_skipped_but_offsets_include_it() {
        let (_d, p) = write_tmp(b"\xEF\xBB\xBFab\ncd\n");
        let (lf, info) = LargeFile::open(&p, opts(4, 1)).unwrap();
        assert_eq!(info.encoding, TextEncoding::Utf8Bom);
        assert_eq!(info.bom_len, 3);
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.line_offset(0).unwrap(), Some(3));
        assert_eq!(lf.line_offset(1).unwrap(), Some(6));
        let c = lf.read_lines(0, 5, 100).unwrap();
        assert_eq!(c.lines[0].text, "ab");
        assert_eq!(c.lines[0].offset, 3);
        assert_eq!(c.lines.len(), 2);
    }

    #[test]
    fn empty_file() {
        let (_d, p) = write_tmp(b"");
        let lf = open_idx(&p, 7, 3, None);
        let st = lf.status();
        assert!(st.done);
        assert_eq!(st.total_lines, Some(0));
        assert_eq!(lf.line_offset(0).unwrap(), None);
        let c = lf.read_lines(0, 10, 100).unwrap();
        assert!(c.lines.is_empty() && c.eof && !c.available);
        let q = LargeQuery {
            pattern: "a".into(),
            regex: false,
            case_sensitive: true,
            whole_word: false,
        };
        assert_eq!(
            lf.search(
                &q,
                SearchPos { line: 0, column: 0 },
                Direction::Forward,
                &NO
            )
            .unwrap(),
            None
        );
        assert_eq!(
            lf.search(
                &q,
                SearchPos { line: 0, column: 0 },
                Direction::Backward,
                &NO
            )
            .unwrap(),
            None
        );
        assert_eq!(lf.count_matches(&q, &NO, &mut |_| {}).unwrap(), 0);
    }

    #[test]
    fn refuses_utf16_and_binary() {
        let le = encoding::encode("hello\nworld\n", TextEncoding::Utf16Le).bytes;
        let (_d, p) = write_tmp(&le);
        let e = LargeFile::open(&p, IndexOptions::default()).err().unwrap();
        assert!(e.to_string().contains("UTF-16"), "{e}");
        let be: Vec<u8> = "hello world"
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        let (_d2, p2) = write_tmp(&be);
        assert!(LargeFile::open(&p2, IndexOptions::default()).is_err());
        let (_d3, p3) = write_tmp(b"abc\0\0\0\0def\n\x01\x02");
        let e = LargeFile::open(&p3, IndexOptions::default()).err().unwrap();
        assert!(e.to_string().contains("binary"), "{e}");
    }

    #[test]
    fn line_counts_match_reference_on_random_files() {
        let mut rng = Lcg(7);
        for (enc, bom) in encs() {
            for eol in 0..4 {
                for trailing in [true, false] {
                    let lines = rng.below(40);
                    let raw = gen_file(&mut rng, enc, lines, eol, trailing);
                    let (_d, p) = write_tmp(&raw);
                    let want = split_ref(&raw, bom);
                    for (chunk, cp) in [(1, 1), (7, 3), (7, 1), (13, 4), (1000, 3)] {
                        let lf = open_idx(&p, chunk, cp, Some(enc));
                        let st = lf.status();
                        assert!(st.done);
                        assert_eq!(
                            st.total_lines,
                            Some(want.len() as u64),
                            "{enc:?} {eol} {chunk}"
                        );
                        assert_eq!(st.indexed_lines, want.len() as u64);
                        assert_eq!(st.indexed_bytes, raw.len() as u64);
                        let stored = lock(&lf.state).checkpoints.len() as u64;
                        let expect =
                            1 + (raw[bom..].iter().filter(|b| **b == b'\n').count() as u64) / cp;
                        assert_eq!(stored, expect);
                    }
                }
            }
        }
    }

    #[test]
    fn newline_edge_cases() {
        for (raw, n) in [
            (&b"\n\n\n"[..], 3u64),
            (b"a", 1),
            (b"a\n", 1),
            (b"a\n\n", 2),
            (b"\n", 1),
            (b"a\r\n", 1),
            (b"a\r", 1),
            (b"a\nb", 2),
        ] {
            let (_d, p) = write_tmp(raw);
            let lf = open_idx(&p, 2, 2, None);
            assert_eq!(lf.status().total_lines, Some(n), "{raw:?}");
            assert_eq!(all_lines(&lf, 100).len() as u64, n, "{raw:?}");
        }
    }

    #[test]
    fn read_lines_windows_match_reference() {
        let mut rng = Lcg(99);
        for (enc, bom) in encs() {
            for eol in 0..4 {
                let raw = gen_file(&mut rng, enc, 37, eol, eol % 2 == 0);
                let (_d, p) = write_tmp(&raw);
                let want = split_ref(&raw, bom);
                for (chunk, cp) in [(1, 1), (7, 3), (64, 5)] {
                    let lf = open_idx(&p, chunk, cp, Some(enc));
                    for first in [0usize, 1, 2, 5, 11, 36, 37, 40] {
                        for count in [0usize, 1, 3, 100] {
                            let c = lf.read_lines(first as u64, count, 10_000).unwrap();
                            let exp: Vec<_> = want.iter().skip(first).take(count).collect();
                            assert_eq!(c.lines.len(), exp.len(), "{enc:?} {first} {count}");
                            for (got, (off, bytes)) in c.lines.iter().zip(exp) {
                                assert_eq!(got.text, ref_text(enc, bytes));
                                assert_eq!(got.offset, *off);
                                assert!(!got.truncated);
                            }
                            assert_eq!(c.available, first < want.len());
                            assert_eq!(c.eof, c.lines.len() < count || !c.available);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn crlf_is_stripped_and_lone_cr_is_kept() {
        let (_d, p) = write_tmp(b"one\r\ntwo\rthree\r\n\r\nfour\r");
        let lf = open_idx(&p, 3, 2, None);
        let t: Vec<String> = all_lines(&lf, 100).into_iter().map(|l| l.text).collect();
        assert_eq!(t, ["one", "two\rthree", "", "four"]);
    }

    #[test]
    fn utf8_sequences_split_across_chunks() {
        let text = "æøå日本語😀\n😀😀😀\n日\n";
        let (_d, p) = write_tmp(text.as_bytes());
        for chunk in 1..9 {
            let lf = open_idx(&p, chunk, 1, None);
            let t: Vec<String> = all_lines(&lf, 100).into_iter().map(|l| l.text).collect();
            assert_eq!(t, ["æøå日本語😀", "😀😀😀", "日"], "chunk {chunk}");
        }
    }

    #[test]
    fn invalid_bytes_decode_lossily() {
        let (_d, p) = write_tmp(b"a\xFFb\nok\n\xE6\xF8\n");
        let lf = open_idx(&p, 3, 2, Some(TextEncoding::Utf8));
        let l = all_lines(&lf, 100);
        assert_eq!(l[0].text, "a\u{FFFD}b");
        assert_eq!(l[1].text, "ok");
        assert_eq!(l[2].text, "\u{FFFD}\u{FFFD}");
        let lf = open_idx(&p, 3, 2, Some(TextEncoding::Windows1252));
        assert_eq!(all_lines(&lf, 100)[2].text, "æø");
    }

    #[test]
    fn detects_a_code_page_from_the_head() {
        let raw = encoding::encode(
            "blåbærsyltetøy med litt mer tekst i fila\nlinje 2\n",
            TextEncoding::Windows1252,
        )
        .bytes;
        let (_d, p) = write_tmp(&raw);
        let (lf, info) = LargeFile::open(&p, opts(8, 2)).unwrap();
        assert_eq!(info.encoding, TextEncoding::Windows1252);
        lf.index_all(&NO).unwrap();
        assert_eq!(
            all_lines(&lf, 100)[0].text,
            "blåbærsyltetøy med litt mer tekst i fila"
        );
    }

    #[test]
    fn line_offset_round_trips() {
        let mut rng = Lcg(5);
        for (enc, bom) in encs() {
            let raw = gen_file(&mut rng, enc, 45, 2, false);
            let (_d, p) = write_tmp(&raw);
            let want = split_ref(&raw, bom);
            for (chunk, cp) in [(5, 3), (64, 1), (1000, 7)] {
                let lf = open_idx(&p, chunk, cp, Some(enc));
                for (i, (off, _)) in want.iter().enumerate() {
                    assert_eq!(
                        lf.line_offset(i as u64).unwrap(),
                        Some(*off),
                        "{enc:?} line {i}"
                    );
                }
                assert_eq!(lf.line_offset(want.len() as u64).unwrap(), None);
                assert_eq!(lf.line_offset(u64::MAX).unwrap(), None);
            }
        }
    }

    #[test]
    fn index_step_is_incremental() {
        let raw: Vec<u8> = (0..50)
            .flat_map(|i| format!("line {i}\n").into_bytes())
            .collect();
        let (_d, p) = write_tmp(&raw);
        let (lf, _) = LargeFile::open(&p, opts(20, 4)).unwrap();
        assert_eq!(lf.status().indexed_bytes, 0);
        assert!(!lf.status().done);
        let a = lf.index_step(1).unwrap();
        assert_eq!(a.indexed_bytes, 20);
        assert!(!a.done && a.total_lines.is_none());
        let b = lf.index_step(40).unwrap();
        assert_eq!(b.indexed_bytes, 60);
        assert!(b.indexed_lines > a.indexed_lines);
        // Lines inside the indexed region are addressable, later ones are not yet.
        let known = b.indexed_lines;
        assert!(lf.line_offset(known - 1).unwrap().is_some());
        assert_eq!(lf.line_offset(known + 5).unwrap(), None);
        let mut last = b.indexed_bytes;
        loop {
            let s = lf.index_step(1).unwrap();
            assert!(s.indexed_bytes > last || s.done);
            last = s.indexed_bytes;
            if s.done {
                assert_eq!(s.total_lines, Some(50));
                break;
            }
        }
        // Stepping a finished index does nothing.
        assert_eq!(lf.index_step(100).unwrap().indexed_bytes, raw.len() as u64);
    }

    #[test]
    fn read_lines_works_before_indexing_finishes() {
        let raw: Vec<u8> = (0..200)
            .flat_map(|i| format!("row {i}\r\n").into_bytes())
            .collect();
        let (_d, p) = write_tmp(&raw);
        let (lf, _) = LargeFile::open(&p, opts(16, 5)).unwrap();
        assert_eq!(lf.line_offset(7).unwrap(), None);
        let c = lf.read_lines(150, 3, 100).unwrap();
        assert!(c.available);
        assert_eq!(c.total_lines, None);
        let t: Vec<_> = c.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(t, ["row 150", "row 151", "row 152"]);
        let past = lf.read_lines(5000, 3, 100).unwrap();
        assert!(!past.available && past.eof && past.lines.is_empty());
        lf.index_step(32).unwrap();
        assert_eq!(lf.read_lines(150, 1, 100).unwrap().lines[0].text, "row 150");
    }

    #[test]
    fn index_all_stops_when_cancelled() {
        let raw = "x\n".repeat(1000);
        let (_d, p) = write_tmp(raw.as_bytes());
        let (lf, _) = LargeFile::open(&p, opts(8, 4)).unwrap();
        let cancel = AtomicBool::new(true);
        let st = lf.index_all(&cancel).unwrap();
        assert!(!st.done);
        assert_eq!(st.indexed_bytes, 0);
        assert!(lf.index_all(&NO).unwrap().done);
    }

    #[test]
    fn refresh_picks_up_appended_lines() {
        let (_d, p) = write_tmp(b"a\nb\n");
        let lf = open_idx(&p, 5, 2, None);
        assert_eq!(lf.status().total_lines, Some(2));
        let unchanged = lf.refresh().unwrap();
        assert!(!unchanged.reset && unchanged.done);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(b"c\nd\ne\n")
            .unwrap();
        let st = lf.refresh().unwrap();
        assert!(!st.reset);
        assert_eq!(st.size, 10);
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(5));
        assert_eq!(lf.read_lines(2, 9, 10).unwrap().lines[2].text, "e");
        assert_eq!(lf.line_offset(4).unwrap(), Some(8));
    }

    #[test]
    fn refresh_partial_line_then_completion() {
        let (_d, p) = write_tmp(b"abc\nde");
        let lf = open_idx(&p, 4, 1, None);
        assert_eq!(lf.status().total_lines, Some(2));
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"f").unwrap();
        assert!(!lf.refresh().unwrap().reset);
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(2));
        assert_eq!(lf.read_lines(1, 1, 10).unwrap().lines[0].text, "def");
        f.write_all(b"\r\nghi").unwrap();
        lf.refresh().unwrap();
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(3));
        let t: Vec<_> = all_lines(&lf, 10).into_iter().map(|l| l.text).collect();
        assert_eq!(t, ["abc", "def", "ghi"]);
        f.write_all(b"\n").unwrap();
        lf.refresh().unwrap();
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(3));
    }

    #[test]
    fn refresh_after_truncation_and_replacement_resets() {
        let (_d, p) = write_tmp(b"one\ntwo\nthree\nfour\n");
        let lf = open_idx(&p, 6, 2, None);
        std::fs::write(&p, b"x\ny\n").unwrap();
        let st = lf.refresh().unwrap();
        assert!(st.reset);
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(2));
        assert_eq!(all_lines(&lf, 10)[1].text, "y");
        assert!(!lf.refresh().unwrap().reset);
        // Replaced by a larger file with different content.
        std::fs::write(&p, b"p\nq\nr\ns\nt\nu\n").unwrap();
        assert!(lf.refresh().unwrap().reset);
        lf.index_all(&NO).unwrap();
        assert_eq!(lf.status().total_lines, Some(6));
        // Truncated to nothing.
        std::fs::write(&p, b"").unwrap();
        let st = lf.refresh().unwrap();
        assert!(st.reset && st.done);
        assert_eq!(st.total_lines, Some(0));
    }

    #[test]
    fn long_lines_are_cut_on_character_boundaries() {
        let line = "😀".repeat(50);
        let (_d, p) = write_tmp(format!("{line}\nshort\n日本語日本語\n").as_bytes());
        let lf = open_idx(&p, 9, 2, None);
        for max in [0usize, 1, 2, 3, 7, 10, 99, 100, 101] {
            let c = lf.read_lines(0, 3, max).unwrap();
            let l = &c.lines[0];
            let units = l.text.encode_utf16().count();
            assert!(units <= max, "{max}: {units}");
            assert_eq!(units, max & !1, "emoji take two units, never half of one");
            assert_eq!(l.truncated, max < 100);
            assert!(!c.lines[1].truncated || max < 5);
        }
        let c = lf.read_lines(2, 1, 4).unwrap();
        assert_eq!(c.lines[0].text, "日本語日");
        assert!(c.lines[0].truncated);
    }

    #[test]
    fn a_single_huge_line_is_never_loaded_whole() {
        let mut raw = vec![b'x'; 5 * 1024 * 1024];
        raw.extend_from_slice(b"\ntail\n");
        let (_d, p) = write_tmp(&raw);
        let lf = open_idx(&p, 1 << 20, 10, None);
        assert_eq!(lf.status().total_lines, Some(2));
        let c = lf.read_lines(0, 2, 50).unwrap();
        assert_eq!(c.lines[0].text.len(), 50);
        assert!(c.lines[0].truncated);
        assert_eq!(c.lines[1].text, "tail");
        assert_eq!(c.lines[1].offset, 5 * 1024 * 1024 + 1);
        let c = lf.read_lines(0, 1, 100_000_000).unwrap();
        assert_eq!(c.lines[0].text.len(), MAX_LINE_BYTES);
        assert!(c.lines[0].truncated);
        // Backward iteration over it yields the same capped head.
        let q = LargeQuery {
            pattern: "tail".into(),
            regex: false,
            case_sensitive: true,
            whole_word: false,
        };
        let h = lf
            .search(
                &q,
                SearchPos { line: 1, column: 0 },
                Direction::Backward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!((h.line, h.wrapped), (1, true));
        let q2 = LargeQuery {
            pattern: "xxxx".into(),
            ..q
        };
        let h = lf
            .search(
                &q2,
                SearchPos { line: 1, column: 0 },
                Direction::Backward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!((h.line, h.column, h.wrapped), (0, 4_194_300, false));
        assert!(h.preview.len() <= PREVIEW_UNITS);
    }

    fn q(pattern: &str, regex: bool, case: bool, word: bool) -> LargeQuery {
        LargeQuery {
            pattern: pattern.into(),
            regex,
            case_sensitive: case,
            whole_word: word,
        }
    }

    /// (line, column, length) of every non-empty match, in order.
    fn ref_matches(
        raw: &[u8],
        bom: usize,
        enc: TextEncoding,
        qu: &LargeQuery,
    ) -> Vec<(u64, usize, usize)> {
        let re = qu.build().unwrap();
        let mut out = Vec::new();
        for (i, (_, b)) in split_ref(raw, bom).iter().enumerate() {
            let t = ref_text(enc, b);
            for m in re.find_iter(&t).filter(|m| !m.is_empty()) {
                out.push((i as u64, utf16_len(&t[..m.start()]), utf16_len(m.as_str())));
            }
        }
        out
    }

    fn queries() -> Vec<LargeQuery> {
        vec![
            q("foo", false, true, false),
            q("foo", false, false, false),
            q("foo", false, false, true),
            q("o+", true, true, false),
            q("日本", false, true, false),
            q("^f", true, true, false),
            q("bar$", true, false, false),
            q("a.b", false, true, false),
            q("😀", false, true, false),
        ]
    }

    #[test]
    fn search_matches_reference_in_both_directions() {
        let mut rng = Lcg(2024);
        for (enc, bom) in encs() {
            let raw = gen_file(&mut rng, enc, 22, 3, false);
            let (_d, p) = write_tmp(&raw);
            for chunk in [3usize, 50] {
                let lf = open_idx(&p, chunk, 4, Some(enc));
                for qu in queries() {
                    let all = ref_matches(&raw, bom, enc, &qu);
                    for line in [0u64, 1, 2, 7, 15, 21, 22, 30] {
                        for col in [0usize, 2, 9] {
                            let pos = (line, col);
                            let fwd = all.iter().find(|m| (m.0, m.1) >= pos).map(|m| (*m, false));
                            let fwd = fwd.or(all.first().map(|m| (*m, true)));
                            let got = lf
                                .search(
                                    &qu,
                                    SearchPos { line, column: col },
                                    Direction::Forward,
                                    &NO,
                                )
                                .unwrap();
                            let got = got.map(|h| ((h.line, h.column, h.length), h.wrapped));
                            assert_eq!(got, fwd, "fwd {enc:?} {qu:?} {pos:?} chunk {chunk}");
                            let bwd = all
                                .iter()
                                .rev()
                                .find(|m| (m.0, m.1) < pos)
                                .map(|m| (*m, false));
                            let bwd = bwd.or(all.last().map(|m| (*m, true)));
                            let got = lf
                                .search(
                                    &qu,
                                    SearchPos { line, column: col },
                                    Direction::Backward,
                                    &NO,
                                )
                                .unwrap();
                            let got = got.map(|h| ((h.line, h.column, h.length), h.wrapped));
                            assert_eq!(got, bwd, "bwd {enc:?} {qu:?} {pos:?} chunk {chunk}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn search_walks_every_match_in_order_and_wraps_once() {
        let text = "foo\nxfoo foo\n\nbarfoo\r\nfoo";
        let (_d, p) = write_tmp(text.as_bytes());
        let lf = open_idx(&p, 4, 2, None);
        let qu = q("foo", false, true, false);
        let mut pos = SearchPos { line: 0, column: 0 };
        let mut seen = Vec::new();
        for _ in 0..6 {
            let h = lf
                .search(&qu, pos, Direction::Forward, &NO)
                .unwrap()
                .unwrap();
            seen.push((h.line, h.column, h.wrapped));
            pos = SearchPos {
                line: h.line,
                column: h.column + h.length,
            };
        }
        assert_eq!(
            seen,
            [
                (0, 0, false),
                (1, 1, false),
                (1, 5, false),
                (3, 3, false),
                (4, 0, false),
                (0, 0, true)
            ]
        );
        let mut seen = Vec::new();
        let mut pos = SearchPos { line: 4, column: 3 };
        for _ in 0..6 {
            let h = lf
                .search(&qu, pos, Direction::Backward, &NO)
                .unwrap()
                .unwrap();
            seen.push((h.line, h.column, h.wrapped));
            pos = SearchPos {
                line: h.line,
                column: h.column,
            };
        }
        assert_eq!(
            seen,
            [
                (4, 0, false),
                (3, 3, false),
                (1, 5, false),
                (1, 1, false),
                (0, 0, false),
                (4, 0, true)
            ]
        );
    }

    #[test]
    fn search_hits_first_and_last_lines_and_chunk_edges() {
        let text = "needle at start\nmiddle\nlast needle";
        let (_d, p) = write_tmp(text.as_bytes());
        for chunk in 1..12 {
            let lf = open_idx(&p, chunk, 1, None);
            let qu = q("needle", false, true, false);
            let h = lf
                .search(
                    &qu,
                    SearchPos { line: 0, column: 0 },
                    Direction::Forward,
                    &NO,
                )
                .unwrap()
                .unwrap();
            assert_eq!((h.line, h.column, h.length, h.byte_offset), (0, 0, 6, 0));
            let h = lf
                .search(
                    &qu,
                    SearchPos { line: 0, column: 1 },
                    Direction::Forward,
                    &NO,
                )
                .unwrap()
                .unwrap();
            assert_eq!((h.line, h.column, h.wrapped), (2, 5, false));
            assert_eq!(h.preview, "last needle");
            assert_eq!(h.byte_offset, text.len() as u64 - 6);
            let h = lf
                .search(
                    &qu,
                    SearchPos { line: 2, column: 5 },
                    Direction::Backward,
                    &NO,
                )
                .unwrap()
                .unwrap();
            assert_eq!((h.line, h.column, h.wrapped), (0, 0, false));
            let h = lf
                .search(
                    &qu,
                    SearchPos { line: 0, column: 0 },
                    Direction::Backward,
                    &NO,
                )
                .unwrap()
                .unwrap();
            assert_eq!((h.line, h.column, h.wrapped), (2, 5, true));
        }
    }

    #[test]
    fn search_options_case_word_and_regex() {
        let (_d, p) = write_tmp(b"Foo food FOO\nfoo-bar\n");
        let lf = open_idx(&p, 6, 1, None);
        let at = SearchPos { line: 0, column: 0 };
        let find =
            |qu: &LargeQuery, p: SearchPos| lf.search(qu, p, Direction::Forward, &NO).unwrap();
        let h = find(&q("foo", false, true, false), at).unwrap();
        assert_eq!((h.line, h.column), (0, 4));
        assert_eq!(find(&q("foo", false, false, false), at).unwrap().column, 0);
        let h = find(
            &q("foo", false, false, true),
            SearchPos { line: 0, column: 1 },
        )
        .unwrap();
        assert_eq!((h.line, h.column), (0, 9));
        let h = find(&q(r"fo+d", true, true, false), at).unwrap();
        assert_eq!((h.column, h.length), (4, 4));
        assert_eq!(find(&q("nope", false, true, false), at), None);
        assert!(matches!(
            lf.search(&q("", false, true, false), at, Direction::Forward, &NO),
            Err(Error::Pattern(_))
        ));
        assert!(matches!(
            lf.search(&q("(", true, true, false), at, Direction::Forward, &NO),
            Err(Error::Pattern(_))
        ));
    }

    #[test]
    fn hit_offsets_point_at_the_match_in_the_raw_bytes() {
        let mut rng = Lcg(11);
        for (enc, _) in encs() {
            let raw = gen_file(&mut rng, enc, 30, 1, true);
            let (_d, p) = write_tmp(&raw);
            let lf = open_idx(&p, 16, 3, Some(enc));
            let qu = q("foo", false, true, false);
            let mut pos = SearchPos { line: 0, column: 0 };
            let mut n = 0;
            loop {
                let h = lf.search(&qu, pos, Direction::Forward, &NO).unwrap();
                let Some(h) = h else { break };
                if h.wrapped {
                    break;
                }
                assert_eq!(
                    &raw[h.byte_offset as usize..h.byte_offset as usize + 3],
                    b"foo",
                    "{enc:?}"
                );
                n += 1;
                pos = SearchPos {
                    line: h.line,
                    column: h.column + h.length,
                };
            }
            assert!(n > 0);
        }
    }

    #[test]
    fn columns_are_utf16_units() {
        let (_d, p) = write_tmp("😀😀 x 日本 x\n".as_bytes());
        let lf = open_idx(&p, 5, 1, None);
        let h = lf
            .search(
                &q("x", false, true, false),
                SearchPos { line: 0, column: 0 },
                Direction::Forward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!(h.column, 5);
        let h = lf
            .search(
                &q("😀", false, true, false),
                SearchPos { line: 0, column: 1 },
                Direction::Forward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!((h.column, h.length), (2, 2));
        let h = lf
            .search(
                &q("x", false, true, false),
                SearchPos { line: 0, column: 9 },
                Direction::Backward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!(h.column, 5);
    }

    #[test]
    fn count_matches_agrees_with_reference() {
        let mut rng = Lcg(31);
        for (enc, bom) in encs() {
            let raw = gen_file(&mut rng, enc, 60, 3, true);
            let (_d, p) = write_tmp(&raw);
            let lf = open_idx(&p, 11, 5, Some(enc));
            for qu in queries() {
                let mut last = 0;
                let n = lf
                    .count_matches(&qu, &NO, &mut |b| {
                        assert!(b >= last);
                        last = b;
                    })
                    .unwrap();
                assert_eq!(
                    n,
                    ref_matches(&raw, bom, enc, &qu).len() as u64,
                    "{enc:?} {qu:?}"
                );
                assert_eq!(last, raw.len() as u64);
            }
        }
    }

    #[test]
    fn cancel_stops_count_and_search() {
        let raw = "foo\n".repeat(5000);
        let (_d, p) = write_tmp(raw.as_bytes());
        let lf = open_idx(&p, 64, 10, None);
        let cancel = AtomicBool::new(false);
        let qu = q("foo", false, true, false);
        let mut calls = 0;
        let r = lf.count_matches(&qu, &cancel, &mut |_| {
            calls += 1;
            if calls == 2 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(is_cancelled(&r.unwrap_err()));
        assert!(calls < 10);
        let r = lf.search(
            &qu,
            SearchPos { line: 0, column: 0 },
            Direction::Forward,
            &cancel,
        );
        assert!(is_cancelled(&r.unwrap_err()));
        let r = lf.search(
            &qu,
            SearchPos { line: 3, column: 0 },
            Direction::Backward,
            &cancel,
        );
        assert!(is_cancelled(&r.unwrap_err()));
        cancel.store(false, Ordering::Relaxed);
        assert_eq!(lf.count_matches(&qu, &cancel, &mut |_| {}).unwrap(), 5000);
    }

    #[test]
    fn backward_wrap_completes_the_index_first() {
        let raw = "a\n".repeat(300) + "needle\nz\n";
        let (_d, p) = write_tmp(raw.as_bytes());
        let (lf, _) = LargeFile::open(&p, opts(32, 5)).unwrap();
        let h = lf
            .search(
                &q("needle", false, true, false),
                SearchPos { line: 0, column: 0 },
                Direction::Backward,
                &NO,
            )
            .unwrap()
            .unwrap();
        assert_eq!((h.line, h.wrapped), (300, true));
        assert!(lf.status().done);
    }

    #[test]
    fn readers_work_while_a_thread_indexes() {
        let raw: Vec<u8> = (0..3000)
            .flat_map(|i| format!("entry number {i}\n").into_bytes())
            .collect();
        let (_d, p) = write_tmp(&raw);
        let (lf, _) = LargeFile::open(&p, opts(256, 10)).unwrap();
        let lf = Arc::new(lf);
        let worker = {
            let lf = lf.clone();
            std::thread::spawn(move || lf.index_all(&NO).unwrap())
        };
        let mut rng = Lcg(3);
        for _ in 0..200 {
            let n = rng.below(3000);
            let c = lf.read_lines(n as u64, 2, 100).unwrap();
            assert_eq!(c.lines[0].text, format!("entry number {n}"));
            if let Some(off) = lf.line_offset(n as u64).unwrap() {
                assert_eq!(c.lines[0].offset, off);
            }
        }
        assert!(worker.join().unwrap().done);
        assert_eq!(lf.status().total_lines, Some(3000));
    }

    #[test]
    fn serde_shapes_are_camel_case() {
        let (_d, p) = write_tmp(b"abc\n");
        let lf = open_idx(&p, 4, 1, None);
        let st = serde_json::to_value(lf.status()).unwrap();
        assert_eq!(st["indexedBytes"], 4);
        assert_eq!(st["totalLines"], 1);
        assert_eq!(st["reset"], false);
        let c = serde_json::to_value(lf.read_lines(0, 1, 10).unwrap()).unwrap();
        assert_eq!(c["lines"][0]["text"], "abc");
        assert_eq!(c["totalLines"], 1);
        let qu: LargeQuery = serde_json::from_str(
            r#"{"pattern":"a","regex":false,"caseSensitive":true,"wholeWord":false}"#,
        )
        .unwrap();
        let pos: SearchPos = serde_json::from_str(r#"{"line":0,"column":0}"#).unwrap();
        let h = lf
            .search(&qu, pos, Direction::Forward, &NO)
            .unwrap()
            .unwrap();
        let j = serde_json::to_value(&h).unwrap();
        assert_eq!(j["byteOffset"], 0);
        assert_eq!(
            serde_json::from_str::<Direction>("\"backward\"").unwrap(),
            Direction::Backward
        );
        let o: IndexOptions = serde_json::from_str(r#"{"chunkBytes":5}"#).unwrap();
        assert_eq!((o.checkpoint_lines, o.chunk_bytes), (1000, 5));
    }

    /// Run with: cargo test -p nimble-core --release -- --ignored --nocapture largefile
    #[test]
    #[ignore]
    fn benchmark_one_gigabyte() {
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        let target: u64 = 1 << 30;
        let t = Instant::now();
        {
            let mut w = io::BufWriter::with_capacity(1 << 20, File::create(&path).unwrap());
            let mut written = 0u64;
            let mut i = 0u64;
            while written < target {
                let needle = if i % 2_000_003 == 1_999_999 {
                    " NEEDLE"
                } else {
                    ""
                };
                let line = format!(
                    "2024-05-17 12:{:02}:{:02}.{:03} INFO  worker-{} request id={:08x} handled in {}ms path=/api/v1/items/{}{needle}\n",
                    (i / 60) % 60, i % 60, i % 1000, i % 16, i.wrapping_mul(2654435761), i % 977, i % 10007
                );
                w.write_all(line.as_bytes()).unwrap();
                written += line.len() as u64;
                i += 1;
            }
            w.flush().unwrap();
        }
        println!("generated {} MB in {:?}", target >> 20, t.elapsed());

        let t = Instant::now();
        let (lf, info) = LargeFile::open(&path, IndexOptions::default()).unwrap();
        println!(
            "open: {:?} ({} bytes, {})",
            t.elapsed(),
            info.size,
            info.encoding.label()
        );
        let t = Instant::now();
        let c = lf.read_lines(0, 50, 200).unwrap();
        println!(
            "first 50 lines before indexing: {:?} ({} lines)",
            t.elapsed(),
            c.lines.len()
        );

        let t = Instant::now();
        let st = lf.index_step(64 << 20).unwrap();
        println!(
            "first 64 MiB step: {:?} ({} lines)",
            t.elapsed(),
            st.indexed_lines
        );
        let t = Instant::now();
        let st = lf.index_all(&NO).unwrap();
        println!(
            "index rest: {:?}, total lines {:?}, checkpoints {}",
            t.elapsed(),
            st.total_lines,
            lock(&lf.state).checkpoints.len()
        );

        let total = st.total_lines.unwrap();
        let mut rng = Lcg(1);
        let t = Instant::now();
        for _ in 0..1000 {
            let n = (rng.next() as u64 * 7919) % (total - 60);
            let c = lf.read_lines(n, 50, 200).unwrap();
            assert_eq!(c.lines.len(), 50);
        }
        println!("1000 random 50-line reads: {:?} total", t.elapsed());

        let qu = q("NEEDLE", false, true, false);
        let t = Instant::now();
        let h = lf
            .search(
                &qu,
                SearchPos { line: 0, column: 0 },
                Direction::Forward,
                &NO,
            )
            .unwrap()
            .unwrap();
        println!(
            "search forward from start -> line {} in {:?}",
            h.line,
            t.elapsed()
        );
        let t = Instant::now();
        let h2 = lf
            .search(
                &qu,
                SearchPos {
                    line: h.line,
                    column: h.column + 6,
                },
                Direction::Forward,
                &NO,
            )
            .unwrap()
            .unwrap();
        println!("search next -> line {} in {:?}", h2.line, t.elapsed());
        let t = Instant::now();
        let h3 = lf
            .search(
                &qu,
                SearchPos {
                    line: total - 1,
                    column: 0,
                },
                Direction::Backward,
                &NO,
            )
            .unwrap()
            .unwrap();
        println!(
            "search backward from end -> line {} in {:?}",
            h3.line,
            t.elapsed()
        );
        let t = Instant::now();
        let n = lf.count_matches(&qu, &NO, &mut |_| {}).unwrap();
        println!("count NEEDLE: {n} in {:?}", t.elapsed());
        let t = Instant::now();
        let re = q(r"id=0000[0-9a-f]+ handled in 9\d\dms", true, true, false);
        let n = lf.count_matches(&re, &NO, &mut |_| {}).unwrap();
        println!("count regex: {n} in {:?}", t.elapsed());
        drop(lf);
        drop(dir);
    }
}

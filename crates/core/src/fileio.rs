//! Reading and writing text files with encoding and line-ending awareness.

use crate::encoding::{self, TextEncoding};
use crate::eol::{self, Eol};
use crate::{Error, Result};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Files above this size are refused for now; chunked viewing of huge files is on the roadmap.
pub const MAX_EDITABLE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub text: String,
    pub encoding: TextEncoding,
    pub eol: Eol,
    pub lossy: bool,
    pub mtime_ms: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: i64,
    /// Some characters could not be represented in the chosen encoding.
    pub lossy: bool,
}

pub fn mtime_ms(path: &Path) -> Option<i64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(match m.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    })
}

/// True when the bytes look like a binary file (NUL bytes that do not belong to UTF-16 text).
pub fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    if !sample.contains(&0) {
        return false;
    }
    !matches!(
        encoding::detect_sample(sample),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be
    )
}

/// Refuses files too big to load whole into the editor; they belong in the large-file viewer.
fn check_editable_size(path: &Path, len: u64) -> Result<()> {
    if len > MAX_EDITABLE_BYTES {
        return Err(Error::Msg(format!(
            "{} is too large to edit ({} MB, limit {} MB)",
            path.display(),
            len / 1_048_576,
            MAX_EDITABLE_BYTES / 1_048_576
        )));
    }
    Ok(())
}

/// Reads `path`. `default_eol` is used when the file has no line break at all.
pub fn read(path: &Path, default_eol: Eol) -> Result<OpenedFile> {
    let meta = std::fs::metadata(path)?;
    check_editable_size(path, meta.len())?;
    let bytes = std::fs::read(path)?;
    if looks_binary(&bytes) {
        return Err(Error::Msg(format!(
            "{} looks like a binary file",
            path.display()
        )));
    }
    let d = encoding::decode(&bytes);
    Ok(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        text: d.text,
        encoding: d.encoding,
        eol: d.eol.unwrap_or(default_eol),
        lossy: d.lossy,
        mtime_ms: mtime_ms(path).unwrap_or(0),
        size: meta.len(),
    })
}

/// Re-decodes a file with an explicit encoding (the "Reopen with encoding" action).
/// Files above [`MAX_EDITABLE_BYTES`] are refused like in [`read`].
pub fn read_as(path: &Path, enc: TextEncoding, default_eol: Eol) -> Result<OpenedFile> {
    check_editable_size(path, std::fs::metadata(path)?.len())?;
    let bytes = std::fs::read(path)?;
    let (text, lossy) = encoding::decode_as(&bytes, enc);
    Ok(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        eol: eol::detect(&text).unwrap_or(default_eol),
        text,
        encoding: enc,
        lossy,
        mtime_ms: mtime_ms(path).unwrap_or(0),
        size: bytes.len() as u64,
    })
}

/// Writes `text` (any line endings) to `path` as `enc` with `eol` line breaks.
/// The write goes through a temporary file in the same directory so a crash never truncates the original.
/// Characters the encoding cannot represent are replaced (reported in `WriteResult::lossy`).
pub fn write(path: &Path, text: &str, enc: TextEncoding, eol: Eol) -> Result<WriteResult> {
    write_checked(path, text, enc, eol, None, true)
}

/// Like [`write`], but refuses with [`Error::Conflict`] when the file exists and its modification
/// time is not `expected_mtime_ms` (it changed on disk after the editor read it).
/// `None` skips the check: new files, "Save As" and a confirmed overwrite.
/// Without `allow_lossy`, text the encoding cannot represent is refused with [`Error::Lossy`]
/// before anything is written.
pub fn write_checked(
    path: &Path,
    text: &str,
    enc: TextEncoding,
    eol: Eol,
    expected_mtime_ms: Option<i64>,
    allow_lossy: bool,
) -> Result<WriteResult> {
    if let (Some(expected), Some(actual)) = (expected_mtime_ms, mtime_ms(path)) {
        if expected != actual {
            return Err(Error::Conflict(path.display().to_string()));
        }
    }
    let normalised = eol::convert(text, eol);
    let encoded = encoding::encode(&normalised, enc);
    if encoded.lossy && !allow_lossy {
        return Err(Error::Lossy(enc.label().to_string()));
    }
    write_bytes_atomic(path, &encoded.bytes)?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(path).unwrap_or(0),
        lossy: encoded.lossy,
    })
}

/// Replaces the content of `path` atomically. Symbolic links are followed, so the link itself
/// survives and its target is updated. When no temporary file can be created next to the target
/// (read-only directory) the file is written in place instead.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.nimble-tmp"));
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(_) => return write_in_place(&target, bytes),
    };
    let staged = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    // Preserve permissions of an existing target.
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn write_in_place(target: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(target)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_keeps_encoding_and_eol() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        let w = write(&p, "one\ntwo\n", TextEncoding::Utf16Le, Eol::Crlf).unwrap();
        assert!(!w.lossy);
        let o = read(&p, Eol::Lf).unwrap();
        assert_eq!(o.text, "one\r\ntwo\r\n");
        assert_eq!(o.encoding, TextEncoding::Utf16Le);
        assert_eq!(o.eol, Eol::Crlf);
        assert!(o.mtime_ms > 0);
    }

    #[test]
    fn single_line_uses_default_eol() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, "just one line").unwrap();
        assert_eq!(read(&p, Eol::Crlf).unwrap().eol, Eol::Crlf);
    }

    #[test]
    fn binary_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.bin");
        std::fs::write(&p, [0x7f, b'E', b'L', b'F', 0, 1, 2, 0, 0, 0, 9]).unwrap();
        assert!(read(&p, Eol::Lf).is_err());
    }

    #[test]
    fn reopen_with_other_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, b"caf\xE9").unwrap();
        assert_eq!(
            read_as(&p, TextEncoding::Windows1252, Eol::Lf)
                .unwrap()
                .text,
            "café"
        );
        assert!(read_as(&p, TextEncoding::Utf8, Eol::Lf).unwrap().lossy);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        write(&p, "x", TextEncoding::Utf8, Eol::Lf).unwrap();
        write(&p, "y", TextEncoding::Utf8, Eol::Lf).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "y");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn stale_mtime_is_rejected_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        let first = write(&p, "mine", TextEncoding::Utf8, Eol::Lf).unwrap();
        std::fs::write(&p, "theirs").unwrap();
        let filetime_bump = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(filetime_bump)
            .unwrap();
        let err = write_checked(
            &p,
            "overwrite",
            TextEncoding::Utf8,
            Eol::Lf,
            Some(first.mtime_ms),
            false,
        )
        .unwrap_err();
        assert!(matches!(err, Error::Conflict(_)));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "theirs");
        // A confirmed overwrite (no expectation) goes through.
        write_checked(&p, "overwrite", TextEncoding::Utf8, Eol::Lf, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "overwrite");
    }

    #[test]
    fn matching_mtime_and_new_files_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        // New file: nothing on disk to conflict with, even with an expectation.
        let w = write_checked(&p, "one", TextEncoding::Utf8, Eol::Lf, Some(123), false).unwrap();
        write_checked(
            &p,
            "two",
            TextEncoding::Utf8,
            Eol::Lf,
            Some(w.mtime_ms),
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_kept_and_target_updated() {
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("real");
        let link_dir = dir.path().join("links");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        let target = real_dir.join("data.txt");
        std::fs::write(&target, "old").unwrap();
        let link = link_dir.join("data-link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write(&link, "new", TextEncoding::Utf8, Eol::Lf).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        // No temporary file is left in either directory.
        assert_eq!(std::fs::read_dir(&real_dir).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(&link_dir).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_falls_back_to_writing_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ro");
        std::fs::create_dir(&sub).unwrap();
        let p = sub.join("a.txt");
        std::fs::write(&p, "old").unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o555)).unwrap();
        let r = write(&p, "new", TextEncoding::Utf8, Eol::Lf);
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        r.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new");
        assert_eq!(std::fs::read_dir(&sub).unwrap().count(), 1);
    }

    #[test]
    fn in_place_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, "a much longer old content").unwrap();
        write_in_place(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
    }

    #[test]
    fn lossy_write_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        assert!(
            write(&p, "日本", TextEncoding::Windows1252, Eol::Lf)
                .unwrap()
                .lossy
        );
    }

    #[test]
    fn unrepresentable_characters_are_refused_unless_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, b"old").unwrap();
        let enc = TextEncoding::Windows1252;
        let err = write_checked(&p, "日本", enc, Eol::Lf, None, false).unwrap_err();
        assert!(matches!(&err, Error::Lossy(l) if l == "Windows-1252"));
        assert_eq!(std::fs::read(&p).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let w = write_checked(&p, "日本", enc, Eol::Lf, None, true).unwrap();
        assert!(w.lossy);
        assert_ne!(std::fs::read(&p).unwrap(), b"old");
        // Representable text is fine either way.
        assert!(
            !write_checked(&p, "café", enc, Eol::Lf, None, false)
                .unwrap()
                .lossy
        );
    }

    #[test]
    fn unicode_encodings_never_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        for enc in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            let w = write_checked(&p, "日本 😀 æ", enc, Eol::Lf, None, false).unwrap();
            assert!(!w.lossy);
            assert_eq!(read(&p, Eol::Lf).unwrap().text, "日本 😀 æ");
        }
    }

    #[test]
    fn reopening_a_huge_file_with_an_encoding_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.log");
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_EDITABLE_BYTES + 1).unwrap(); // sparse: no real disk use
        drop(f);
        let err = read_as(&p, TextEncoding::Utf8, Eol::Lf).unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
        assert!(read(&p, Eol::Lf).is_err());
    }
}

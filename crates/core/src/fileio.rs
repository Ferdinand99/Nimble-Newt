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
        encoding::detect(sample),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be
    )
}

/// Reads `path`. `default_eol` is used when the file has no line break at all.
pub fn read(path: &Path, default_eol: Eol) -> Result<OpenedFile> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_EDITABLE_BYTES {
        return Err(Error::Msg(format!(
            "{} is too large to edit ({} MB, limit {} MB)",
            path.display(),
            meta.len() / 1_048_576,
            MAX_EDITABLE_BYTES / 1_048_576
        )));
    }
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
pub fn read_as(path: &Path, enc: TextEncoding, default_eol: Eol) -> Result<OpenedFile> {
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
pub fn write(path: &Path, text: &str, enc: TextEncoding, eol: Eol) -> Result<WriteResult> {
    let normalised = eol::convert(text, eol);
    let encoded = encoding::encode(&normalised, enc);
    write_bytes_atomic(path, &encoded.bytes)?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(path).unwrap_or(0),
        lossy: encoded.lossy,
    })
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.nimble-tmp"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // Preserve permissions of an existing target.
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
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
    fn lossy_write_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        assert!(
            write(&p, "日本", TextEncoding::Windows1252, Eol::Lf)
                .unwrap()
                .lossy
        );
    }
}

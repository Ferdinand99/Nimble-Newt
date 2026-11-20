//! What the Markdown view may load and open: local images next to the document, remote images
//! after the user allowed them, and links handed to the system browser.
//!
//! The webview's content security policy only allows images from the app itself and `data:` URLs,
//! so the view never loads a file or a URL by itself. It asks the backend, which checks the request
//! here and answers with a `data:` URL.

use crate::{Error, Result};
use base64::Engine;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use url::{Host, Url};

/// The largest image the view shows (local or remote).
pub const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

fn msg(s: impl Into<String>) -> Error {
    Error::Msg(s.into())
}

/// The media type of an image file, by extension. Anything else is not shown.
pub fn image_mime_for_path(p: &Path) -> Option<&'static str> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// The media type of a remote image from its `Content-Type` header, if it is one we show.
pub fn image_mime_from_content_type(content_type: &str) -> Option<&'static str> {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(match essence.as_str() {
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        "image/avif" => "image/avif",
        "image/bmp" => "image/bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "image/x-icon",
        "image/svg+xml" => "image/svg+xml",
        _ => return None,
    })
}

pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Resolves an image reference from a Markdown file (`src`, already percent-decoded) against the
/// folder of the document. Only regular image files inside that folder (or below it) are allowed:
/// absolute paths, drive letters, `..` that climbs out and symbolic links that point outside are
/// refused, because the folder is compared after the real path is resolved.
pub fn resolve_local_image(doc_path: &Path, src: &str) -> Result<PathBuf> {
    if src.is_empty() || src.len() > 4096 || src.contains('\0') {
        return Err(msg("invalid image path"));
    }
    // A colon is a drive letter, a URL scheme or (on Windows) an alternate data stream.
    if src.starts_with('/') || src.starts_with('\\') || src.contains(':') {
        return Err(msg("only images in the document's folder are shown"));
    }
    let rel = Path::new(src);
    if rel.is_absolute() || rel.has_root() {
        return Err(msg("only images in the document's folder are shown"));
    }
    let base = doc_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| msg("the document has no folder"))?;
    let base = std::fs::canonicalize(base)?;
    let target = std::fs::canonicalize(base.join(rel)).map_err(|_| msg("image not found"))?;
    if !target.starts_with(&base) {
        return Err(msg("only images in the document's folder are shown"));
    }
    let meta = std::fs::metadata(&target)?;
    if !meta.is_file() {
        return Err(msg("not a file"));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(msg("image is too large"));
    }
    if image_mime_for_path(&target).is_none() {
        return Err(msg("not an image file"));
    }
    Ok(target)
}

/// Reads a local image (see [`resolve_local_image`]) and returns it as a `data:` URL.
pub fn read_local_image(doc_path: &Path, src: &str) -> Result<String> {
    let path = resolve_local_image(doc_path, src)?;
    let mime = image_mime_for_path(&path).ok_or_else(|| msg("not an image file"))?;
    let bytes = std::fs::read(&path)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(msg("image is too large"));
    }
    Ok(data_url(mime, &bytes))
}

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
}

fn private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return private_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (first & 0xfe00) == 0xfc00 // unique local
        || (first & 0xffc0) == 0xfe80 // link local
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => private_v4(v4),
        IpAddr::V6(v6) => private_v6(v6),
    }
}

/// Checks a remote image URL before the backend downloads it: `https` only, no user name or
/// password, and no host on this computer or the local network when it is written as a name like
/// `localhost` or as an IP address. (A public name that resolves to a local address is not caught;
/// the response must still be an image.)
pub fn check_remote_image_url(s: &str) -> Result<Url> {
    if s.len() > 8192 {
        return Err(msg("URL is too long"));
    }
    let url = Url::parse(s).map_err(|e| msg(format!("invalid URL: {e}")))?;
    if url.scheme() != "https" {
        return Err(msg("only https images are loaded"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(msg("URLs with a user name are not loaded"));
    }
    match url.host() {
        None => return Err(msg("URL has no host")),
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") {
                return Err(msg(
                    "images from this computer or the local network are not loaded",
                ));
            }
        }
        Some(Host::Ipv4(ip)) => {
            if is_private_ip(IpAddr::V4(ip)) {
                return Err(msg(
                    "images from this computer or the local network are not loaded",
                ));
            }
        }
        Some(Host::Ipv6(ip)) => {
            if is_private_ip(IpAddr::V6(ip)) {
                return Err(msg(
                    "images from this computer or the local network are not loaded",
                ));
            }
        }
    }
    Ok(url)
}

/// Checks a link before it is handed to the system: `http`, `https` and `mailto` only. Returns the
/// URL as the parser normalised it, so what is opened is exactly what was checked.
pub fn check_external_url(s: &str) -> Result<String> {
    if s.len() > 8192 {
        return Err(msg("URL is too long"));
    }
    let url = Url::parse(s.trim()).map_err(|e| msg(format!("invalid URL: {e}")))?;
    match url.scheme() {
        "http" | "https" => {
            if url.host().is_none() {
                return Err(msg("URL has no host"));
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err(msg("links with a user name are not opened"));
            }
        }
        "mailto" => {}
        other => return Err(msg(format!("links of type {other}: are not opened"))),
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Tree {
        _dir: tempfile::TempDir,
        root: PathBuf,
        doc: PathBuf,
    }

    /// root/
    ///   secret.png          (outside the document's folder)
    ///   docs/readme.md      (the document)
    ///   docs/pic.png
    ///   docs/img/inner.gif
    ///   docs/notes.txt
    ///   docs/folder.png/    (a directory)
    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let docs = root.join("docs");
        fs::create_dir_all(docs.join("img")).unwrap();
        fs::create_dir_all(docs.join("folder.png")).unwrap();
        fs::write(root.join("secret.png"), b"secret").unwrap();
        fs::write(docs.join("readme.md"), b"# hi").unwrap();
        fs::write(docs.join("pic.png"), b"\x89PNG").unwrap();
        fs::write(docs.join("img").join("inner.gif"), b"GIF89a").unwrap();
        fs::write(docs.join("notes.txt"), b"text").unwrap();
        Tree {
            doc: docs.join("readme.md"),
            root,
            _dir: dir,
        }
    }

    #[test]
    fn images_in_the_folder_and_below_are_read_as_data_urls() {
        let t = tree();
        assert_eq!(
            read_local_image(&t.doc, "pic.png").unwrap(),
            "data:image/png;base64,iVBORw=="
        );
        assert!(read_local_image(&t.doc, "img/inner.gif")
            .unwrap()
            .starts_with("data:image/gif;base64,"));
        assert!(read_local_image(&t.doc, "./img/../pic.png").is_ok());
        #[cfg(windows)]
        assert!(read_local_image(&t.doc, "img\\inner.gif").is_ok());
    }

    #[test]
    fn path_traversal_is_refused() {
        let t = tree();
        assert!(t.root.join("secret.png").is_file());
        for src in [
            "../secret.png",
            "../../secret.png",
            "img/../../secret.png",
            "./../secret.png",
            "..\\secret.png",
            "img/../../../../../../../../etc/passwd",
        ] {
            assert!(
                resolve_local_image(&t.doc, src).is_err(),
                "{src} was allowed"
            );
        }
    }

    #[test]
    fn absolute_paths_drive_letters_and_schemes_are_refused() {
        let t = tree();
        let abs = t.root.join("docs").join("pic.png");
        let abs = abs.to_string_lossy().into_owned();
        for src in [
            abs.as_str(),
            "/etc/passwd",
            "\\\\server\\share\\x.png",
            "C:/Windows/x.png",
            "C:pic.png",
            "file:///etc/passwd",
            "pic.png:stream",
            "",
            "pic\0.png",
        ] {
            assert!(
                resolve_local_image(&t.doc, src).is_err(),
                "{src:?} was allowed"
            );
        }
    }

    #[test]
    fn only_regular_image_files_are_read() {
        let t = tree();
        assert!(resolve_local_image(&t.doc, "notes.txt").is_err());
        assert!(resolve_local_image(&t.doc, "readme.md").is_err());
        assert!(resolve_local_image(&t.doc, "folder.png").is_err());
        assert!(resolve_local_image(&t.doc, "missing.png").is_err());
    }

    #[test]
    fn large_images_are_refused() {
        let t = tree();
        let f = fs::File::create(t.root.join("docs").join("huge.png")).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(resolve_local_image(&t.doc, "huge.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_that_leave_the_folder_are_refused() {
        let t = tree();
        let docs = t.root.join("docs");
        std::os::unix::fs::symlink(t.root.join("secret.png"), docs.join("link.png")).unwrap();
        std::os::unix::fs::symlink(&t.root, docs.join("up")).unwrap();
        assert!(resolve_local_image(&t.doc, "link.png").is_err());
        assert!(resolve_local_image(&t.doc, "up/secret.png").is_err());
        std::os::unix::fs::symlink(docs.join("pic.png"), docs.join("inside.png")).unwrap();
        assert!(resolve_local_image(&t.doc, "inside.png").is_ok());
    }

    #[test]
    fn a_document_without_a_folder_shows_no_local_images() {
        assert!(resolve_local_image(Path::new("readme.md"), "pic.png").is_err());
    }

    #[test]
    fn remote_images_must_be_public_https() {
        assert!(check_remote_image_url("https://example.com/a.png").is_ok());
        assert!(check_remote_image_url("https://93.184.216.34/a.png").is_ok());
        for bad in [
            "http://example.com/a.png",
            "ftp://example.com/a.png",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
            "https://user:pw@example.com/a.png",
            "https://localhost/a.png",
            "https://LOCALHOST./a.png",
            "https://api.localhost/a.png",
            "https://printer.local/a.png",
            "https://127.0.0.1/a.png",
            "https://10.0.0.1/a.png",
            "https://192.168.1.1/a.png",
            "https://172.16.0.1/a.png",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/a.png",
            "https://0.0.0.0/a.png",
            "https://[::1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[fe80::1]/a.png",
            "https://[::ffff:127.0.0.1]/a.png",
            "https://2130706433/a.png",
            "not a url",
        ] {
            assert!(check_remote_image_url(bad).is_err(), "{bad} was allowed");
        }
    }

    #[test]
    fn content_types() {
        assert_eq!(
            image_mime_from_content_type("image/PNG; charset=x"),
            Some("image/png")
        );
        assert_eq!(
            image_mime_from_content_type("image/svg+xml"),
            Some("image/svg+xml")
        );
        assert_eq!(image_mime_from_content_type("text/html"), None);
        assert_eq!(image_mime_from_content_type(""), None);
        assert_eq!(
            image_mime_from_content_type("application/octet-stream"),
            None
        );
    }

    #[test]
    fn external_links_are_http_https_or_mailto() {
        assert_eq!(
            check_external_url("https://example.com/a b").unwrap(),
            "https://example.com/a%20b"
        );
        assert!(check_external_url("http://example.com").is_ok());
        assert!(check_external_url("mailto:someone@example.com").is_ok());
        for bad in [
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///C:/Windows/System32/calc.exe",
            "vbscript:msgbox",
            "ms-settings:",
            "smb://server/share",
            "https://user:pw@example.com",
            "relative/path.md",
            "",
        ] {
            assert!(check_external_url(bad).is_err(), "{bad} was allowed");
        }
    }
}

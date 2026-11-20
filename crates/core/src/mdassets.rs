//! What the Markdown view may load and open: local images next to the document, remote images
//! after the user allowed them, and links handed to the system browser.
//!
//! The webview's content security policy only allows images from the app itself and `data:` URLs,
//! so the view never loads a file or a URL by itself. It asks the backend, which checks the request
//! here and answers with a `data:` URL. The backend also decides which documents may do that
//! ([`DocGate`]): only documents it opened itself, and remote images only after the user said yes in
//! a dialog the backend shows.

use crate::{Error, Result};
use base64::Engine;
use std::collections::HashSet;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use url::{Host, Url};

/// The largest image the view shows (local or remote).
pub const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
/// Redirects followed for one remote image at most.
pub const MAX_REDIRECTS: usize = 5;

fn msg(s: impl Into<String>) -> Error {
    Error::Msg(s.into())
}

const NOT_LOCAL: &str = "images from this computer or the local network are not loaded";

// ---- which documents may load what ------------------------------------------------------------------

/// Documents the backend has opened or saved, and the ones whose remote images the user allowed in
/// the backend's own dialog. Kept in memory only, and dropped when the tab closes: the consent is asked
/// again after a restart or when the document is opened again. Knowing a document is a consistency
/// check (a script in the page could open a file first); the dialog is the boundary.
#[derive(Default)]
pub struct DocGate {
    inner: Mutex<GateInner>,
}

#[derive(Default)]
struct GateInner {
    known: HashSet<PathBuf>,
    remote: HashSet<PathBuf>,
}

impl DocGate {
    /// Called when the backend opens or saves a file for the editor.
    pub fn register(&self, path: &Path) {
        self.inner.lock().unwrap().known.insert(path.to_path_buf());
    }

    /// Called when a tab closes: the document is no longer known, and its consent is gone.
    pub fn forget(&self, path: &Path) {
        let mut g = self.inner.lock().unwrap();
        g.known.remove(path);
        g.remote.remove(path);
    }

    pub fn is_known(&self, path: &Path) -> bool {
        self.inner.lock().unwrap().known.contains(path)
    }

    pub fn check_known(&self, path: &Path) -> Result<()> {
        if self.is_known(path) {
            Ok(())
        } else {
            Err(msg("not a document that is open in Nimble Newt"))
        }
    }

    /// Records the user's yes for remote images of one open document.
    pub fn allow_remote(&self, path: &Path) -> Result<()> {
        let mut g = self.inner.lock().unwrap();
        if !g.known.contains(path) {
            return Err(msg("not a document that is open in Nimble Newt"));
        }
        g.remote.insert(path.to_path_buf());
        Ok(())
    }

    pub fn remote_allowed(&self, path: &Path) -> bool {
        self.inner.lock().unwrap().remote.contains(path)
    }

    pub fn check_remote(&self, path: &Path) -> Result<()> {
        if self.remote_allowed(path) {
            Ok(())
        } else {
            Err(msg("remote images are not allowed for this document"))
        }
    }
}

// ---- local images ---------------------------------------------------------------------------------------

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

/// The media type of a remote image from its `Content-Type` header, if it is one we show. SVG is
/// allowed: it is only ever shown inside `<img>`, where its scripts do not run.
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
/// absolute paths, drive letters, `..` that climbs out and symbolic links or junctions that point
/// outside are refused, because the folder is compared after the real path is resolved.
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
    if image_mime_for_path(&target).is_none() {
        return Err(msg("not an image file"));
    }
    Ok(target)
}

/// Reads a local image (see [`resolve_local_image`]) and returns it as a `data:` URL. The size limit
/// is enforced while reading, so a file that grows after the check is not read in full.
pub fn read_local_image(doc_path: &Path, src: &str) -> Result<String> {
    let path = resolve_local_image(doc_path, src)?;
    let mime = image_mime_for_path(&path).ok_or_else(|| msg("not an image file"))?;
    let file = std::fs::File::open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(msg("not a file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(msg("image is too large"));
    }
    Ok(data_url(mime, &bytes))
}

// ---- remote images --------------------------------------------------------------------------------------

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240 // reserved
}

fn private_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    s[..6] == [0; 6] // ::/96: unspecified, loopback, IPv4-compatible
        || (s[..5] == [0; 5] && s[5] == 0xffff) // ::ffff:0:0/96, IPv4-mapped
        || (s[0] == 0x64 && s[1] == 0xff9b) // 64:ff9b::/96 and 64:ff9b:1::/48, NAT64
        || s[0] == 0x2002 // 6to4
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] & 0xffc0) == 0xfec0 // site local (deprecated)
        || (s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link local
        || (s[0] & 0xff00) == 0xff00 // multicast
}

/// Addresses on this computer, the local network or otherwise not public on the internet.
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => private_v4(v4),
        IpAddr::V6(v6) => private_v6(v6),
    }
}

/// Keeps the public addresses of a name that was resolved; fails when none is left. The download
/// connects only to the addresses returned here, so a name that points at the local network (or
/// changes to do so between two lookups) never gets a request. `allow_loopback` is for tests only.
pub fn public_addrs(
    addrs: impl IntoIterator<Item = SocketAddr>,
    allow_loopback: bool,
) -> Result<Vec<SocketAddr>> {
    let kept: Vec<SocketAddr> = addrs
        .into_iter()
        .filter(|a| !is_private_ip(a.ip()) || (allow_loopback && a.ip().is_loopback()))
        .collect();
    if kept.is_empty() {
        return Err(msg(NOT_LOCAL));
    }
    Ok(kept)
}

/// Checks a remote URL before it is requested: the given scheme (`https` in the app), no user name
/// or password, and no host on this computer or the local network when it is written as an IP
/// address or a name like `localhost`. Names are checked again after they are resolved
/// ([`public_addrs`]).
pub fn check_remote_url(s: &str, scheme: &str) -> Result<Url> {
    if s.len() > 8192 {
        return Err(msg("URL is too long"));
    }
    let url = Url::parse(s).map_err(|e| msg(format!("invalid URL: {e}")))?;
    if url.scheme() != scheme {
        return Err(msg(format!("only {scheme} images are loaded")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(msg("URLs with a user name are not loaded"));
    }
    match url.host() {
        None => return Err(msg("URL has no host")),
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") {
                return Err(msg(NOT_LOCAL));
            }
        }
        Some(Host::Ipv4(ip)) => {
            if is_private_ip(IpAddr::V4(ip)) {
                return Err(msg(NOT_LOCAL));
            }
        }
        Some(Host::Ipv6(ip)) => {
            if is_private_ip(IpAddr::V6(ip)) {
                return Err(msg(NOT_LOCAL));
            }
        }
    }
    Ok(url)
}

/// [`check_remote_url`] for the app: `https` only.
pub fn check_remote_image_url(s: &str) -> Result<Url> {
    check_remote_url(s, "https")
}

/// May the download follow a redirect to `url`, after `previous` hops? The same rules as for the
/// first URL, and at most [`MAX_REDIRECTS`] hops.
pub fn redirect_allowed(url: &str, previous: usize, scheme: &str) -> Result<()> {
    if previous >= MAX_REDIRECTS {
        return Err(msg("too many redirects"));
    }
    check_remote_url(url, scheme).map(|_| ())
}

/// The body of a download, refused as soon as it passes `max` bytes (whatever `Content-Length`
/// said, or when there was none).
pub struct CappedBody {
    max: u64,
    bytes: Vec<u8>,
}

impl CappedBody {
    /// Fails at once when the announced length is already too large.
    pub fn new(max: u64, announced: Option<u64>) -> Result<Self> {
        if announced.is_some_and(|n| n > max) {
            return Err(msg("image is too large"));
        }
        Ok(Self {
            max,
            bytes: Vec::new(),
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        if (self.bytes.len() + chunk.len()) as u64 > self.max {
            return Err(msg("image is too large"));
        }
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

// ---- links ----------------------------------------------------------------------------------------------

/// Query keys a `mailto:` link may carry. Others (such as `attach`, which some mail programs read
/// to attach a local file) are refused.
const MAILTO_KEYS: [&str; 5] = ["to", "cc", "bcc", "subject", "body"];

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
        "mailto" => {
            for (key, _) in url.query_pairs() {
                let key = key.to_ascii_lowercase();
                if !MAILTO_KEYS.contains(&key.as_str()) {
                    return Err(msg(format!("mail links with \"{key}\" are not opened")));
                }
            }
        }
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
        assert!(read_local_image(&t.doc, "folder.png").is_err());
        assert!(resolve_local_image(&t.doc, "missing.png").is_err());
    }

    #[test]
    fn large_images_are_refused() {
        let t = tree();
        let f = fs::File::create(t.root.join("docs").join("huge.png")).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_local_image(&t.doc, "huge.png").is_err());
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

    #[cfg(windows)]
    #[test]
    fn junctions_that_leave_the_folder_are_refused() {
        let t = tree();
        let docs = t.root.join("docs");
        let outside = t.root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.png"), b"\x89PNG").unwrap();
        // A junction needs no administrator rights, unlike a symbolic link.
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(docs.join("jn"))
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "could not make a junction");
        assert!(resolve_local_image(&t.doc, "jn/x.png").is_err());
        assert!(read_local_image(&t.doc, "jn\\x.png").is_err());
    }

    #[test]
    fn only_documents_the_backend_opened_are_served() {
        let gate = DocGate::default();
        let doc = Path::new("/work/docs/readme.md");
        assert!(gate.check_known(doc).is_err());
        assert!(
            gate.allow_remote(doc).is_err(),
            "consent for an unknown document"
        );
        gate.register(doc);
        assert!(gate.check_known(doc).is_ok());
        assert!(gate.check_known(Path::new("/etc/readme.md")).is_err());
        // Remote images need the user's yes, per document.
        assert!(gate.check_remote(doc).is_err());
        gate.allow_remote(doc).unwrap();
        assert!(gate.check_remote(doc).is_ok());
        let other = Path::new("/work/docs/other.md");
        gate.register(other);
        assert!(gate.check_remote(other).is_err());
    }

    #[test]
    fn closing_a_tab_drops_the_document_and_its_consent() {
        let gate = DocGate::default();
        let doc = Path::new("/work/docs/readme.md");
        let other = Path::new("/work/docs/other.md");
        gate.register(doc);
        gate.register(other);
        gate.allow_remote(doc).unwrap();
        gate.allow_remote(other).unwrap();
        gate.forget(doc);
        assert!(gate.check_known(doc).is_err());
        assert!(gate.check_remote(doc).is_err());
        // Opening it again does not bring the old yes back.
        gate.register(doc);
        assert!(gate.check_known(doc).is_ok());
        assert!(gate.check_remote(doc).is_err());
        // Other documents are not touched.
        assert!(gate.check_remote(other).is_ok());
    }

    #[test]
    fn the_private_ranges_cover_the_tricky_cases() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.31.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "0.1.2.3",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:8.8.8.8",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "2002:7f00:1::1",
            "2001:db8::1",
            "fec0::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip} counted as public");
        }
        for ip in [
            "8.8.8.8",
            "93.184.216.34",
            "100.128.0.1",
            "198.20.0.1",
            "2606:4700::1111",
        ] {
            assert!(
                !is_private_ip(ip.parse().unwrap()),
                "{ip} counted as private"
            );
        }
        assert!(check_remote_image_url("https://[::127.0.0.1]/a.png").is_err());
        assert!(check_remote_image_url("https://[64:ff9b::7f00:1]/a.png").is_err());
    }

    #[test]
    fn resolved_addresses_are_filtered() {
        let a = |s: &str| s.parse::<SocketAddr>().unwrap();
        let mixed = [a("10.0.0.5:443"), a("93.184.216.34:443"), a("[::1]:443")];
        assert_eq!(
            public_addrs(mixed, false).unwrap(),
            vec![a("93.184.216.34:443")]
        );
        // A name that only points at the local network gets no connection at all.
        assert!(public_addrs([a("192.168.1.10:443"), a("[fd00::1]:443")], false).is_err());
        assert!(public_addrs([a("127.0.0.1:443")], false).is_err());
        assert!(public_addrs(Vec::<SocketAddr>::new(), false).is_err());
        // Tests may talk to a server on this computer, but still not to the local network.
        assert_eq!(
            public_addrs([a("127.0.0.1:8080"), a("10.0.0.1:8080")], true).unwrap(),
            vec![a("127.0.0.1:8080")]
        );
    }

    #[test]
    fn redirects_follow_the_same_rules() {
        assert!(redirect_allowed("https://cdn.example.com/a.png", 0, "https").is_ok());
        assert!(
            redirect_allowed("https://cdn.example.com/a.png", MAX_REDIRECTS - 1, "https").is_ok()
        );
        assert!(redirect_allowed("https://cdn.example.com/a.png", MAX_REDIRECTS, "https").is_err());
        assert!(redirect_allowed("http://cdn.example.com/a.png", 0, "https").is_err());
        assert!(redirect_allowed("https://10.0.0.1/a.png", 0, "https").is_err());
        assert!(redirect_allowed("https://localhost/a.png", 0, "https").is_err());
        assert!(redirect_allowed("file:///etc/passwd", 0, "https").is_err());
    }

    #[test]
    fn downloads_are_capped_with_or_without_a_length() {
        assert!(CappedBody::new(10, Some(11)).is_err());
        let mut b = CappedBody::new(10, Some(10)).unwrap();
        b.push(b"12345").unwrap();
        b.push(b"67890").unwrap();
        assert!(b.push(b"x").is_err());
        let mut b = CappedBody::new(10, None).unwrap();
        b.push(b"1234567").unwrap();
        assert!(b.push(b"8901").is_err());
        let mut b = CappedBody::new(10, None).unwrap();
        b.push(b"abc").unwrap();
        assert_eq!(b.into_bytes(), b"abc");
    }

    #[test]
    fn mail_links_carry_only_harmless_fields() {
        assert!(check_external_url("mailto:a@example.com?subject=Hi&body=Text").is_ok());
        assert!(
            check_external_url("mailto:a@example.com?cc=b@example.com&BCC=c@example.com").is_ok()
        );
        for bad in [
            "mailto:a@example.com?attach=/etc/passwd",
            "mailto:a@example.com?ATTACH=C:/secret.txt",
            "mailto:a@example.com?subject=x&attachment=~/.ssh/id_rsa",
            "mailto:a@example.com?x-unknown=1",
        ] {
            assert!(check_external_url(bad).is_err(), "{bad} was allowed");
        }
    }
}

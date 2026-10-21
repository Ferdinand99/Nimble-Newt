//! Serves the documents of sandboxed extensions from their own URI scheme (`nnext`).
//!
//! An iframe with `srcdoc` inherits the CSP of the app page, so its inline scripts would be blocked in a
//! release build. A document loaded from this scheme carries its own CSP header instead, and the app CSP only
//! names the scheme in `frame-src`; the app itself never needs `'unsafe-inline'` for scripts.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};

pub const SCHEME: &str = "nnext";

/// The CSP of every sandbox document: no network, no frames, no media, only inline script.
pub const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'";

#[derive(Default)]
pub struct SandboxDocs {
    docs: Mutex<HashMap<String, String>>,
}

impl SandboxDocs {
    /// Stores a document and returns the unguessable id it is served under.
    pub fn stage(&self, html: String) -> String {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_usize(self.docs.lock().unwrap().len());
        let id = format!("{:016x}", h.finish());
        self.docs.lock().unwrap().insert(id.clone(), html);
        id
    }

    pub fn release(&self, id: &str) {
        self.docs.lock().unwrap().remove(id);
    }

    /// The response for a request path such as `/<id>`; anything but a staged document is a 404.
    pub fn respond(&self, path: &str) -> Response<Vec<u8>> {
        let id = path.trim_start_matches('/');
        match self.docs.lock().unwrap().get(id) {
            Some(html) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header("Content-Security-Policy", CSP)
                .header("X-Content-Type-Options", "nosniff")
                .header(header::CACHE_CONTROL, "no-store")
                .body(html.clone().into_bytes())
                .unwrap(),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Content-Security-Policy", CSP)
                .body(Vec::new())
                .unwrap(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_staged_documents_with_the_sandbox_csp() {
        let docs = SandboxDocs::default();
        let id = docs.stage("<p>hi</p>".into());
        let ok = docs.respond(&format!("/{id}"));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["content-security-policy"], CSP);
        assert_eq!(ok.body(), b"<p>hi</p>");
        assert_eq!(docs.respond("/nope").status(), StatusCode::NOT_FOUND);
        assert_eq!(docs.respond("/").status(), StatusCode::NOT_FOUND);
        docs.release(&id);
        assert_eq!(
            docs.respond(&format!("/{id}")).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn ids_are_distinct() {
        let docs = SandboxDocs::default();
        let a = docs.stage("a".into());
        let b = docs.stage("b".into());
        assert_ne!(a, b);
    }

    #[test]
    fn the_csp_allows_no_network_and_no_frames() {
        for bad in [
            "connect-src",
            "frame-src",
            "https:",
            "http:",
            "*",
            "'self'",
            "data:",
        ] {
            assert!(!CSP.contains(bad), "{bad}");
        }
        assert!(CSP.starts_with("default-src 'none'"));
    }
}

//! Downloads remote images for the Markdown view. The rules are in `nimble_core::mdassets`; this is
//! the HTTP client around them:
//! - names are resolved by [`PublicOnly`], which drops every address on this computer or the local
//!   network, and the client connects only to what it returns (no second lookup, so a name cannot
//!   switch to a local address in between), for the first request and every redirect alike;
//! - every redirect is checked like the first URL, at most `MAX_REDIRECTS` of them;
//! - no proxy (a proxy would resolve the name itself), no cookies, no `Referer`, a generic
//!   `User-Agent`;
//! - only image content types, at most `max_bytes` whether or not `Content-Length` is sent;
//! - one time limit for the whole download.

use nimble_core::mdassets::{self, CappedBody, MAX_IMAGE_BYTES};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub struct Policy {
    /// `https` in the app; the tests talk plain `http` to a server on this computer.
    pub scheme: &'static str,
    pub timeout: Duration,
    pub max_bytes: u64,
    /// Tests only: let names resolve to this computer (never to the local network).
    pub allow_loopback: bool,
    /// Tests only: fixed answers for names, instead of the system resolver.
    pub hosts: HashMap<String, Vec<IpAddr>>,
}

impl Policy {
    pub fn app() -> Self {
        Self {
            scheme: "https",
            timeout: Duration::from_secs(20),
            max_bytes: MAX_IMAGE_BYTES,
            allow_loopback: false,
            hosts: HashMap::new(),
        }
    }
}

/// Resolves names and keeps only public addresses.
struct PublicOnly {
    allow_loopback: bool,
    hosts: Arc<HashMap<String, Vec<IpAddr>>>,
}

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let fixed = self.hosts.get(&host).cloned();
        let allow_loopback = self.allow_loopback;
        Box::pin(async move {
            let found: Vec<SocketAddr> = match fixed {
                Some(ips) => ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect(),
                None => {
                    tauri::async_runtime::spawn_blocking(move || {
                        (host.as_str(), 0).to_socket_addrs().map(|a| a.collect())
                    })
                    .await??
                }
            };
            let kept = mdassets::public_addrs(found, allow_loopback)?;
            let addrs: Addrs = Box::new(kept.into_iter());
            Ok(addrs)
        })
    }
}

pub struct Fetcher {
    client: reqwest::Client,
    scheme: &'static str,
    max_bytes: u64,
}

/// The reason of a failed request, with the cause (a refused redirect or address) when there is one.
fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "the image server did not answer in time".into();
    }
    let mut parts = vec![e.to_string()];
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let text = s.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        source = s.source();
    }
    parts.join(": ")
}

impl Fetcher {
    pub fn new(policy: Policy) -> Result<Self, String> {
        // reqwest is built without a crypto provider (as for the updater): use ring, like the updater.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let scheme = policy.scheme;
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible)")
            .timeout(policy.timeout)
            .no_proxy()
            .referer(false)
            .dns_resolver(Arc::new(PublicOnly {
                allow_loopback: policy.allow_loopback,
                hosts: Arc::new(policy.hosts),
            }))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                // `previous` holds the URLs requested so far, the first one included.
                let hops = attempt.previous().len().saturating_sub(1);
                match mdassets::redirect_allowed(attempt.url().as_str(), hops, scheme) {
                    Ok(()) => attempt.follow(),
                    Err(e) => attempt.error(e.to_string()),
                }
            }))
            .build()
            .map_err(|e| describe(&e))?;
        Ok(Self {
            client,
            scheme,
            max_bytes: policy.max_bytes,
        })
    }

    /// The client of the app, made once.
    pub fn shared() -> Result<&'static Fetcher, String> {
        static FETCHER: OnceLock<Result<Fetcher, String>> = OnceLock::new();
        FETCHER
            .get_or_init(|| Fetcher::new(Policy::app()))
            .as_ref()
            .map_err(Clone::clone)
    }

    /// Downloads an image and returns it as a `data:` URL.
    pub async fn fetch(&self, url: &str) -> Result<String, String> {
        let url = mdassets::check_remote_url(url, self.scheme).map_err(|e| e.to_string())?;
        let mut resp = self
            .client
            .get(url.as_str())
            .header(ACCEPT, "image/*")
            .send()
            .await
            .map_err(|e| describe(&e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let mime = mdassets::image_mime_from_content_type(content_type)
            .ok_or_else(|| "the address did not return an image".to_string())?;
        let mut body =
            CappedBody::new(self.max_bytes, resp.content_length()).map_err(|e| e.to_string())?;
        while let Some(chunk) = resp.chunk().await.map_err(|e| describe(&e))? {
            body.push(&chunk).map_err(|e| e.to_string())?;
        }
        Ok(mdassets::data_url(mime, &body.into_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// A small HTTP/1.1 server on 127.0.0.1 with one answer per path.
    fn server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                            break;
                        }
                    }
                    let respond = |s: &mut std::net::TcpStream, head: &str, body: &[u8]| {
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(body);
                    };
                    let png = b"\x89PNG\r\n\x1a\n";
                    match path.as_str() {
                        "/ok.png" => respond(
                            &mut stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
                            png,
                        ),
                        "/pic.svg" => {
                            let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
                            respond(
                                &mut stream,
                                &format!("HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", svg.len()),
                                svg,
                            )
                        }
                        "/page.html" => respond(
                            &mut stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 4\r\nConnection: close\r\n\r\n",
                            b"<b>x",
                        ),
                        "/no-type" => respond(
                            &mut stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
                            png,
                        ),
                        // No Content-Length: the body just runs until the connection closes.
                        "/endless.png" => respond(
                            &mut stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n",
                            &[0u8; 4096],
                        ),
                        "/announced-big.png" => respond(
                            &mut stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n",
                            png,
                        ),
                        "/slow.png" => {
                            std::thread::sleep(Duration::from_secs(3));
                            respond(
                                &mut stream,
                                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
                                png,
                            )
                        }
                        "/missing.png" => respond(
                            &mut stream,
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            b"",
                        ),
                        p if p.starts_with("/redirect?") => {
                            let to = &p["/redirect?".len()..];
                            respond(
                                &mut stream,
                                &format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                                b"",
                            )
                        }
                        "/loop" => respond(
                            &mut stream,
                            "HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            b"",
                        ),
                        _ => respond(
                            &mut stream,
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            b"",
                        ),
                    }
                });
            }
        });
        port
    }

    /// The app's rules, but plain http to `img.test` (= this computer), a short time limit and a
    /// small size limit. `lan.test` resolves to the local network, `mixed.test` to both.
    fn fetcher() -> Fetcher {
        let mut hosts = HashMap::new();
        hosts.insert("img.test".to_owned(), vec!["127.0.0.1".parse().unwrap()]);
        hosts.insert("lan.test".to_owned(), vec!["192.168.1.20".parse().unwrap()]);
        hosts.insert(
            "rebind.test".to_owned(),
            vec!["10.0.0.7".parse().unwrap(), "fd00::7".parse().unwrap()],
        );
        Fetcher::new(Policy {
            scheme: "http",
            timeout: Duration::from_millis(1500),
            max_bytes: 1024,
            allow_loopback: true,
            hosts,
        })
        .unwrap()
    }

    fn get(url: &str) -> Result<String, String> {
        let f = fetcher();
        tauri::async_runtime::block_on(f.fetch(url))
    }

    #[test]
    fn an_image_comes_back_as_a_data_url() {
        let port = server();
        assert_eq!(
            get(&format!("http://img.test:{port}/ok.png")).unwrap(),
            "data:image/png;base64,iVBORw0KGgo="
        );
    }

    #[test]
    fn svg_is_returned_as_svg_for_an_img_element() {
        let port = server();
        let url = get(&format!("http://img.test:{port}/pic.svg")).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"), "{url}");
    }

    #[test]
    fn anything_but_an_image_is_refused() {
        let port = server();
        for path in ["/page.html", "/no-type"] {
            let e = get(&format!("http://img.test:{port}{path}")).unwrap_err();
            assert!(e.contains("did not return an image"), "{path}: {e}");
        }
        assert!(get(&format!("http://img.test:{port}/missing.png"))
            .unwrap_err()
            .contains("404"));
    }

    #[test]
    fn the_size_limit_holds_without_a_content_length() {
        let port = server();
        let e = get(&format!("http://img.test:{port}/endless.png")).unwrap_err();
        assert!(e.contains("too large"), "{e}");
        let e = get(&format!("http://img.test:{port}/announced-big.png")).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }

    #[test]
    fn a_slow_server_runs_into_the_time_limit() {
        let port = server();
        let e = get(&format!("http://img.test:{port}/slow.png")).unwrap_err();
        assert!(e.contains("in time"), "{e}");
    }

    #[test]
    fn names_that_resolve_to_the_local_network_get_no_request() {
        let port = server();
        for host in ["lan.test", "rebind.test"] {
            let e = get(&format!("http://{host}:{port}/ok.png")).unwrap_err();
            assert!(e.contains("local network"), "{host}: {e}");
        }
    }

    #[test]
    fn redirects_to_private_addresses_or_another_scheme_are_refused() {
        let port = server();
        for to in [
            format!("http://lan.test:{port}/ok.png"),
            format!("http://10.0.0.1:{port}/ok.png"),
            format!("http://[::1]:{port}/ok.png"),
            "http://localhost/ok.png".to_owned(),
            // The app wants https; in these tests the allowed scheme is http, so https is "the other one".
            format!("https://img.test:{port}/ok.png"),
            "file:///etc/passwd".to_owned(),
        ] {
            let r = get(&format!("http://img.test:{port}/redirect?{to}"));
            assert!(r.is_err(), "redirect to {to} was followed");
        }
        // A redirect within the rules is followed.
        assert!(get(&format!(
            "http://img.test:{port}/redirect?http://img.test:{port}/ok.png"
        ))
        .is_ok());
        let e = get(&format!("http://img.test:{port}/loop")).unwrap_err();
        assert!(e.contains("too many redirects"), "{e}");
    }

    #[test]
    fn the_app_policy_refuses_plain_http_and_private_literals() {
        let f = Fetcher::new(Policy::app()).unwrap();
        for url in [
            "http://example.com/a.png",
            "https://127.0.0.1/a.png",
            "https://[::ffff:10.0.0.1]/a.png",
            "https://localhost/a.png",
        ] {
            assert!(
                tauri::async_runtime::block_on(f.fetch(url)).is_err(),
                "{url}"
            );
        }
    }
}

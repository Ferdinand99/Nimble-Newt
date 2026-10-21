//! Update decision logic. The Tauri updater plugin downloads and verifies the signature;
//! this module holds the parts worth testing without a webview: reading `latest.json`,
//! comparing versions and turning failures into messages a person can act on.

use semver::Version;
use serde::{Deserialize, Serialize};

pub const MANIFEST_URL: &str =
    "https://github.com/Ferdinand99/Nimble-Newt/releases/latest/download/latest.json";

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateDecision {
    UpToDate,
    Available {
        version: String,
        notes: String,
        date: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateErrorKind {
    Offline,
    InvalidSignature,
    NotConfigured,
    BadManifest,
    Other,
}

fn parse_version(s: &str) -> Result<Version, UpdateErrorKind> {
    Version::parse(s.trim().trim_start_matches('v')).map_err(|_| UpdateErrorKind::BadManifest)
}

/// True when `candidate` is strictly newer than `current` (pre-releases sort before releases).
pub fn is_newer(current: &str, candidate: &str) -> Result<bool, UpdateErrorKind> {
    Ok(parse_version(candidate)? > parse_version(current)?)
}

/// Decides what to tell the user given the running version and the raw `latest.json`.
pub fn decide(current: &str, manifest_json: &str) -> Result<UpdateDecision, UpdateErrorKind> {
    let m: Manifest =
        serde_json::from_str(manifest_json).map_err(|_| UpdateErrorKind::BadManifest)?;
    if is_newer(current, &m.version)? {
        Ok(UpdateDecision::Available {
            version: parse_version(&m.version)?.to_string(),
            notes: m.notes,
            date: m.pub_date,
        })
    } else {
        Ok(UpdateDecision::UpToDate)
    }
}

/// True when the configured updater public key is still the placeholder (or empty),
/// meaning this build was made before the owner set up update signing.
pub fn is_placeholder_key(pubkey: &str) -> bool {
    let k = pubkey.trim();
    k.is_empty() || k.starts_with("REPLACE_WITH")
}

/// Maps an error message from the updater plugin or the network stack to a category.
pub fn classify_error(message: &str) -> UpdateErrorKind {
    let m = message.to_ascii_lowercase();
    if m.contains("signature") || m.contains("minisign") || m.contains("public key") {
        UpdateErrorKind::InvalidSignature
    } else if [
        "error sending request",
        "dns",
        "connect",
        "timed out",
        "timeout",
        "network",
        "offline",
        "unreachable",
    ]
    .iter()
    .any(|k| m.contains(k))
    {
        UpdateErrorKind::Offline
    } else if m.contains("json")
        || m.contains("manifest")
        || m.contains("semver")
        || m.contains("version")
    {
        UpdateErrorKind::BadManifest
    } else {
        UpdateErrorKind::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: &str =
        r#"{"version":"v0.2.0","notes":"Fixes","pub_date":"2026-01-01T00:00:00Z","platforms":{}}"#;

    #[test]
    fn compares_versions_semantically() {
        assert!(is_newer("0.1.0", "0.2.0").unwrap());
        assert!(is_newer("0.9.0", "0.10.0").unwrap());
        assert!(is_newer("1.0.0-beta.1", "1.0.0").unwrap());
        assert!(!is_newer("1.0.0", "1.0.0-beta.1").unwrap());
        assert!(!is_newer("0.2.0", "0.2.0").unwrap());
        assert!(!is_newer("0.3.0", "0.2.9").unwrap());
        assert!(is_newer("0.1.0", "v0.1.1").unwrap());
    }

    #[test]
    fn new_update_is_reported_with_notes() {
        match decide("0.1.0", M).unwrap() {
            UpdateDecision::Available {
                version,
                notes,
                date,
            } => {
                assert_eq!(version, "0.2.0");
                assert_eq!(notes, "Fixes");
                assert!(date.is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn no_update_when_current_or_ahead() {
        assert_eq!(decide("0.2.0", M).unwrap(), UpdateDecision::UpToDate);
        assert_eq!(decide("0.3.0", M).unwrap(), UpdateDecision::UpToDate);
    }

    #[test]
    fn broken_manifest_is_an_error() {
        assert_eq!(decide("0.1.0", "<html>"), Err(UpdateErrorKind::BadManifest));
        assert_eq!(
            decide("0.1.0", r#"{"version":"abc"}"#),
            Err(UpdateErrorKind::BadManifest)
        );
        assert_eq!(decide("zzz", M), Err(UpdateErrorKind::BadManifest));
    }

    #[test]
    fn placeholder_key_is_detected() {
        assert!(is_placeholder_key(
            "REPLACE_WITH_PUBLIC_KEY_SEE_docs/updates.md"
        ));
        assert!(is_placeholder_key("  "));
        assert!(!is_placeholder_key(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0Q="
        ));
    }

    #[test]
    fn classifies_errors() {
        assert_eq!(
            classify_error("the update signature could not be verified"),
            UpdateErrorKind::InvalidSignature
        );
        assert_eq!(
            classify_error("Minisign error: invalid public key"),
            UpdateErrorKind::InvalidSignature
        );
        assert_eq!(
            classify_error("error sending request for url (https://github.com/...)"),
            UpdateErrorKind::Offline
        );
        assert_eq!(
            classify_error("dns error: failed to lookup address"),
            UpdateErrorKind::Offline
        );
        assert_eq!(
            classify_error("expected value at line 1 json"),
            UpdateErrorKind::BadManifest
        );
        assert_eq!(classify_error("disk full"), UpdateErrorKind::Other);
    }
}

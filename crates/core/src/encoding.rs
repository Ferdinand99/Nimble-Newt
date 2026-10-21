//! Character-encoding detection, decoding and encoding.

use crate::eol::{self, Eol};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    #[serde(rename = "UTF-8")]
    Utf8,
    #[serde(rename = "UTF-8 BOM")]
    Utf8Bom,
    #[serde(rename = "UTF-16 LE")]
    Utf16Le,
    #[serde(rename = "UTF-16 BE")]
    Utf16Be,
    #[serde(rename = "Windows-1252")]
    Windows1252,
}

impl TextEncoding {
    pub fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Utf8Bom => "UTF-8 BOM",
            TextEncoding::Utf16Le => "UTF-16 LE",
            TextEncoding::Utf16Be => "UTF-16 BE",
            TextEncoding::Windows1252 => "Windows-1252",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Decoded {
    pub text: String,
    pub encoding: TextEncoding,
    /// Dominant line ending of the original bytes, `None` for single-line files.
    pub eol: Option<Eol>,
    /// True when some bytes could not be decoded and were replaced with U+FFFD.
    pub lossy: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    /// True when some characters had no representation in the target encoding.
    pub lossy: bool,
}

const BOM_UTF8: &[u8] = &[0xEF, 0xBB, 0xBF];
const BOM_UTF16_LE: &[u8] = &[0xFF, 0xFE];
const BOM_UTF16_BE: &[u8] = &[0xFE, 0xFF];

/// Guesses the encoding of `bytes`: BOM first, then valid UTF-8, then BOM-less UTF-16
/// (many NULs), and finally a statistical guess that is narrowed to Windows-1252.
pub fn detect(bytes: &[u8]) -> TextEncoding {
    if bytes.starts_with(BOM_UTF8) {
        return TextEncoding::Utf8Bom;
    }
    if bytes.starts_with(BOM_UTF16_LE) {
        return TextEncoding::Utf16Le;
    }
    if bytes.starts_with(BOM_UTF16_BE) {
        return TextEncoding::Utf16Be;
    }
    if let Some(e) = sniff_utf16_without_bom(bytes) {
        return e;
    }
    if std::str::from_utf8(bytes).is_ok() {
        return TextEncoding::Utf8;
    }
    // Truncated multi-byte sequence at the end of a sampled prefix still counts as UTF-8.
    if let Err(e) = std::str::from_utf8(bytes) {
        if e.error_len().is_none() && std::str::from_utf8(&bytes[..e.valid_up_to()]).is_ok() {
            return TextEncoding::Utf8;
        }
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let guess = det.guess(None, true);
    if guess == encoding_rs::UTF_16LE {
        TextEncoding::Utf16Le
    } else if guess == encoding_rs::UTF_16BE {
        TextEncoding::Utf16Be
    } else {
        TextEncoding::Windows1252
    }
}

fn sniff_utf16_without_bom(bytes: &[u8]) -> Option<TextEncoding> {
    let sample = &bytes[..bytes.len().min(4096) & !1];
    if sample.len() < 4 {
        return None;
    }
    let (mut even_nul, mut odd_nul) = (0usize, 0usize);
    for (i, b) in sample.iter().enumerate() {
        if *b == 0 {
            if i.is_multiple_of(2) {
                even_nul += 1;
            } else {
                odd_nul += 1;
            }
        }
    }
    let pairs = sample.len() / 2;
    // ASCII-heavy UTF-16 has a NUL in every other byte.
    if odd_nul * 10 > pairs * 7 && even_nul * 20 < pairs {
        Some(TextEncoding::Utf16Le)
    } else if even_nul * 10 > pairs * 7 && odd_nul * 20 < pairs {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    }
}

/// Decodes `bytes` with an explicit encoding, stripping a matching BOM.
pub fn decode_as(bytes: &[u8], enc: TextEncoding) -> (String, bool) {
    match enc {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            let body = bytes.strip_prefix(BOM_UTF8).unwrap_or(bytes);
            match String::from_utf8_lossy(body) {
                std::borrow::Cow::Borrowed(s) => (s.to_owned(), false),
                std::borrow::Cow::Owned(s) => (s, true),
            }
        }
        TextEncoding::Utf16Le => {
            let body = bytes.strip_prefix(BOM_UTF16_LE).unwrap_or(bytes);
            decode_utf16(body, u16::from_le_bytes)
        }
        TextEncoding::Utf16Be => {
            let body = bytes.strip_prefix(BOM_UTF16_BE).unwrap_or(bytes);
            decode_utf16(body, u16::from_be_bytes)
        }
        TextEncoding::Windows1252 => {
            let (s, _, had_errors) = encoding_rs::WINDOWS_1252.decode(bytes);
            (s.into_owned(), had_errors)
        }
    }
}

fn decode_utf16(body: &[u8], read: fn([u8; 2]) -> u16) -> (String, bool) {
    let (pairs, rest) = body.as_chunks::<2>();
    let units = pairs.iter().map(|c| read(*c));
    let mut lossy = !rest.is_empty();
    let mut out = String::with_capacity(body.len() / 2);
    for r in char::decode_utf16(units) {
        match r {
            Ok(c) => out.push(c),
            Err(_) => {
                lossy = true;
                out.push('\u{FFFD}');
            }
        }
    }
    (out, lossy)
}

/// Detects the encoding and decodes in one step.
pub fn decode(bytes: &[u8]) -> Decoded {
    let encoding = detect(bytes);
    let (text, lossy) = decode_as(bytes, encoding);
    Decoded {
        eol: eol::detect(&text),
        text,
        encoding,
        lossy,
    }
}

/// Encodes `text` (written with whatever line endings it already has).
pub fn encode(text: &str, enc: TextEncoding) -> Encoded {
    match enc {
        TextEncoding::Utf8 => Encoded {
            bytes: text.as_bytes().to_vec(),
            lossy: false,
        },
        TextEncoding::Utf8Bom => {
            let mut bytes = Vec::with_capacity(text.len() + 3);
            bytes.extend_from_slice(BOM_UTF8);
            bytes.extend_from_slice(text.as_bytes());
            Encoded {
                bytes,
                lossy: false,
            }
        }
        TextEncoding::Utf16Le => encode_utf16(text, BOM_UTF16_LE, u16::to_le_bytes),
        TextEncoding::Utf16Be => encode_utf16(text, BOM_UTF16_BE, u16::to_be_bytes),
        TextEncoding::Windows1252 => {
            let mut bytes = Vec::with_capacity(text.len());
            let mut lossy = false;
            let mut buf = [0u8; 4];
            for c in text.chars() {
                let s = c.encode_utf8(&mut buf);
                let (out, _, unmappable) = encoding_rs::WINDOWS_1252.encode(s);
                if unmappable {
                    lossy = true;
                    bytes.push(b'?');
                } else {
                    bytes.extend_from_slice(&out);
                }
            }
            Encoded { bytes, lossy }
        }
    }
}

fn encode_utf16(text: &str, bom: &[u8], to: fn(u16) -> [u8; 2]) -> Encoded {
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.extend_from_slice(bom);
    for u in text.encode_utf16() {
        bytes.extend_from_slice(&to(u));
    }
    Encoded {
        bytes,
        lossy: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_boms() {
        assert_eq!(detect(b"\xEF\xBB\xBFhi"), TextEncoding::Utf8Bom);
        assert_eq!(detect(b"\xFF\xFEh\0i\0"), TextEncoding::Utf16Le);
        assert_eq!(detect(b"\xFE\xFF\0h\0i"), TextEncoding::Utf16Be);
    }

    #[test]
    fn detects_plain_utf8_and_ascii() {
        assert_eq!(detect(b"plain ascii"), TextEncoding::Utf8);
        assert_eq!(detect("blåbær – ok".as_bytes()), TextEncoding::Utf8);
        assert_eq!(detect(b""), TextEncoding::Utf8);
    }

    #[test]
    fn truncated_utf8_tail_is_still_utf8() {
        let mut b = "abc æ".as_bytes().to_vec();
        b.pop();
        assert_eq!(detect(&b), TextEncoding::Utf8);
    }

    #[test]
    fn detects_windows_1252() {
        // "blåbærsyltetøy" in Windows-1252
        let bytes = b"bl\xE5b\xE6rsyltet\xF8y med litt mer tekst i fila";
        assert_eq!(detect(bytes), TextEncoding::Windows1252);
        let d = decode(bytes);
        assert_eq!(d.text, "blåbærsyltetøy med litt mer tekst i fila");
        assert!(!d.lossy);
    }

    #[test]
    fn detects_utf16_without_bom() {
        let le: Vec<u8> = "hello world"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let be: Vec<u8> = "hello world"
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        assert_eq!(detect(&le), TextEncoding::Utf16Le);
        assert_eq!(detect(&be), TextEncoding::Utf16Be);
    }

    #[test]
    fn bom_is_stripped_on_decode() {
        assert_eq!(decode(b"\xEF\xBB\xBFabc").text, "abc");
        assert_eq!(decode(b"\xFF\xFEa\0b\0").text, "ab");
    }

    #[test]
    fn round_trips_every_encoding() {
        let text = "Hei på deg – 日本語? 😀\nlinje 2";
        for enc in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            let e = encode(text, enc);
            assert!(!e.lossy);
            let d = decode(&e.bytes);
            assert_eq!(d.text, text, "{enc:?}");
            assert_eq!(d.encoding, enc, "{enc:?}");
        }
    }

    #[test]
    fn windows_1252_round_trip_and_lossy() {
        let e = encode("æøå €", TextEncoding::Windows1252);
        assert!(!e.lossy);
        assert_eq!(decode_as(&e.bytes, TextEncoding::Windows1252).0, "æøå €");
        let lossy = encode("日本", TextEncoding::Windows1252);
        assert!(lossy.lossy);
        assert_eq!(lossy.bytes, b"??");
    }

    #[test]
    fn invalid_utf16_is_flagged() {
        let (s, lossy) = decode_as(&[0x00, 0xD8, 0x41, 0x00], TextEncoding::Utf16Le);
        assert!(lossy);
        assert!(s.contains('\u{FFFD}'));
    }

    #[test]
    fn decode_reports_eol() {
        assert_eq!(decode(b"a\r\nb").eol, Some(Eol::Crlf));
        assert_eq!(decode(b"single").eol, None);
    }

    #[test]
    fn serde_labels() {
        assert_eq!(
            serde_json::to_string(&TextEncoding::Utf8Bom).unwrap(),
            "\"UTF-8 BOM\""
        );
        let e: TextEncoding = serde_json::from_str("\"UTF-16 LE\"").unwrap();
        assert_eq!(e, TextEncoding::Utf16Le);
    }
}

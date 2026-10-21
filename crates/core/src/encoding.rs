//! Character-encoding detection, decoding and encoding.
//!
//! Unicode encodings are handled by hand (UTF-16 has no encoder in `encoding_rs`, and we want explicit
//! control over BOMs); everything else comes from `encoding_rs`'s legacy code pages.

use crate::eol::{self, Eol};
use encoding_rs::Encoding;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    /// A legacy code page: ISO-8859-x, Windows-125x, KOI8, Shift_JIS, EUC-KR, GBK, Big5 and so on.
    Legacy(&'static Encoding),
}

#[allow(non_upper_case_globals)]
impl TextEncoding {
    pub const Windows1252: TextEncoding = TextEncoding::Legacy(encoding_rs::WINDOWS_1252);

    /// The name shown to the user and stored in sessions and settings.
    pub fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Utf8Bom => "UTF-8 BOM",
            TextEncoding::Utf16Le => "UTF-16 LE",
            TextEncoding::Utf16Be => "UTF-16 BE",
            TextEncoding::Legacy(e) => legacy_label(e),
        }
    }

    /// Parses a label from `label()` or any WHATWG encoding label (case-insensitive).
    pub fn from_label(label: &str) -> Option<TextEncoding> {
        let l = label.trim();
        for e in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            if e.label().eq_ignore_ascii_case(l) {
                return Some(e);
            }
        }
        let enc = Encoding::for_label(l.as_bytes())?;
        SUPPORTED
            .contains(&enc)
            .then_some(TextEncoding::Legacy(enc))
    }

    pub fn group(self) -> &'static str {
        match self {
            TextEncoding::Legacy(e) => legacy_group(e),
            _ => "Unicode",
        }
    }
}

impl Serialize for TextEncoding {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.label())
    }
}

impl<'de> Deserialize<'de> for TextEncoding {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        TextEncoding::from_label(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown encoding: {s}")))
    }
}

/// Code pages offered in the UI. (Encodings whose output is not themselves, i.e. UTF-16 and
/// `replacement`, are excluded.)
static SUPPORTED: &[&Encoding] = &[
    encoding_rs::WINDOWS_1252,
    encoding_rs::ISO_8859_15,
    encoding_rs::MACINTOSH,
    encoding_rs::WINDOWS_1250,
    encoding_rs::ISO_8859_2,
    encoding_rs::ISO_8859_4,
    encoding_rs::ISO_8859_10,
    encoding_rs::ISO_8859_13,
    encoding_rs::ISO_8859_14,
    encoding_rs::ISO_8859_16,
    encoding_rs::ISO_8859_3,
    encoding_rs::WINDOWS_1251,
    encoding_rs::ISO_8859_5,
    encoding_rs::KOI8_R,
    encoding_rs::KOI8_U,
    encoding_rs::IBM866,
    encoding_rs::X_MAC_CYRILLIC,
    encoding_rs::WINDOWS_1253,
    encoding_rs::ISO_8859_7,
    encoding_rs::WINDOWS_1254,
    encoding_rs::WINDOWS_1255,
    encoding_rs::ISO_8859_8,
    encoding_rs::ISO_8859_8_I,
    encoding_rs::WINDOWS_1256,
    encoding_rs::ISO_8859_6,
    encoding_rs::WINDOWS_1257,
    encoding_rs::WINDOWS_1258,
    encoding_rs::WINDOWS_874,
    encoding_rs::SHIFT_JIS,
    encoding_rs::EUC_JP,
    encoding_rs::ISO_2022_JP,
    encoding_rs::EUC_KR,
    encoding_rs::GBK,
    encoding_rs::GB18030,
    encoding_rs::BIG5,
];

fn legacy_label(e: &'static Encoding) -> &'static str {
    match e.name() {
        "windows-1250" => "Windows-1250",
        "windows-1251" => "Windows-1251",
        "windows-1252" => "Windows-1252",
        "windows-1253" => "Windows-1253",
        "windows-1254" => "Windows-1254",
        "windows-1255" => "Windows-1255",
        "windows-1256" => "Windows-1256",
        "windows-1257" => "Windows-1257",
        "windows-1258" => "Windows-1258",
        "windows-874" => "Windows-874",
        other => other,
    }
}

fn legacy_group(e: &'static Encoding) -> &'static str {
    match e.name() {
        "windows-1252" | "ISO-8859-15" | "macintosh" | "ISO-8859-10" | "ISO-8859-14" => {
            "Western European"
        }
        "windows-1250" | "ISO-8859-2" | "ISO-8859-4" | "ISO-8859-13" | "ISO-8859-16"
        | "windows-1257" | "ISO-8859-3" => "Central and Baltic",
        "windows-1251" | "ISO-8859-5" | "KOI8-R" | "KOI8-U" | "IBM866" | "x-mac-cyrillic" => {
            "Cyrillic"
        }
        "windows-1253" | "ISO-8859-7" => "Greek",
        "windows-1254" => "Turkish",
        "windows-1255" | "ISO-8859-8" | "ISO-8859-8-I" | "windows-1256" | "ISO-8859-6" => {
            "Hebrew and Arabic"
        }
        "windows-1258" | "windows-874" => "Southeast Asian",
        _ => "East Asian",
    }
}

/// Every encoding the editor can read and write, in display order.
pub fn all() -> Vec<TextEncoding> {
    let mut v = vec![
        TextEncoding::Utf8,
        TextEncoding::Utf8Bom,
        TextEncoding::Utf16Le,
        TextEncoding::Utf16Be,
    ];
    v.extend(SUPPORTED.iter().map(|e| TextEncoding::Legacy(e)));
    v
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
/// How much of a file the statistical detector looks at.
const DETECT_LIMIT: usize = 1 << 20;

/// Guesses the encoding of `bytes`: BOM, then ISO-2022-JP escapes, valid UTF-8, BOM-less UTF-16
/// (many NULs), and finally a statistical guess (`chardetng`) restricted to the supported set.
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
    if looks_like_iso_2022_jp(bytes) {
        return TextEncoding::Legacy(encoding_rs::ISO_2022_JP);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return TextEncoding::Utf8;
    }
    // A multi-byte sequence cut off at the end of the file still counts as UTF-8.
    if let Err(e) = std::str::from_utf8(bytes) {
        if e.error_len().is_none() && std::str::from_utf8(&bytes[..e.valid_up_to()]).is_ok() {
            return TextEncoding::Utf8;
        }
    }
    let sample = &bytes[..bytes.len().min(DETECT_LIMIT)];
    let mut det = chardetng::EncodingDetector::new();
    det.feed(sample, sample.len() == bytes.len());
    let (guess, confident) = det.guess_assess(None, false);
    if guess == encoding_rs::UTF_16LE {
        return TextEncoding::Utf16Le;
    }
    if guess == encoding_rs::UTF_16BE {
        return TextEncoding::Utf16Be;
    }
    if SUPPORTED.contains(&guess) {
        // Without real evidence, single-byte guesses are noise: Windows-1252 is the safest default.
        let multibyte = matches!(
            guess.name(),
            "Shift_JIS" | "EUC-JP" | "EUC-KR" | "GBK" | "gb18030" | "Big5"
        );
        if confident || multibyte {
            return TextEncoding::Legacy(guess);
        }
    }
    TextEncoding::Windows1252
}

fn looks_like_iso_2022_jp(bytes: &[u8]) -> bool {
    if bytes.iter().any(|b| *b >= 0x80) {
        return false;
    }
    bytes
        .windows(3)
        .any(|w| w == b"\x1b$B" || w == b"\x1b$@" || w == b"\x1b(J")
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
        TextEncoding::Legacy(e) => {
            // The user (or the detector) chose this encoding; a stray BOM must not override it.
            let (s, had_errors) = e.decode_without_bom_handling(bytes);
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
        TextEncoding::Legacy(e) => encode_legacy(text, e),
    }
}

/// Encodes with a legacy code page; characters it cannot represent become `?` and set `lossy`.
fn encode_legacy(text: &str, enc: &'static Encoding) -> Encoded {
    let mut encoder = enc.new_encoder();
    let mut bytes = Vec::with_capacity(text.len() + 16);
    let mut lossy = false;
    let mut rest = text;
    let mut buf = [0u8; 4096];
    loop {
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
        bytes.extend_from_slice(&buf[..written]);
        rest = &rest[read..];
        match result {
            encoding_rs::EncoderResult::InputEmpty => break,
            encoding_rs::EncoderResult::OutputFull => {}
            encoding_rs::EncoderResult::Unmappable(_) => {
                lossy = true;
                bytes.push(b'?');
            }
        }
    }
    Encoded { bytes, lossy }
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

    fn legacy(e: &'static Encoding) -> TextEncoding {
        TextEncoding::Legacy(e)
    }

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
    fn detects_east_asian_and_cyrillic_code_pages() {
        let cases: &[(&str, &'static Encoding)] = &[
            ("これは日本語のテキストファイルです。文字コードの自動判定を確認します。吾輩は猫である。名前はまだ無い。", encoding_rs::SHIFT_JIS),
            ("これは日本語のテキストファイルです。文字コードの自動判定を確認します。吾輩は猫である。名前はまだ無い。", encoding_rs::EUC_JP),
            ("한국어 텍스트 파일입니다. 문자 인코딩 자동 감지를 확인합니다. 안녕하세요, 여러분 반갑습니다.", encoding_rs::EUC_KR),
            ("这是一个中文文本文件。我们正在测试字符编码的自动检测功能。你好，世界，今天天气很好。", encoding_rs::GBK),
            ("這是一個中文文字檔案。我們正在測試字元編碼的自動偵測功能。你好，世界，今天天氣很好。", encoding_rs::BIG5),
            ("Это текстовый файл на русском языке. Проверяем автоматическое определение кодировки символов.", encoding_rs::WINDOWS_1251),
            ("Это текстовый файл на русском языке. Проверяем автоматическое определение кодировки символов.", encoding_rs::KOI8_R),
        ];
        for (text, enc) in cases {
            let bytes = encode(text, legacy(enc)).bytes;
            let got = detect(&bytes);
            // KOI8-R and KOI8-U differ only in a few Ukrainian letters; either is a correct reading.
            let koi8 = *enc == encoding_rs::KOI8_R && got == legacy(encoding_rs::KOI8_U);
            assert!(
                got == legacy(enc) || koi8,
                "{}: got {}",
                enc.name(),
                got.label()
            );
            assert_eq!(decode_as(&bytes, got).0, *text);
        }
    }

    #[test]
    fn detects_iso_2022_jp_escapes_in_seven_bit_text() {
        let bytes = encode("日本語のテキスト", legacy(encoding_rs::ISO_2022_JP)).bytes;
        assert!(bytes.iter().all(|b| *b < 0x80));
        assert_eq!(detect(&bytes), legacy(encoding_rs::ISO_2022_JP));
        assert_eq!(
            decode_as(&bytes, legacy(encoding_rs::ISO_2022_JP)).0,
            "日本語のテキスト"
        );
    }

    #[test]
    fn unsure_single_byte_guesses_fall_back_to_windows_1252() {
        // A couple of accented letters are not enough evidence for an exotic code page.
        assert_eq!(detect(b"caf\xE9 cr\xE8me"), TextEncoding::Windows1252);
    }

    #[test]
    fn explicit_encoding_ignores_a_stray_bom() {
        // Bytes that happen to start like a UTF-16 BOM must still be read as the chosen code page.
        let (s, _) = decode_as(&[0xFF, 0xFE, b'a'], TextEncoding::Windows1252);
        assert_eq!(s, "ÿþa");
    }

    #[test]
    fn bom_is_stripped_on_decode() {
        assert_eq!(decode(b"\xEF\xBB\xBFabc").text, "abc");
        assert_eq!(decode(b"\xFF\xFEa\0b\0").text, "ab");
    }

    #[test]
    fn round_trips_every_unicode_encoding() {
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
    fn every_listed_encoding_round_trips_ascii_and_has_a_stable_label() {
        for enc in all() {
            let e = encode("Hello, world 123\n", enc);
            assert!(!e.lossy, "{}", enc.label());
            assert_eq!(
                decode_as(&e.bytes, enc).0,
                "Hello, world 123\n",
                "{}",
                enc.label()
            );
            assert_eq!(
                TextEncoding::from_label(enc.label()),
                Some(enc),
                "{}",
                enc.label()
            );
            assert!(!enc.group().is_empty());
        }
        let labels: Vec<_> = all().iter().map(|e| e.label()).collect();
        let mut dedup = labels.clone();
        dedup.sort_unstable();
        dedup.dedup();
        assert_eq!(labels.len(), dedup.len(), "labels must be unique");
        assert!(labels.len() >= 35);
    }

    #[test]
    fn code_page_round_trips_with_native_text() {
        let cases: &[(&str, &'static Encoding)] = &[
            ("æøå ÆØÅ € ü", encoding_rs::WINDOWS_1252),
            ("æøå ÆØÅ € ü", encoding_rs::ISO_8859_15),
            ("zażółć gęślą jaźń", encoding_rs::ISO_8859_2),
            ("zażółć gęślą jaźń", encoding_rs::WINDOWS_1250),
            ("Привет, мир", encoding_rs::KOI8_R),
            ("Γειά σου κόσμε", encoding_rs::ISO_8859_7),
            ("Merhaba dünya ğış", encoding_rs::WINDOWS_1254),
            ("שלום עולם", encoding_rs::WINDOWS_1255),
            ("日本語テキスト", encoding_rs::SHIFT_JIS),
            ("한국어 텍스트", encoding_rs::EUC_KR),
            ("中文文本", encoding_rs::GB18030),
        ];
        for (text, enc) in cases {
            let e = encode(text, legacy(enc));
            assert!(!e.lossy, "{}", enc.name());
            assert_eq!(
                decode_as(&e.bytes, legacy(enc)),
                (text.to_string(), false),
                "{}",
                enc.name()
            );
        }
    }

    #[test]
    fn unmappable_characters_become_question_marks_and_are_reported() {
        let lossy = encode("日本", TextEncoding::Windows1252);
        assert!(lossy.lossy);
        assert_eq!(lossy.bytes, b"??");
        let partly = encode("aé日b", TextEncoding::Windows1252);
        assert!(partly.lossy);
        assert_eq!(partly.bytes, b"a\xE9?b");
        // A long input exercises the output-full loop.
        let long = "x日".repeat(5000);
        let e = encode(&long, TextEncoding::Windows1252);
        assert!(e.lossy);
        assert_eq!(e.bytes.len(), 10000);
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
    fn serde_labels_and_backward_compatible_names() {
        assert_eq!(
            serde_json::to_string(&TextEncoding::Utf8Bom).unwrap(),
            "\"UTF-8 BOM\""
        );
        assert_eq!(
            serde_json::to_string(&TextEncoding::Windows1252).unwrap(),
            "\"Windows-1252\""
        );
        let e: TextEncoding = serde_json::from_str("\"UTF-16 LE\"").unwrap();
        assert_eq!(e, TextEncoding::Utf16Le);
        // Written by version 0.1.0:
        let old: TextEncoding = serde_json::from_str("\"Windows-1252\"").unwrap();
        assert_eq!(old, TextEncoding::Windows1252);
        let sjis: TextEncoding = serde_json::from_str("\"shift_jis\"").unwrap();
        assert_eq!(sjis, legacy(encoding_rs::SHIFT_JIS));
        assert!(serde_json::from_str::<TextEncoding>("\"utf-32\"").is_err());
        assert!(serde_json::from_str::<TextEncoding>("\"nonsense\"").is_err());
    }
}

//! Line-ending detection and conversion.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
            Eol::Cr => "\r",
        }
    }

    pub fn platform_default() -> Eol {
        if cfg!(windows) {
            Eol::Crlf
        } else {
            Eol::Lf
        }
    }
}

/// Returns the dominant line ending, or `None` when the text has no line break.
/// A tie goes to the first style seen.
pub fn detect(text: &str) -> Option<Eol> {
    let b = text.as_bytes();
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut first: Option<Eol> = None;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' if b.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                first.get_or_insert(Eol::Crlf);
                i += 1;
            }
            b'\r' => {
                cr += 1;
                first.get_or_insert(Eol::Cr);
            }
            b'\n' => {
                lf += 1;
                first.get_or_insert(Eol::Lf);
            }
            _ => {}
        }
        i += 1;
    }
    let max = lf.max(crlf).max(cr);
    if max == 0 {
        return None;
    }
    let tied = |n: usize| n == max;
    match first {
        Some(Eol::Lf) if tied(lf) => Some(Eol::Lf),
        Some(Eol::Crlf) if tied(crlf) => Some(Eol::Crlf),
        Some(Eol::Cr) if tied(cr) => Some(Eol::Cr),
        _ if tied(lf) => Some(Eol::Lf),
        _ if tied(crlf) => Some(Eol::Crlf),
        _ => Some(Eol::Cr),
    }
}

/// Normalises every line break in `text` to `eol`.
pub fn convert(text: &str, eol: Eol) -> String {
    let target = eol.as_str();
    let mut out = String::with_capacity(text.len() + text.len() / 16);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str(target);
            }
            '\n' => out.push_str(target),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_each_style() {
        assert_eq!(detect("a\nb\nc"), Some(Eol::Lf));
        assert_eq!(detect("a\r\nb\r\n"), Some(Eol::Crlf));
        assert_eq!(detect("a\rb\rc"), Some(Eol::Cr));
        assert_eq!(detect("no breaks"), None);
        assert_eq!(detect(""), None);
    }

    #[test]
    fn mixed_picks_majority_then_first() {
        assert_eq!(detect("a\r\nb\r\nc\nd"), Some(Eol::Crlf));
        assert_eq!(detect("a\nb\r\nc"), Some(Eol::Lf));
        assert_eq!(detect("a\r\nb\nc"), Some(Eol::Crlf));
    }

    #[test]
    fn converts_between_styles() {
        assert_eq!(convert("a\r\nb\nc\rd", Eol::Lf), "a\nb\nc\nd");
        assert_eq!(convert("a\nb\n", Eol::Crlf), "a\r\nb\r\n");
        assert_eq!(convert("a\r\nb", Eol::Cr), "a\rb");
        assert_eq!(convert("", Eol::Crlf), "");
    }

    #[test]
    fn crlf_is_not_doubled() {
        assert_eq!(convert("a\r\n", Eol::Crlf), "a\r\n");
    }
}

//! User-defined language definitions (syntax highlighting rules) in JSON or TOML.
//!
//! Only literal delimiters and word lists are allowed, never regular expressions, so a
//! definition cannot cause catastrophic backtracking in the editor.

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const MAX_LIST: usize = 64;
pub const MAX_KEYWORDS: usize = 5000;
pub const MAX_WORD_LEN: usize = 64;
pub const MAX_COMMENT_TOKEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Toml,
}

impl Format {
    /// Picks the format from a file name or extension; anything but `.toml` is JSON.
    pub fn from_path(path: &str) -> Format {
        if path.to_ascii_lowercase().ends_with(".toml") {
            Format::Toml
        } else {
            Format::Json
        }
    }
}

impl std::str::FromStr for Format {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "json" => Ok(Format::Json),
            "toml" => Ok(Format::Toml),
            other => Err(bad(format!("unknown format \"{other}\""))),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Keywords {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyword: Vec<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Vec::is_empty")]
    pub type_: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub builtin: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub literal: Vec<String>,
}

impl Keywords {
    fn groups(&self) -> [(&'static str, &Vec<String>); 4] {
        [
            ("keyword", &self.keyword),
            ("type", &self.type_),
            ("builtin", &self.builtin),
            ("literal", &self.literal),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StringRule {
    pub start: String,
    pub end: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fold {
    pub start: String,
    pub end: String,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub filenames: Vec<String>,
    #[serde(default = "yes")]
    pub case_sensitive: bool,
    #[serde(default)]
    pub keywords: Keywords,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_comment: Option<(String, String)>,
    #[serde(default)]
    pub strings: Vec<StringRule>,
    #[serde(default = "yes")]
    pub numbers: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operators: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold: Option<Fold>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_chars: Option<String>,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::Msg(format!("invalid language definition: {}", msg.into()))
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn check_token(what: &str, s: &str, max: usize) -> Result<()> {
    let n = s.chars().count();
    if n == 0 || n > max {
        return Err(bad(format!("{what} must be 1-{max} characters")));
    }
    if s.chars().any(|c| c.is_control()) {
        return Err(bad(format!("{what} must not contain control characters")));
    }
    Ok(())
}

fn check_names(what: &str, list: &[String]) -> Result<()> {
    if list.len() > MAX_LIST {
        return Err(bad(format!("{what} has more than {MAX_LIST} entries")));
    }
    for e in list {
        if e.is_empty()
            || e.chars().count() > 64
            || e.chars().any(|c| c.is_control() || c == '/' || c == '\\')
        {
            return Err(bad(format!("{what} entry \"{e}\" is not valid")));
        }
    }
    Ok(())
}

impl LanguageDefinition {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.id) {
            return Err(bad("id must match ^[a-z][a-z0-9-]{0,31}$"));
        }
        let name_len = self.name.trim().chars().count();
        if !(1..=48).contains(&name_len) || self.name.chars().any(|c| c.is_control()) {
            return Err(bad("name must be 1-48 characters"));
        }
        check_names("extensions", &self.extensions)?;
        check_names("filenames", &self.filenames)?;
        if self.extensions.iter().any(|e| e.starts_with('.')) {
            return Err(bad("extensions are written without the leading dot"));
        }
        let mut total = 0;
        for (group, words) in self.keywords.groups() {
            total += words.len();
            for w in words {
                if w.is_empty()
                    || w.chars().count() > MAX_WORD_LEN
                    || w.chars().any(|c| c.is_whitespace() || c.is_control())
                {
                    return Err(bad(format!("keyword \"{w}\" in {group} is not valid")));
                }
            }
        }
        if total > MAX_KEYWORDS {
            return Err(bad(format!("more than {MAX_KEYWORDS} keywords")));
        }
        if let Some(c) = &self.line_comment {
            check_token("lineComment", c, MAX_COMMENT_TOKEN)?;
        }
        if let Some((a, b)) = &self.block_comment {
            check_token("blockComment open", a, MAX_COMMENT_TOKEN)?;
            check_token("blockComment close", b, MAX_COMMENT_TOKEN)?;
        }
        if self.strings.len() > MAX_LIST {
            return Err(bad(format!("more than {MAX_LIST} string rules")));
        }
        for s in &self.strings {
            check_token("string start", &s.start, 4)?;
            check_token("string end", &s.end, 4)?;
            if let Some(e) = &s.escape {
                check_token("string escape", e, 4)?;
            }
        }
        if let Some(o) = &self.operators {
            if o.chars().count() > 64 || o.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(bad("operators must be up to 64 non-space characters"));
            }
        }
        if let Some(f) = &self.fold {
            check_token("fold start", &f.start, 4)?;
            check_token("fold end", &f.end, 4)?;
        }
        if let Some(w) = &self.word_chars {
            if w.chars().count() > 32 || w.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(bad("wordChars must be up to 32 non-space characters"));
            }
        }
        Ok(())
    }
}

/// Parses and validates a definition. Input larger than 1 MiB is rejected.
pub fn parse_definition(text: &str, format: Format) -> Result<LanguageDefinition> {
    if text.len() > 1 << 20 {
        return Err(bad("file is larger than 1 MiB"));
    }
    let def: LanguageDefinition = match format {
        Format::Json => serde_json::from_str(text).map_err(|e| bad(e.to_string()))?,
        Format::Toml => toml::from_str(text).map_err(|e| bad(e.to_string()))?,
    };
    def.validate()?;
    Ok(def)
}

pub fn to_json(def: &LanguageDefinition) -> Result<String> {
    def.validate()?;
    Ok(serde_json::to_string_pretty(def)?)
}

pub fn to_toml(def: &LanguageDefinition) -> Result<String> {
    def.validate()?;
    toml::to_string_pretty(def).map_err(|e| bad(e.to_string()))
}

pub fn serialize(def: &LanguageDefinition, format: Format) -> Result<String> {
    match format {
        Format::Json => to_json(def),
        Format::Toml => to_toml(def),
    }
}

/// A commented example definition (TOML) that users can copy and edit.
pub fn starter_template() -> String {
    r##"# Nimble Newt language definition. Save as .toml or .json (same fields) and import it.
# Only literal text is allowed here, no regular expressions.
id = "mylang"                  # a-z, 0-9 and "-", starts with a letter
name = "My Language"
extensions = ["mylang", "ml2"] # without the leading dot
filenames = []                 # exact file names, e.g. ["Myfile"]
caseSensitive = true
numbers = true
lineComment = "//"
blockComment = ["/*", "*/"]
operators = "+-*/=<>!&|%^~?:"
wordChars = "_"                # extra characters allowed inside words

[keywords]
keyword = ["if", "else", "while", "for", "return"]
type = ["int", "string", "bool"]
builtin = ["print", "len"]
literal = ["true", "false", "null"]

[[strings]]
start = "\""
end = "\""
escape = "\\"

[[strings]]
start = "'"
end = "'"
escape = "\\"

[fold]
start = "{"
end = "}"
"##
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r##"{
        "id": "demo", "name": "Demo", "extensions": ["dm"], "filenames": ["Demofile"],
        "caseSensitive": false,
        "keywords": { "keyword": ["if", "else"], "type": ["int"], "builtin": ["print"], "literal": ["nil"] },
        "lineComment": "#", "blockComment": ["/*", "*/"],
        "strings": [{ "start": "\"", "end": "\"", "escape": "\\" }],
        "numbers": true, "operators": "+-*/", "fold": { "start": "{", "end": "}" }, "wordChars": "_"
    }"##;

    fn minimal() -> LanguageDefinition {
        parse_definition(r#"{"id":"a","name":"A"}"#, Format::Json).unwrap()
    }

    fn err(def: LanguageDefinition) -> String {
        def.validate().unwrap_err().to_string()
    }

    #[test]
    fn parses_valid_json() {
        let d = parse_definition(JSON, Format::Json).unwrap();
        assert_eq!(d.id, "demo");
        assert!(!d.case_sensitive);
        assert_eq!(d.keywords.type_, vec!["int"]);
        assert_eq!(d.block_comment, Some(("/*".into(), "*/".into())));
        assert_eq!(d.strings[0].escape.as_deref(), Some("\\"));
        assert_eq!(d.fold.as_ref().unwrap().end, "}");
    }

    #[test]
    fn defaults_apply() {
        let d = minimal();
        assert!(d.case_sensitive && d.numbers);
        assert!(d.extensions.is_empty() && d.strings.is_empty());
    }

    #[test]
    fn parses_valid_toml() {
        let t = "id = \"x\"\nname = \"X\"\nextensions = [\"x\"]\n[keywords]\nkeyword = [\"go\"]\n[[strings]]\nstart = \"'\"\nend = \"'\"\n";
        let d = parse_definition(t, Format::Toml).unwrap();
        assert_eq!(d.keywords.keyword, vec!["go"]);
        assert_eq!(d.strings.len(), 1);
    }

    #[test]
    fn round_trips_json_and_toml() {
        let d = parse_definition(JSON, Format::Json).unwrap();
        let t = to_toml(&d).unwrap();
        assert_eq!(parse_definition(&t, Format::Toml).unwrap(), d);
        let j = to_json(&d).unwrap();
        assert_eq!(parse_definition(&j, Format::Json).unwrap(), d);
        let via = parse_definition(
            &to_json(&parse_definition(&t, Format::Toml).unwrap()).unwrap(),
            Format::Json,
        )
        .unwrap();
        assert_eq!(via, d);
        assert!(j.contains("caseSensitive") && j.contains("lineComment"));
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["", "A", "1a", "a_b", "a b", &"a".repeat(33), "é"] {
            let mut d = minimal();
            d.id = id.into();
            assert!(err(d).contains("id"), "{id}");
        }
        let mut d = minimal();
        d.id = "a".repeat(32);
        assert!(d.validate().is_ok());
    }

    #[test]
    fn rejects_bad_names() {
        let mut d = minimal();
        d.name = "  ".into();
        assert!(err(d.clone()).contains("name"));
        d.name = "x".repeat(49);
        assert!(err(d.clone()).contains("name"));
        d.name = "x".repeat(48);
        assert!(d.validate().is_ok());
    }

    #[test]
    fn rejects_long_lists_and_bad_entries() {
        let mut d = minimal();
        d.extensions = (0..65).map(|i| format!("e{i}")).collect();
        assert!(err(d.clone()).contains("extensions"));
        d.extensions = vec![".rs".into()];
        assert!(err(d.clone()).contains("dot"));
        d.extensions = vec![];
        d.filenames = (0..65).map(|i| format!("f{i}")).collect();
        assert!(err(d.clone()).contains("filenames"));
        d.filenames = vec!["a/b".into()];
        assert!(err(d).contains("filenames"));
    }

    #[test]
    fn rejects_too_many_or_bad_keywords() {
        let mut d = minimal();
        d.keywords.keyword = (0..3000).map(|i| format!("k{i}")).collect();
        d.keywords.builtin = (0..2001).map(|i| format!("b{i}")).collect();
        assert!(err(d.clone()).contains("5000"));
        d.keywords.builtin = vec!["has space".into()];
        d.keywords.keyword = vec![];
        assert!(err(d).contains("builtin"));
    }

    #[test]
    fn rejects_bad_tokens() {
        let mut d = minimal();
        d.line_comment = Some("123456789".into());
        assert!(err(d.clone()).contains("lineComment"));
        d.line_comment = Some(String::new());
        assert!(err(d.clone()).contains("lineComment"));
        d.line_comment = None;
        d.block_comment = Some(("/*".into(), "x".repeat(9)));
        assert!(err(d.clone()).contains("blockComment"));
        d.block_comment = None;
        d.strings = vec![StringRule {
            start: "".into(),
            end: "\"".into(),
            escape: None,
        }];
        assert!(err(d.clone()).contains("string start"));
        d.strings = vec![StringRule {
            start: "\"".into(),
            end: "12345".into(),
            escape: None,
        }];
        assert!(err(d.clone()).contains("string end"));
        d.strings = vec![StringRule {
            start: "\"".into(),
            end: "\"".into(),
            escape: Some("abcde".into()),
        }];
        assert!(err(d.clone()).contains("escape"));
        d.strings = (0..65)
            .map(|_| StringRule {
                start: "'".into(),
                end: "'".into(),
                escape: None,
            })
            .collect();
        assert!(err(d.clone()).contains("string rules"));
        d.strings = vec![];
        d.fold = Some(Fold {
            start: "{{{{{".into(),
            end: "}".into(),
        });
        assert!(err(d.clone()).contains("fold"));
        d.fold = None;
        d.operators = Some("a b".into());
        assert!(err(d.clone()).contains("operators"));
        d.operators = None;
        d.word_chars = Some("x".repeat(33));
        assert!(err(d).contains("wordChars"));
    }

    #[test]
    fn rejects_unknown_fields_and_syntax_errors() {
        assert!(parse_definition(r#"{"id":"a","name":"A","regex":".*"}"#, Format::Json).is_err());
        assert!(parse_definition("{", Format::Json).is_err());
        assert!(parse_definition("id = ", Format::Toml).is_err());
        assert!(parse_definition(r#"{"name":"A"}"#, Format::Json).is_err());
        assert!(parse_definition(&" ".repeat((1 << 20) + 1), Format::Json).is_err());
    }

    #[test]
    fn template_parses_and_survives_round_trip() {
        let d = parse_definition(&starter_template(), Format::Toml).unwrap();
        assert_eq!(d.id, "mylang");
        assert_eq!(d.strings.len(), 2);
        assert_eq!(d.strings[0].escape.as_deref(), Some("\\"));
        let j = serialize(&d, Format::Json).unwrap();
        assert_eq!(parse_definition(&j, Format::Json).unwrap(), d);
    }

    #[test]
    fn format_helpers() {
        assert_eq!(Format::from_path("a/B.TOML"), Format::Toml);
        assert_eq!(Format::from_path("a.json"), Format::Json);
        assert_eq!("toml".parse::<Format>().unwrap(), Format::Toml);
        assert!("yaml".parse::<Format>().is_err());
    }
}

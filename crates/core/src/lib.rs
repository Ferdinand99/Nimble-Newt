//! Platform-independent logic for Nimble Newt: everything that can be tested without a webview.

pub mod encoding;
pub mod eol;
pub mod fileio;
pub mod search;
pub mod session;
pub mod update;
pub mod userlang;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Msg(String),
    #[error("{0} was changed by another program since it was opened")]
    Conflict(String),
    #[error("invalid pattern: {0}")]
    Pattern(String),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

//! Typed application error for the IPC boundary.
//!
//! Replaces the `Result<T, String>` shape every `#[tauri::command]` previously
//! returned. Goals:
//!
//!   - **JS sees structured errors.** Every error serializes to JSON of the
//!     shape `{ kind, message, ... }` so the frontend can branch on `kind` for
//!     special handling and display `message` directly to the user.
//!   - **`?` works for the common cases.** `From` impls for the IO surfaces
//!     (`rusqlite::Error`, `std::io::Error`, `anyhow::Error`) so command
//!     bodies don't need a `map_err` shim on every fallible call.
//!   - **Cheap to extend.** Adding a new variant doesn't break existing
//!     callers — they keep using the `?` operator and the variants that match.
//!
//! The `kind` tag is the contract with the frontend. Variant names land in JS
//! verbatim (via `#[serde(tag = "kind")]`); renaming one is a breaking API
//! change for any external consumer reading this surface.

use serde::Serialize;
use std::fmt;

/// IPC-facing error. Implements `Serialize` so Tauri can ship it across the
/// bridge, `Display` + `std::error::Error` so it's friendly to `anyhow` and
/// log formatting, and `From` for the IO error families so `?` works in
/// command bodies.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind")]
pub enum AppError {
    /// SQLite / rusqlite failures. Wrap with `AppError::db(e)` or use `?` via
    /// the `From<rusqlite::Error>` impl.
    Db { message: String },

    /// AI client failures (URL validation, HTTP transport, response decode).
    /// `validate_base_url` rejections land here.
    Ai { message: String },

    /// Filesystem / IO failures (book import, export, log writes).
    Io { message: String },

    /// Caller supplied bad input (empty selection, malformed locator, etc.).
    /// Frontend should usually surface `message` directly.
    Validation { message: String },

    /// Settings / configuration errors (bad export path, missing model id).
    Config { message: String },

    /// Resource lookup failed. `resource` is the type ("book", "section",
    /// "ai_request"); `id` is the requested identifier if known.
    NotFound {
        resource: String,
        id: Option<String>,
    },

    /// The reader enabled a cloud provider but hasn't confirmed the FIRST cloud
    /// send. The frontend catches this, shows a consent sheet naming `host`, and
    /// retries after cmd_confirm_cloud_send. (Epic C2.)
    NeedsCloudConsent { host: String },

    /// The reader's Throughline AI (company-paid) credits are spent. The frontend
    /// catches this and offers the BYO-key / local floor. (Company mode, CM3.)
    CapExhausted,

    /// Catch-all. Used by the `From<anyhow::Error>` impl for errors that
    /// haven't been classified into a more specific variant yet. Adding a
    /// specific variant later is non-breaking.
    Internal { message: String },
}

impl AppError {
    pub fn db(msg: impl Into<String>) -> Self {
        AppError::Db {
            message: msg.into(),
        }
    }
    pub fn ai(msg: impl Into<String>) -> Self {
        AppError::Ai {
            message: msg.into(),
        }
    }
    pub fn io(msg: impl Into<String>) -> Self {
        AppError::Io {
            message: msg.into(),
        }
    }
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation {
            message: msg.into(),
        }
    }
    pub fn config(msg: impl Into<String>) -> Self {
        AppError::Config {
            message: msg.into(),
        }
    }
    pub fn not_found(resource: impl Into<String>, id: impl Into<Option<String>>) -> Self {
        AppError::NotFound {
            resource: resource.into(),
            id: id.into(),
        }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal {
            message: msg.into(),
        }
    }
    pub fn needs_cloud_consent(host: impl Into<String>) -> Self {
        AppError::NeedsCloudConsent { host: host.into() }
    }
    pub fn cap_exhausted() -> Self {
        AppError::CapExhausted
    }

    /// Short, user-facing one-liner for log / UI display. Maps NotFound
    /// to a sensible string instead of exposing the JSON shape.
    pub fn user_message(&self) -> String {
        match self {
            AppError::Db { message } => message.clone(),
            AppError::Ai { message } => message.clone(),
            AppError::Io { message } => message.clone(),
            AppError::Validation { message } => message.clone(),
            AppError::Config { message } => message.clone(),
            AppError::Internal { message } => message.clone(),
            AppError::NotFound { resource, id } => match id {
                Some(id) => format!("{} not found: {}", resource, id),
                None => format!("{} not found", resource),
            },
            AppError::NeedsCloudConsent { host } => {
                format!("Confirm sending your selection to {host} before the first cloud call.")
            }
            AppError::CapExhausted => {
                "You've used your Throughline AI credits. Keep reading with your own API key, or switch to a local model.".to_string()
            }
        }
    }

    /// Kind tag (matches the JSON contract).
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Db { .. } => "Db",
            AppError::Ai { .. } => "Ai",
            AppError::Io { .. } => "Io",
            AppError::Validation { .. } => "Validation",
            AppError::Config { .. } => "Config",
            AppError::NotFound { .. } => "NotFound",
            AppError::NeedsCloudConsent { .. } => "NeedsCloudConsent",
            AppError::CapExhausted => "CapExhausted",
            AppError::Internal { .. } => "Internal",
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind(), self.user_message())
    }
}

impl std::error::Error for AppError {}

// ── From impls so `?` works ────────────────────────────────────────────

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db {
            message: e.to_string(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io {
            message: e.to_string(),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // `{:#}` flattens the anyhow chain so the user sees the proximate cause.
        AppError::Internal {
            message: format!("{:#}", e),
        }
    }
}

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, rusqlite::Connection>>> for AppError {
    fn from(e: std::sync::PoisonError<std::sync::MutexGuard<'_, rusqlite::Connection>>) -> Self {
        AppError::Internal {
            message: format!("mutex poisoned: {}", e),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal {
            message: format!("json: {}", e),
        }
    }
}

/// Wrap any `String` error into an `Internal` AppError. This is the fallback
/// impl that keeps the codebase compiling during the bulk conversion from
/// `Result<T, String>`. Sites that produce a bare String error are buying the
/// `Internal` classification; revisit them with `AppError::validation(...)`,
/// `AppError::not_found(...)`, etc. when their context becomes clear.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::Internal { message }
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::Internal {
            message: message.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_kind_tag() {
        let e = AppError::validation("empty selection");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "Validation");
        assert_eq!(json["message"], "empty selection");
    }

    #[test]
    fn not_found_carries_resource_and_id() {
        let e = AppError::not_found("book", Some("book_abc123".to_string()));
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "NotFound");
        assert_eq!(json["resource"], "book");
        assert_eq!(json["id"], "book_abc123");
    }

    #[test]
    fn not_found_id_optional() {
        let e = AppError::not_found("settings", None);
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "NotFound");
        assert_eq!(json["id"], serde_json::Value::Null);
    }

    #[test]
    fn rusqlite_error_converts_via_question_mark() {
        // Force a rusqlite error via an invalid query.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let r: Result<(), AppError> = (|| -> Result<(), AppError> {
            conn.execute("SELECT * FROM nonexistent_table", [])?;
            Ok(())
        })();
        assert!(matches!(r, Err(AppError::Db { .. })));
    }

    #[test]
    fn anyhow_error_converts_to_internal() {
        let r: Result<(), AppError> = {
            let e: anyhow::Error = anyhow::anyhow!("upstream failure");
            Err(e.into())
        };
        match r {
            Err(AppError::Internal { message }) => assert!(message.contains("upstream failure")),
            other => panic!("expected Internal, got {:?}", other),
        }
    }

    #[test]
    fn display_format_includes_kind_and_message() {
        let e = AppError::ai("local-only refused remote URL");
        let s = format!("{}", e);
        assert!(s.contains("Ai"));
        assert!(s.contains("local-only refused"));
    }
}

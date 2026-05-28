use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::paths;

pub const KEY_EXPORT_PATH: &str = "export_path";
pub const KEY_AI_BASE_URL: &str = "ai_base_url";
pub const KEY_AI_MODEL: &str = "ai_model";
pub const KEY_LOCAL_ONLY: &str = "ai_local_only";
pub const DEFAULT_AI_BASE_URL: &str = "http://localhost:1234/v1";
pub const DEFAULT_AI_MODEL: &str = "";
pub const QUOTE_WARN_TEXT: &str =
    "Fair use has no fixed safe word count. The default posture in ReadingGym is short quotes \
     for private study only. Quotes longer than ~300 characters are warned, not blocked.";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SettingsDto {
    /// User-selected Markdown export root (or the default).
    pub export_path: String,
    pub export_path_is_default: bool,
    /// Always the OS app-support path. Read-only display.
    pub app_data_path: String,
    /// "Local-only mode: ON" or "Local-only mode: OFF" — derived from local_only.
    pub ai_posture: String,
    /// AI base URL (default http://localhost:1234/v1). May point at any
    /// OpenAI-compatible endpoint, but is rejected at call time if it is
    /// non-loopback while local_only is true.
    pub ai_base_url: String,
    /// User-typed model name (e.g. "qwen2.5-7b-instruct"). Free-form.
    pub ai_model: String,
    /// HARD privacy invariant: when true, the client refuses any non-loopback URL.
    pub ai_local_only: bool,
    pub quote_policy: String,
    /// Quote warn threshold in characters. Surfaced so the settings UI shows
    /// the exact policy number, not just prose.
    pub quote_warn_chars: u64,
}

pub fn get_export_path(conn: &Connection) -> Result<PathBuf> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![KEY_EXPORT_PATH],
            |r| r.get(0),
        )
        .ok();
    match stored {
        Some(s) if !s.trim().is_empty() => Ok(PathBuf::from(s)),
        _ => Ok(paths::default_export_root()?),
    }
}

pub fn export_path_is_default(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![KEY_EXPORT_PATH],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.trim().is_empty())
    .is_none()
}

/// Validate a proposed export path. We never write the file system here —
/// just check that the path looks usable. Frontend should mkdir on save.
pub fn validate_export_path(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("export path cannot be empty"));
    }
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("no home dir to expand ~/"))?;
        home.join(rest)
    } else if trimmed == "~" {
        dirs::home_dir().ok_or_else(|| anyhow!("no home dir to expand ~"))?
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(anyhow!("export path must be absolute (got {:?})", expanded));
    }
    if expanded.exists() && expanded.is_file() {
        return Err(anyhow!("export path points at a file, not a directory: {:?}", expanded));
    }
    // Refuse to overwrite obvious system directories.
    let s = expanded.to_string_lossy().to_string();
    let banned = ["/", "/etc", "/System", "/Library", "/usr", "/bin", "/sbin", "/var"];
    if banned.iter().any(|b| s == *b) {
        return Err(anyhow!("refusing to use {} as the export root", s));
    }
    Ok(expanded)
}

pub fn set_export_path(conn: &Connection, raw: &str) -> Result<PathBuf> {
    let expanded = validate_export_path(raw)?;
    if !expanded.exists() {
        std::fs::create_dir_all(&expanded)?;
    }
    // Create the canonical Markdown subdirs so the user can write right away.
    for sub in ["Books", "Sessions", "Notes", "Reviews", "_indexes"] {
        let _ = std::fs::create_dir_all(expanded.join(sub));
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![KEY_EXPORT_PATH, expanded.to_string_lossy().to_string()],
    )?;
    Ok(expanded)
}

pub fn get_string(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.is_empty())
}

pub fn set_string(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_local_only(conn: &Connection) -> bool {
    // Default ON. The flag is stored as a string ("true"/"false") so it shares
    // the same key/value table as the others.
    match get_string(conn, KEY_LOCAL_ONLY).as_deref() {
        Some("false") => false,
        _ => true,
    }
}

pub fn get_ai_base_url(conn: &Connection) -> String {
    get_string(conn, KEY_AI_BASE_URL).unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string())
}

pub fn get_ai_model(conn: &Connection) -> String {
    get_string(conn, KEY_AI_MODEL).unwrap_or_else(|| DEFAULT_AI_MODEL.to_string())
}

pub fn build_dto(conn: &Connection) -> Result<SettingsDto> {
    let export = get_export_path(conn)?;
    let local_only = get_local_only(conn);
    Ok(SettingsDto {
        export_path: export.to_string_lossy().to_string(),
        export_path_is_default: export_path_is_default(conn),
        app_data_path: paths::app_support_dir()?.to_string_lossy().to_string(),
        ai_posture: if local_only { "Local-only mode: ON".to_string() } else { "Local-only mode: OFF".to_string() },
        ai_base_url: get_ai_base_url(conn),
        ai_model: get_ai_model(conn),
        ai_local_only: local_only,
        quote_policy: QUOTE_WARN_TEXT.to_string(),
        quote_warn_chars: 300,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_path() {
        assert!(validate_export_path("").is_err());
        assert!(validate_export_path("   ").is_err());
    }

    #[test]
    fn rejects_relative_path() {
        let r = validate_export_path("relative/path");
        assert!(r.is_err(), "must reject relative paths");
    }

    #[test]
    fn rejects_dangerous_roots() {
        assert!(validate_export_path("/").is_err());
        assert!(validate_export_path("/etc").is_err());
        assert!(validate_export_path("/System").is_err());
    }

    #[test]
    fn expands_tilde() {
        let r = validate_export_path("~/SomeExport/Reading").unwrap();
        assert!(r.is_absolute());
        let s = r.to_string_lossy().to_string();
        assert!(s.contains("SomeExport/Reading"));
        assert!(!s.contains("~"));
    }

    #[test]
    fn accepts_absolute_path() {
        let r = validate_export_path("/tmp/readinggym_test_settings_path").unwrap();
        assert!(r.is_absolute());
    }
}

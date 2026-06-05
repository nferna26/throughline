use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::paths;

pub const KEY_EXPORT_PATH: &str = "export_path";
pub const KEY_AI_BASE_URL: &str = "ai_base_url";
pub const KEY_AI_MODEL: &str = "ai_model";
pub const KEY_LOCAL_ONLY: &str = "ai_local_only";
pub const KEY_AI_RETENTION_DAYS: &str = "ai_requests_retention_days";
pub const KEY_READING_RHYTHM_MINUTES: &str = "reading_rhythm_minutes";
pub const KEY_MARGIN_HELP: &str = "margin_help";
// Cloud-AI provider selection (added with the opt-in cloud providers). The
// `ai_provider` value is AUTHORITATIVE for which AI surface runs; absence means
// the reader hasn't chosen yet → onboarding. `ai_local_only` is kept only for
// back-compat reads. Per-provider model ids let each provider remember its own
// default. API keys are NOT here — they live in the Keychain (see keystore.rs).
pub const KEY_AI_PROVIDER: &str = "ai_provider";
pub const KEY_AI_PROVIDER_CHOSEN_AT: &str = "ai_provider_chosen_at";
pub const KEY_AI_MODEL_OPENAI: &str = "ai_model_openai";
pub const KEY_AI_MODEL_ANTHROPIC: &str = "ai_model_anthropic";
pub const KEY_AI_MODEL_CODEX: &str = "ai_model_codex";
// Non-secret "a key is stored" markers. They mirror Keychain state so the UI can
// show "key present" WITHOUT reading (decrypting) the secret on every launch —
// reading the Keychain is what triggers the macOS authorization prompt. Written
// whenever a key/credential is saved or cleared; seeded once from the Keychain
// the first time they're read (see key_present_seeded). The secret itself is
// still ONLY in the Keychain — these hold a boolean, never the key.
pub const KEY_AI_KEY_PRESENT_OPENAI: &str = "ai_key_present_openai";
pub const KEY_AI_KEY_PRESENT_ANTHROPIC: &str = "ai_key_present_anthropic";
pub const KEY_CODEX_CREDS_PRESENT: &str = "ai_codex_creds_present";
pub const DEFAULT_AI_BASE_URL: &str = "http://localhost:1234/v1";
pub const DEFAULT_AI_MODEL: &str = "";
/// Best-model defaults at time of writing; the user can override, and the
/// connection test self-selects the newest from the live model list.
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-5.5";
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-4-8";
pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.5";

/// Which AI surface the reader chose. `None` means not yet chosen (run
/// onboarding); `Disabled` means they explicitly declined AI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiProvider {
    Local,
    OpenAi,
    Anthropic,
    Codex,
    Disabled,
    Unset,
}

impl AiProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            AiProvider::Local => "local",
            AiProvider::OpenAi => "openai",
            AiProvider::Anthropic => "anthropic",
            AiProvider::Codex => "codex",
            AiProvider::Disabled => "none",
            AiProvider::Unset => "",
        }
    }
    pub fn from_str(s: &str) -> AiProvider {
        match s.trim() {
            "local" => AiProvider::Local,
            "openai" => AiProvider::OpenAi,
            "anthropic" => AiProvider::Anthropic,
            "codex" => AiProvider::Codex,
            "none" => AiProvider::Disabled,
            _ => AiProvider::Unset,
        }
    }
    /// True for the cloud providers that send the selection off-device.
    pub fn is_remote(self) -> bool {
        matches!(
            self,
            AiProvider::OpenAi | AiProvider::Anthropic | AiProvider::Codex
        )
    }
    /// The remote host the selection is sent to, for the cloud providers. None
    /// for on-device/unset providers. Mirrors `provider_host` in `commands::ai`.
    pub fn remote_host(self) -> Option<&'static str> {
        match self {
            AiProvider::OpenAi => Some("api.openai.com"),
            AiProvider::Anthropic => Some("api.anthropic.com"),
            AiProvider::Codex => Some("chatgpt.com"),
            _ => None,
        }
    }
}
/// Default length of a planned reading sitting, in minutes (the "Reading rhythm"
/// the Book Setup Sheet defaults to). Surfaced as "Start N-minute session".
pub const DEFAULT_RHYTHM_MINUTES: i64 = 25;
/// How present the Companion Margin's AI help is by default. "quiet" keeps the
/// margin out of the way until summoned; "guided" surfaces gentle affordances;
/// "deep_study" leans in with study-oriented prompts ready in the margin.
pub const DEFAULT_MARGIN_HELP: &str = "guided";
/// The recognised margin-help levels, least → most present.
pub const MARGIN_HELP_LEVELS: [&str; 3] = ["quiet", "guided", "deep_study"];
pub const QUOTE_WARN_TEXT: &str =
    "Fair use has no fixed safe word count. The default posture in Throughline is short quotes \
     for private study only. Quotes longer than ~300 characters are warned, not blocked.";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SettingsDto {
    /// User-selected Markdown export root (or the default).
    pub export_path: String,
    pub export_path_is_default: bool,
    /// Always the OS app-support path. Read-only display.
    pub app_data_path: String,
    /// Human label for the real send target, derived from the AUTHORITATIVE
    /// `ai_provider` (NOT from `local_only`) so it can never contradict where a
    /// request actually goes: an on-device label for local/unset/disabled, and a
    /// "sends to <host>" label for a cloud provider.
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
    /// AI audit retention window in days (adr-001). Rows older than this that
    /// never became a note are swept on launch. 0 disables the sweep.
    pub ai_requests_retention_days: i64,
    /// Margin-help mode ("quiet" | "guided" | "deep_study"). Drives how present
    /// the Companion Margin is in the reader (Deep Study prepares a section
    /// briefing on session start; see TextReader).
    pub margin_help: String,
    // ── Cloud AI providers ──
    /// Chosen provider: "local" | "openai" | "anthropic" | "codex" | "none" | ""
    /// (empty = not chosen yet → onboarding). AUTHORITATIVE over ai_local_only.
    pub ai_provider: String,
    /// True once onboarding has made a choice (provider is non-empty).
    pub ai_provider_chosen: bool,
    /// True when a cloud provider was explicitly chosen (selection leaves the
    /// device). The reader cards key their "via <Provider>" disclosure on this.
    pub ai_remote_allowed: bool,
    /// Per-provider model ids (defaults applied). Cloud keys are NEVER included.
    pub ai_model_openai: String,
    pub ai_model_anthropic: String,
    pub ai_model_codex: String,
    /// Whether an API key is stored for each cloud provider (booleans only — the
    /// key itself never leaves the Keychain).
    pub ai_key_present_openai: bool,
    pub ai_key_present_anthropic: bool,
    /// Whether usable Codex-login credentials exist on disk (~/.codex/auth.json).
    pub ai_codex_creds_present: bool,
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
        return Err(anyhow!(
            "export path points at a file, not a directory: {:?}",
            expanded
        ));
    }
    // Refuse to overwrite obvious system directories.
    let s = expanded.to_string_lossy().to_string();
    let banned = [
        "/", "/etc", "/System", "/Library", "/usr", "/bin", "/sbin", "/var",
    ];
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
    !matches!(get_string(conn, KEY_LOCAL_ONLY).as_deref(), Some("false"))
}

pub fn get_ai_base_url(conn: &Connection) -> String {
    get_string(conn, KEY_AI_BASE_URL).unwrap_or_else(|| DEFAULT_AI_BASE_URL.to_string())
}

pub fn get_ai_model(conn: &Connection) -> String {
    get_string(conn, KEY_AI_MODEL).unwrap_or_else(|| DEFAULT_AI_MODEL.to_string())
}

/// The chosen AI provider (authoritative). `Unset` until onboarding picks one.
pub fn get_ai_provider(conn: &Connection) -> AiProvider {
    match get_string(conn, KEY_AI_PROVIDER) {
        Some(s) => AiProvider::from_str(&s),
        None => AiProvider::Unset,
    }
}

/// Whether onboarding's AI choice has been made (provider set to anything,
/// including an explicit "none").
pub fn get_ai_provider_chosen(conn: &Connection) -> bool {
    !matches!(get_ai_provider(conn), AiProvider::Unset)
}

/// Persist the model id for a given provider. No-op for Disabled/Unset.
pub fn set_ai_model_for(conn: &Connection, provider: AiProvider, model: &str) -> Result<()> {
    let key = match provider {
        AiProvider::Local => KEY_AI_MODEL,
        AiProvider::OpenAi => KEY_AI_MODEL_OPENAI,
        AiProvider::Anthropic => KEY_AI_MODEL_ANTHROPIC,
        AiProvider::Codex => KEY_AI_MODEL_CODEX,
        AiProvider::Disabled | AiProvider::Unset => return Ok(()),
    };
    set_string(conn, key, model.trim())
}

/// The model id for a given provider, falling back to that provider's default.
pub fn get_ai_model_for(conn: &Connection, provider: AiProvider) -> String {
    let (key, default) = match provider {
        AiProvider::Local => (KEY_AI_MODEL, DEFAULT_AI_MODEL),
        AiProvider::OpenAi => (KEY_AI_MODEL_OPENAI, DEFAULT_OPENAI_MODEL),
        AiProvider::Anthropic => (KEY_AI_MODEL_ANTHROPIC, DEFAULT_ANTHROPIC_MODEL),
        AiProvider::Codex => (KEY_AI_MODEL_CODEX, DEFAULT_CODEX_MODEL),
        AiProvider::Disabled | AiProvider::Unset => return String::new(),
    };
    get_string(conn, key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// AI audit retention window in days. Defaults to `DEFAULT_RETENTION_DAYS` (90).
/// A non-positive stored value means "keep everything" (sweep disabled).
pub fn get_ai_retention_days(conn: &Connection) -> i64 {
    get_string(conn, KEY_AI_RETENTION_DAYS)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(crate::ai_retention::DEFAULT_RETENTION_DAYS)
}

/// Planned length of a normal reading sitting, in minutes. Surfaced on the Today
/// action card ("Start N-minute session") and written by the Book Setup Sheet.
/// Defaults to `DEFAULT_RHYTHM_MINUTES` (25); clamped to a humane 5..=120 so a
/// stray value can never produce an absurd button.
pub fn get_reading_rhythm_minutes(conn: &Connection) -> i64 {
    get_string(conn, KEY_READING_RHYTHM_MINUTES)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(|n| n.clamp(5, 120))
        .unwrap_or(DEFAULT_RHYTHM_MINUTES)
}

/// Margin-help preference ("quiet" | "guided" | "deep_study"). Defaults to
/// `DEFAULT_MARGIN_HELP`. Any unrecognised stored value falls back to the
/// default rather than erroring.
pub fn get_margin_help(conn: &Connection) -> String {
    match get_string(conn, KEY_MARGIN_HELP) {
        Some(v) if MARGIN_HELP_LEVELS.contains(&v.as_str()) => v,
        _ => DEFAULT_MARGIN_HELP.to_string(),
    }
}

/// The presence-flag key for a provider that stores an API key, or None.
fn key_present_flag(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some(KEY_AI_KEY_PRESENT_OPENAI),
        "anthropic" => Some(KEY_AI_KEY_PRESENT_ANTHROPIC),
        _ => None,
    }
}

/// Record (or clear) the non-secret "key present" marker for a provider. Called
/// by the command layer right after a key is stored in / removed from the
/// Keychain, so the launch-time read never has to touch the Keychain.
pub fn mark_key_present(conn: &Connection, provider: &str, present: bool) {
    if let Some(key) = key_present_flag(provider) {
        let _ = set_string(conn, key, if present { "1" } else { "0" });
    }
}

/// Record (or clear) the Codex-credentials marker.
pub fn mark_codex_creds_present(conn: &Connection, present: bool) {
    let _ = set_string(
        conn,
        KEY_CODEX_CREDS_PRESENT,
        if present { "1" } else { "0" },
    );
}

/// Read a persisted presence flag, seeding it once from the Keychain if it has
/// never been written. The seed is the ONLY launch-path Keychain read, and it
/// happens at most once ever (the result is persisted) — so existing users keep
/// their "key present" state after upgrading without re-entering keys, and every
/// subsequent launch is prompt-free.
fn key_present_seeded(conn: &Connection, flag_key: &str, probe: impl FnOnce() -> bool) -> bool {
    match get_string(conn, flag_key).as_deref() {
        Some("1") => true,
        Some(_) => false,
        None => {
            let present = probe();
            let _ = set_string(conn, flag_key, if present { "1" } else { "0" });
            present
        }
    }
}

/// Build the AI posture label from the AUTHORITATIVE provider, so the label can
/// never disagree with the real send target. A cloud provider names the host it
/// sends to; everything else (local, unset, or explicitly disabled) is on-device.
pub fn ai_posture_label(provider: AiProvider) -> String {
    match provider.remote_host() {
        Some(host) => format!("Sends your selection to {host}"),
        None => "On-device only".to_string(),
    }
}

pub fn build_dto(conn: &Connection) -> Result<SettingsDto> {
    let export = get_export_path(conn)?;
    let local_only = get_local_only(conn);
    let provider = get_ai_provider(conn);
    Ok(SettingsDto {
        export_path: export.to_string_lossy().to_string(),
        export_path_is_default: export_path_is_default(conn),
        app_data_path: paths::app_support_dir()?.to_string_lossy().to_string(),
        ai_posture: ai_posture_label(provider),
        ai_base_url: get_ai_base_url(conn),
        ai_model: get_ai_model(conn),
        ai_local_only: local_only,
        quote_policy: QUOTE_WARN_TEXT.to_string(),
        quote_warn_chars: 300,
        ai_requests_retention_days: get_ai_retention_days(conn),
        margin_help: get_margin_help(conn),
        ai_provider: provider.as_str().to_string(),
        ai_provider_chosen: !matches!(provider, AiProvider::Unset),
        ai_remote_allowed: provider.is_remote(),
        ai_model_openai: get_ai_model_for(conn, AiProvider::OpenAi),
        ai_model_anthropic: get_ai_model_for(conn, AiProvider::Anthropic),
        ai_model_codex: get_ai_model_for(conn, AiProvider::Codex),
        // Presence booleans come from persisted flags (seeded once), so opening
        // the app or Settings never decrypts a key and never prompts. The codex
        // flag is OR'd with the no-prompt file check for a Codex CLI login.
        ai_key_present_openai: key_present_seeded(conn, KEY_AI_KEY_PRESENT_OPENAI, || {
            crate::keystore::has_key("openai")
        }),
        ai_key_present_anthropic: key_present_seeded(conn, KEY_AI_KEY_PRESENT_ANTHROPIC, || {
            crate::keystore::has_key("anthropic")
        }),
        ai_codex_creds_present: key_present_seeded(conn, KEY_CODEX_CREDS_PRESENT, || {
            crate::keystore::has_codex_creds()
        }) || crate::ai_providers::codex_cli_auth_present(),
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
        let r = validate_export_path("/tmp/throughline_test_settings_path").unwrap();
        assert!(r.is_absolute());
    }

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn reading_rhythm_defaults_to_25_then_round_trips() {
        let conn = mem();
        assert_eq!(get_reading_rhythm_minutes(&conn), DEFAULT_RHYTHM_MINUTES);
        set_string(&conn, KEY_READING_RHYTHM_MINUTES, "40").unwrap();
        assert_eq!(get_reading_rhythm_minutes(&conn), 40);
    }

    #[test]
    fn margin_help_defaults_and_validates() {
        let conn = mem();
        assert_eq!(get_margin_help(&conn), "guided");
        set_string(&conn, KEY_MARGIN_HELP, "quiet").unwrap();
        assert_eq!(get_margin_help(&conn), "quiet");
        // Deep Study is a recognised level (added with the cockpit redesign).
        set_string(&conn, KEY_MARGIN_HELP, "deep_study").unwrap();
        assert_eq!(get_margin_help(&conn), "deep_study");
        // Unknown value falls back to the default rather than echoing garbage.
        set_string(&conn, KEY_MARGIN_HELP, "loud").unwrap();
        assert_eq!(get_margin_help(&conn), "guided");
    }

    #[test]
    fn reading_rhythm_clamps_absurd_values() {
        let conn = mem();
        set_string(&conn, KEY_READING_RHYTHM_MINUTES, "1").unwrap();
        assert_eq!(get_reading_rhythm_minutes(&conn), 5, "floor at 5 min");
        set_string(&conn, KEY_READING_RHYTHM_MINUTES, "9000").unwrap();
        assert_eq!(get_reading_rhythm_minutes(&conn), 120, "cap at 120 min");
        set_string(&conn, KEY_READING_RHYTHM_MINUTES, "not-a-number").unwrap();
        assert_eq!(
            get_reading_rhythm_minutes(&conn),
            DEFAULT_RHYTHM_MINUTES,
            "fall back on garbage"
        );
    }

    #[test]
    fn presence_flag_seeds_once_then_is_sticky() {
        use std::cell::Cell;
        let conn = mem();
        let probe_calls = Cell::new(0);
        // Uninitialized → the probe runs once and the result is persisted.
        let first = key_present_seeded(&conn, KEY_CODEX_CREDS_PRESENT, || {
            probe_calls.set(probe_calls.get() + 1);
            true
        });
        assert!(first);
        assert_eq!(probe_calls.get(), 1);
        // Persisted → the probe (the Keychain read / macOS prompt) never runs again,
        // even if it would now report something different.
        let second = key_present_seeded(&conn, KEY_CODEX_CREDS_PRESENT, || {
            probe_calls.set(probe_calls.get() + 1);
            false
        });
        assert!(second, "persisted value must win without re-probing");
        assert_eq!(probe_calls.get(), 1, "probe must not run a second time");
    }

    #[test]
    fn mark_key_present_round_trips_and_skips_the_probe() {
        let conn = mem();
        mark_key_present(&conn, "openai", true);
        // Flag set → the probe must NOT be consulted (no Keychain read on launch).
        assert!(key_present_seeded(&conn, KEY_AI_KEY_PRESENT_OPENAI, || {
            panic!("probe must not run when the flag is already set")
        }));
        mark_key_present(&conn, "openai", false);
        assert!(!key_present_seeded(
            &conn,
            KEY_AI_KEY_PRESENT_OPENAI,
            || { panic!("probe must not run when the flag is already set") }
        ));
        // Providers without a stored key (local/codex/none) have no openai/anthropic flag.
        mark_key_present(&conn, "local", true); // no-op, must not panic
    }

    #[test]
    fn codex_presence_flag_round_trips() {
        let conn = mem();
        mark_codex_creds_present(&conn, true);
        assert_eq!(
            get_string(&conn, KEY_CODEX_CREDS_PRESENT).as_deref(),
            Some("1")
        );
        mark_codex_creds_present(&conn, false);
        assert_eq!(
            get_string(&conn, KEY_CODEX_CREDS_PRESENT).as_deref(),
            Some("0")
        );
    }

    /// The posture label is derived from the AUTHORITATIVE provider, not from
    /// `local_only`, so it can never claim "on-device" while a cloud provider is
    /// the real send target. Each cloud provider names its host; everything else
    /// is on-device. (Pinned on the pure helper rather than `build_dto`, which
    /// touches the filesystem/Keychain and so is never exercised in the default
    /// suite.)
    #[test]
    fn posture_label_follows_authoritative_provider_not_local_only() {
        // On-device for the non-remote providers and the unset/disabled states.
        for p in [AiProvider::Local, AiProvider::Unset, AiProvider::Disabled] {
            assert_eq!(
                ai_posture_label(p),
                "On-device only",
                "{p:?} must read on-device"
            );
        }
        // Cloud providers name the exact host the selection is sent to.
        assert_eq!(
            ai_posture_label(AiProvider::OpenAi),
            "Sends your selection to api.openai.com"
        );
        assert_eq!(
            ai_posture_label(AiProvider::Anthropic),
            "Sends your selection to api.anthropic.com"
        );
        assert_eq!(
            ai_posture_label(AiProvider::Codex),
            "Sends your selection to chatgpt.com"
        );
        // Regression: a remote provider must never read on-device, regardless of
        // any lingering stale `local_only` flag — the label follows the provider.
        for p in [AiProvider::OpenAi, AiProvider::Anthropic, AiProvider::Codex] {
            assert_ne!(
                ai_posture_label(p),
                "On-device only",
                "{p:?} must not read on-device"
            );
            assert!(p.remote_host().is_some(), "{p:?} must expose a remote host");
        }
    }
}

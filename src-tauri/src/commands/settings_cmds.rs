//! Settings + small system-info commands. Named `settings_cmds` to avoid
//! conflict with `crate::settings` (the storage layer).

use tauri::State;

use crate::db::DbState;
use crate::error::AppError;
use crate::{ai_client, paths, settings};

/// Returns the backend's `COMMAND_API_VERSION`. The frontend uses this to
/// detect a backend it can't talk to (after a major-version IPC change) and
/// refuse to issue commands. See `docs/IPC.md`.
#[tauri::command]
pub fn cmd_api_version() -> u32 {
    crate::COMMAND_API_VERSION
}

#[tauri::command]
pub fn cmd_paths_info(state: State<DbState>) -> Result<serde_json::Value, AppError> {
    let app = paths::app_support_dir()?;
    let db = paths::db_path()?;
    // Report the EFFECTIVE export root (configured path or default), not the
    // hardcoded default — otherwise this disagrees with where exports go.
    let export = {
        let conn = state.0.lock()?;
        crate::export::root_for(&conn)
    };
    Ok(serde_json::json!({
        "app_support": app.to_string_lossy(),
        "db_path": db.to_string_lossy(),
        "export_root": export.to_string_lossy(),
    }))
}

#[tauri::command]
pub fn cmd_get_settings(state: State<DbState>) -> Result<settings::SettingsDto, AppError> {
    let conn = state.0.lock()?;
    settings::build_dto(&conn).map_err(AppError::from)
}

#[tauri::command]
pub fn cmd_set_export_path(
    path: String,
    state: State<DbState>,
) -> Result<settings::SettingsDto, AppError> {
    let conn = state.0.lock()?;
    settings::set_export_path(&conn, &path).map_err(AppError::from)?;
    settings::build_dto(&conn).map_err(AppError::from)
}

/// Preflight the effective export root: can Throughline actually write notes
/// there right now? Catches a misconfigured custom path or an unmounted drive
/// BEFORE a session's notes are silently lost. Runs on every launch (App.tsx),
/// so it must never create anything — see `check_export_root`.
#[tauri::command]
pub fn cmd_check_export_path(state: State<DbState>) -> Result<serde_json::Value, AppError> {
    let root = {
        let conn = state.0.lock()?;
        crate::export::root_for(&conn)
    };
    Ok(check_export_root(&root))
}

/// The launch-time check behind `cmd_check_export_path`. On an unconfigured
/// install the effective root is the DEFAULT `~/Documents/Throughline`, and this runs
/// on every launch — so it must never create the folder (CORE-1019: a
/// stranger's first launch must not plant the export folder). Only a root that already
/// exists gets the real write probe. Reader-initiated setup keeps its
/// create-and-verify UX in `cmd_set_export_path` (`settings::set_export_path`).
fn check_export_root(root: &std::path::Path) -> serde_json::Value {
    let message = if root.exists() {
        export_write_probe(root).err()
    } else {
        // Fine: the folder will be created on the first export. Creating it
        // here, on launch, is exactly the the export folder-planting bug.
        None
    };
    serde_json::json!({
        "path": root.to_string_lossy(),
        "writable": message.is_none(),
        "message": message,
    })
}

/// Returns Ok(()) if `root` can be created and written to, else a human message.
fn export_write_probe(root: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("Throughline can't create the export folder ({e})."))?;
    let probe = root.join(".throughline-write-test");
    std::fs::write(&probe, b"ok")
        .map_err(|e| format!("Throughline can't save notes to this folder ({e})."))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[tauri::command]
pub fn cmd_set_ai_settings(
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    retention_days: Option<i64>,
    ai_phrases: Option<bool>,
    state: State<DbState>,
) -> Result<settings::SettingsDto, AppError> {
    use settings::AiProvider;
    let conn = state.0.lock()?;
    if let Some(on) = ai_phrases {
        // Off = zero phrase network calls (the plan gate reads this first).
        settings::set_string(
            &conn,
            settings::KEY_AI_PHRASES,
            if on { "true" } else { "false" },
        )
        .map_err(AppError::from)?;
    }
    if let Some(days) = retention_days {
        // adr-001: clamp to >= 0 (0 disables the sweep / keeps everything).
        let days = days.max(0);
        settings::set_string(&conn, settings::KEY_AI_RETENTION_DAYS, &days.to_string())
            .map_err(AppError::from)?;
    }

    // Provider choice (authoritative). Stamps the onboarding-complete flag once.
    if let Some(p) = provider.as_deref() {
        let prov = AiProvider::from_str(p);
        if matches!(prov, AiProvider::Unset) {
            return Err(AppError::validation(format!("unknown AI provider: {p:?}")));
        }
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, prov.as_str())
            .map_err(AppError::from)?;
        // Keep the legacy ai_local_only flag in sync for any old reader of it.
        settings::set_string(
            &conn,
            settings::KEY_LOCAL_ONLY,
            if matches!(prov, AiProvider::Local) {
                "true"
            } else {
                "false"
            },
        )
        .map_err(AppError::from)?;
        if settings::get_string(&conn, settings::KEY_AI_PROVIDER_CHOSEN_AT).is_none() {
            settings::set_string(
                &conn,
                settings::KEY_AI_PROVIDER_CHOSEN_AT,
                &chrono::Utc::now().to_rfc3339(),
            )
            .map_err(AppError::from)?;
        }
        if let Some(m) = model.as_deref() {
            settings::set_ai_model_for(&conn, prov, m).map_err(AppError::from)?;
        }
    } else if let Some(m) = model.as_deref() {
        // No provider in this call → the model edits the CURRENT provider's model
        // (falling back to Local) so Settings can tweak a model without re-choosing.
        let cur = settings::get_ai_provider(&conn);
        let target = if cur.is_remote() || matches!(cur, AiProvider::Local) {
            cur
        } else {
            AiProvider::Local
        };
        settings::set_ai_model_for(&conn, target, m).map_err(AppError::from)?;
    }

    // The base_url slot is LOCAL-ONLY: it must be a loopback host. Cloud endpoints
    // are code constants, never user-set, so a typo can never redirect a key.
    if let Some(u) = base_url.as_ref() {
        ai_client::validate_base_url(u, true).map_err(|_| {
            AppError::config(format!(
                "The local AI base URL must be a loopback address (localhost / 127.0.0.1). Got: {u}"
            ))
        })?;
        settings::set_string(&conn, settings::KEY_AI_BASE_URL, u.trim()).map_err(AppError::from)?;
    }

    settings::build_dto(&conn).map_err(AppError::from)
}

/// Store a cloud provider's API key in the OS Keychain. The key is NEVER echoed
/// back, logged, written to the DB, or returned by any command — only the
/// resulting `ai_key_present_*` boolean reaches the frontend.
#[tauri::command]
pub fn cmd_set_ai_key(
    provider: String,
    key: String,
    state: State<DbState>,
) -> Result<settings::SettingsDto, AppError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("API key is empty."));
    }
    crate::keystore::set_key(&provider, trimmed)
        .map_err(|e| AppError::config(format!("Could not store the API key: {e}")))?;
    let conn = state.0.lock()?;
    settings::mark_key_present(&conn, &provider, true);
    settings::build_dto(&conn).map_err(AppError::from)
}

/// Delete a cloud provider's stored API key (idempotent).
#[tauri::command]
pub fn cmd_clear_ai_key(
    provider: String,
    state: State<DbState>,
) -> Result<settings::SettingsDto, AppError> {
    crate::keystore::clear_key(&provider)
        .map_err(|e| AppError::config(format!("Could not clear the API key: {e}")))?;
    let conn = state.0.lock()?;
    settings::mark_key_present(&conn, &provider, false);
    settings::build_dto(&conn).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CORE-1019: the no-arg launch preflight must NEVER create the export
    /// root. On an unconfigured install the effective root is the default
    /// ~/Documents/Throughline — creating it here plants an unexplained folder in a
    /// stranger's home on the very first launch. A missing root reads as fine
    /// (it will be created on the first export); only an existing root gets
    /// the real write probe.
    #[test]
    fn launch_check_does_not_create_a_missing_export_root() {
        let _g = crate::paths::lock_env_for_test();
        let missing = std::env::temp_dir()
            .join(format!(
                "tl-launch-check-{}-{}",
                std::process::id(),
                line!()
            ))
            .join("not-created-yet");
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &missing);
        }
        let root = crate::paths::default_export_root().expect("export root");
        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        assert_eq!(root, missing, "env override must resolve to the temp path");
        assert!(!root.exists(), "precondition: the root must not exist yet");

        let v = check_export_root(&root);

        assert!(
            !root.exists(),
            "the launch check must not plant the export root (CORE-1019)"
        );
        assert_eq!(
            v["writable"], true,
            "a missing root is fine — it will be created on first export"
        );
        std::fs::remove_dir_all(missing.parent().unwrap()).ok();
    }

    /// An EXISTING root still gets the real write probe — the launch check's
    /// whole point is catching an unwritable configured folder before notes
    /// are silently lost — and the probe leaves no litter behind.
    #[test]
    fn launch_check_probes_an_existing_root_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!(
            "tl-launch-probe-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let v = check_export_root(&dir);

        assert_eq!(v["writable"], true);
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            leftovers.is_empty(),
            "the probe must remove its test file, found {:?}",
            leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

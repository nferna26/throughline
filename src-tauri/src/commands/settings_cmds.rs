//! Settings + small system-info commands. Named `settings_cmds` to avoid
//! conflict with `crate::settings` (the storage layer).

use tauri::{State, WebviewWindow};

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

/// Mark that the next process startup is the completion of a reader-approved
/// update relaunch and should bring Throughline back to the foreground.
#[tauri::command]
pub fn cmd_prepare_update_relaunch_focus() -> Result<(), AppError> {
    crate::relaunch_focus::prepare_update_relaunch_focus().map_err(|e| {
        AppError::io(format!(
            "Could not prepare the update relaunch marker: {e:#}"
        ))
    })
}

/// Consume the update-relaunch focus marker. Returns true at most once, and
/// only for a recent updater-driven relaunch.
#[tauri::command]
pub fn cmd_consume_update_relaunch_focus() -> Result<bool, AppError> {
    crate::relaunch_focus::consume_update_relaunch_focus()
        .map_err(|e| AppError::io(format!("Could not read the update relaunch marker: {e:#}")))
}

/// Bring the relaunched app frontmost after an updater-driven restart. On macOS
/// `set_focus` alone can focus a window without activating the app, so the
/// updater path follows it with AppKit activation.
#[tauri::command]
pub fn cmd_focus_main_window_after_update_relaunch(window: WebviewWindow) -> Result<(), AppError> {
    focus_main_window_after_update_relaunch(window)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn focus_main_window_after_update_relaunch(window: WebviewWindow) -> Result<(), AppError> {
    if objc2::MainThreadMarker::new().is_some() {
        return focus_main_window_after_update_relaunch_on_main(&window).map_err(|e| {
            AppError::internal(format!(
                "Could not focus Throughline after update relaunch: {e}"
            ))
        });
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let window_for_main = window.clone();
    window
        .run_on_main_thread(move || {
            let result = focus_main_window_after_update_relaunch_on_main(&window_for_main);
            let _ = tx.send(result);
        })
        .map_err(|e| AppError::internal(format!("Could not schedule relaunch focus: {e}")))?;

    rx.recv()
        .map_err(|e| AppError::internal(format!("Could not finish relaunch focus: {e}")))?
        .map_err(|e| {
            AppError::internal(format!(
                "Could not focus Throughline after update relaunch: {e}"
            ))
        })
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn focus_main_window_after_update_relaunch_on_main(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    let mtm = objc2::MainThreadMarker::new()
        .ok_or_else(|| "AppKit activation did not run on the main thread".to_string())?;
    let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
    app.activateIgnoringOtherApps(true);
    if let Some(main_window) = app.mainWindow().or_else(|| app.keyWindow()) {
        main_window.makeKeyAndOrderFront(None);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn focus_main_window_after_update_relaunch(window: WebviewWindow) -> Result<(), AppError> {
    window.show().map_err(|e| {
        AppError::internal(format!(
            "Could not show Throughline after update relaunch: {e}"
        ))
    })?;
    window.unminimize().map_err(|e| {
        AppError::internal(format!(
            "Could not unminimize Throughline after update relaunch: {e}"
        ))
    })?;
    window.set_focus().map_err(|e| {
        AppError::internal(format!(
            "Could not focus Throughline after update relaunch: {e}"
        ))
    })
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
        if on {
            // Turning phrases ON is an operator action that plausibly fixes
            // whatever the backoff was waiting out — start fresh.
            crate::phrases::reset_backoff();
        }
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
        // A provider switch moves phrases to a different wire — the old
        // wire's backoff/cap state must not gate the new one.
        crate::phrases::reset_backoff();
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
    // A fresh key is the re-activation path for a phrase auth-stop.
    crate::phrases::reset_backoff();
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

/// The global reading pace (sitting size). The reader only ever sees the
/// reading-term label (a few pages / a chapter / a long read); the minutes are
/// the internal mapping the pace step + the Settings pace control read and write,
/// never shown on screen and never a timer.
#[derive(serde::Serialize)]
pub struct ReadingPaceDto {
    /// 10 | 25 | 60 in practice, clamped to the humane 5..=120 band; 25
    /// ("a chapter") when the reader has not chosen a pace yet.
    pub minutes: i64,
    /// True once the reader has explicitly chosen a pace — drives "a returning
    /// reader who already set it skips the pace step and lands straight on Today".
    pub chosen: bool,
}

/// Read the global reading pace. On a fresh install `chosen` is false (the pace
/// step should ask) while `minutes` is still a sensible default (a chapter).
#[tauri::command]
pub fn cmd_get_reading_pace(state: State<DbState>) -> Result<ReadingPaceDto, AppError> {
    let conn = state.0.lock()?;
    Ok(ReadingPaceDto {
        minutes: settings::get_reading_rhythm_minutes(&conn),
        chosen: settings::reading_rhythm_chosen(&conn),
    })
}

/// Set the global reading pace (the first-journey pace step and the Settings
/// pace control both call this). Persisted as the existing `reading_rhythm_minutes`
/// setting — a key/value row, NO schema change. Marks the pace chosen, so future
/// new books default to it and the pace step is skipped. The chosen minutes never
/// surface to the reader.
#[tauri::command]
pub fn cmd_set_reading_pace(
    minutes: i64,
    state: State<DbState>,
) -> Result<ReadingPaceDto, AppError> {
    let conn = state.0.lock()?;
    let stored = settings::set_reading_rhythm_minutes(&conn, minutes).map_err(AppError::from)?;
    Ok(ReadingPaceDto {
        minutes: stored,
        chosen: true,
    })
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

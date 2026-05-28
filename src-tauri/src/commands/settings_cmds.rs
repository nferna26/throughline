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
pub fn cmd_paths_info() -> Result<serde_json::Value, AppError> {
    let app = paths::app_support_dir()?;
    let db = paths::db_path()?;
    let export = paths::default_export_root()?;
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
pub fn cmd_set_export_path(path: String, state: State<DbState>) -> Result<settings::SettingsDto, AppError> {
    let conn = state.0.lock()?;
    settings::set_export_path(&conn, &path).map_err(AppError::from)?;
    settings::build_dto(&conn).map_err(AppError::from)
}

#[tauri::command]
pub fn cmd_set_ai_settings(
    base_url: Option<String>,
    model: Option<String>,
    local_only: Option<bool>,
    retention_days: Option<i64>,
    state: State<DbState>,
) -> Result<settings::SettingsDto, AppError> {
    let conn = state.0.lock()?;
    if let Some(days) = retention_days {
        // adr-001: clamp to >= 0 (0 disables the sweep / keeps everything).
        let days = days.max(0);
        settings::set_string(&conn, settings::KEY_AI_RETENTION_DAYS, &days.to_string())
            .map_err(AppError::from)?;
    }
    if let Some(u) = base_url.as_ref() {
        // Validate against the *desired* local_only setting (the one in this call,
        // or the existing one). This prevents saving a remote URL while local-only
        // is still ON.
        let effective_local_only = local_only.unwrap_or_else(|| settings::get_local_only(&conn));
        ai_client::validate_base_url(u, effective_local_only).map_err(AppError::from)?;
        settings::set_string(&conn, settings::KEY_AI_BASE_URL, u.trim()).map_err(AppError::from)?;
    }
    if let Some(m) = model.as_ref() {
        settings::set_string(&conn, settings::KEY_AI_MODEL, m.trim()).map_err(AppError::from)?;
    }
    if let Some(lo) = local_only {
        settings::set_string(&conn, settings::KEY_LOCAL_ONLY, if lo { "true" } else { "false" })
            .map_err(AppError::from)?;
        // When flipping local-only back ON, re-validate the stored URL — if it
        // is now non-loopback, refuse the flip and tell the user.
        if lo {
            let url = settings::get_ai_base_url(&conn);
            if ai_client::validate_base_url(&url, true).is_err() {
                settings::set_string(&conn, settings::KEY_LOCAL_ONLY, "false").ok();
                return Err(AppError::config(format!(
                    "Cannot turn Local-only mode ON while AI base URL is non-loopback ({}). Change the URL first.",
                    url
                )));
            }
        }
    }
    settings::build_dto(&conn).map_err(AppError::from)
}

//! Files › Automatic backups + Restore (settings redesign).
//!
//! Thin command layer over `crate::backup` (the launch-time rolling backup +
//! corruption recovery that already existed). Nothing here invents a second
//! backup mechanism: the toggle gates the SAME rolling backup, "last backup"
//! reads the SAME files, and restore reuses the SAME validated
//! restore-into-place path the corruption recovery uses. Everything stays
//! under the app-support dir; nothing reaches the export tree or the network.

use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::error::AppError;
use crate::{backup, paths, settings};

/// What the Files pane shows beside the "Automatic backups" toggle.
#[derive(Serialize, Debug)]
pub struct BackupStatus {
    pub enabled: bool,
    /// RFC3339 (local offset) of the newest rolling backup, or null when none
    /// exists yet. The frontend renders it as "today at 9:12".
    pub last_backup_at: Option<String>,
}

fn status(conn: &rusqlite::Connection) -> BackupStatus {
    BackupStatus {
        enabled: settings::get_backups_enabled(conn),
        last_backup_at: backup::newest_backup_taken_at().ok().flatten(),
    }
}

#[tauri::command]
pub fn cmd_backup_status(state: State<DbState>) -> Result<BackupStatus, AppError> {
    let conn = state.0.lock()?;
    Ok(status(&conn))
}

/// Flip automatic backups. Turning them ON writes a backup immediately, so the
/// "last backup" line proves the switch did something; turning them OFF only
/// stops future backups — existing ones are kept (they're the safety net).
#[tauri::command]
pub fn cmd_set_backups_enabled(
    enabled: bool,
    state: State<DbState>,
) -> Result<BackupStatus, AppError> {
    let conn = state.0.lock()?;
    settings::set_backups_enabled(&conn, enabled).map_err(AppError::from)?;
    if enabled {
        if let Err(e) = backup::write_rolling_backup(&conn) {
            tracing::warn!("immediate backup on enable failed: {e:#}");
        }
    }
    Ok(status(&conn))
}

/// One row of the "Choose a backup" picker. `id` is the bare backup file name
/// (never a path) — it round-trips into `cmd_restore_backup`.
#[derive(Serialize, Debug)]
pub struct BackupEntry {
    pub id: String,
    /// RFC3339 (local offset), from the backup's own filename timestamp.
    pub taken_at: String,
}

/// The restorable backups, newest first.
#[tauri::command]
pub fn cmd_list_backups() -> Result<Vec<BackupEntry>, AppError> {
    let dir = paths::backups_dir().map_err(|e| AppError::io(e.to_string()))?;
    let mut files = backup::list_backups(&dir).map_err(|e| AppError::io(e.to_string()))?;
    files.reverse(); // list_backups is oldest-first
    Ok(files
        .into_iter()
        .filter_map(|p| {
            let id = p.file_name()?.to_str()?.to_string();
            let taken_at = backup::backup_taken_at(&p)?.to_rfc3339();
            Some(BackupEntry { id, taken_at })
        })
        .collect())
}

/// Restore the library from a chosen backup. The current live DB is first
/// snapshotted aside (so a mistaken restore is itself undoable), then the
/// validated backup is moved into place atomically and the live connection is
/// reopened on it. The frontend reloads afterwards — every screen's state is
/// stale by definition once the library underneath it changed.
#[tauri::command]
pub fn cmd_restore_backup(id: String, state: State<DbState>) -> Result<(), AppError> {
    const CANT_USE: &str = "That backup can't be used. Your library is unchanged.";
    let candidate =
        backup::resolve_backup_by_id(&id).map_err(|_| AppError::validation(CANT_USE))?;
    if !backup::validate_backup(&candidate).map_err(|_| AppError::io(CANT_USE))? {
        return Err(AppError::io(CANT_USE));
    }

    let mut guard = state.0.lock()?;
    backup::write_pre_restore_snapshot(&guard).map_err(|e| {
        AppError::io(format!(
            "Couldn't secure the current library first ({e}). Nothing was changed."
        ))
    })?;

    // Close the live connection before moving files: swap in a throwaway
    // in-memory handle, drop the old one (checkpointing its WAL), replace the
    // file, then reopen. The guard is held throughout, so no other command can
    // observe the in-between state.
    let placeholder = rusqlite::Connection::open_in_memory()
        .map_err(|e| AppError::internal(format!("restore staging failed: {e}")))?;
    drop(std::mem::replace(&mut *guard, placeholder));

    let restore_result = backup::restore_backup_file(&candidate);
    // Whatever happened, the live path holds a usable DB (restore_into_place is
    // an atomic rename): reopen it and put the real connection back.
    let reopened = crate::db::open_and_migrate().map_err(|e| {
        AppError::internal(format!(
            "The library file changed but could not be reopened: {e}. Restart Throughline."
        ))
    })?;
    *guard = reopened;

    restore_result.map_err(|_| {
        AppError::io("Couldn't restore that backup. Your library is unchanged.".to_string())
    })
}

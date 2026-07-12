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
    /// REC-011: true when a pre-restore snapshot exists — the last restore can
    /// be undone (the Files pane shows the undo affordance).
    pub undo_available: bool,
}

fn status(conn: &rusqlite::Connection) -> BackupStatus {
    BackupStatus {
        enabled: settings::get_backups_enabled(conn),
        last_backup_at: backup::newest_backup_taken_at().ok().flatten(),
        undo_available: backup::newest_pre_restore_snapshot()
            .ok()
            .flatten()
            .is_some(),
    }
}

#[tauri::command]
pub fn cmd_backup_status(state: State<DbState>) -> Result<BackupStatus, AppError> {
    let conn = state.lock()?;
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
    let conn = state.lock()?;
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
    let mut guard = state.lock()?;
    restore_backup_impl(&mut guard, &id)
}

/// `cmd_restore_backup`'s body over the locked connection, extracted so the
/// command-level restore → Undo round trip is testable without Tauri State.
fn restore_backup_impl(guard: &mut rusqlite::Connection, id: &str) -> Result<(), AppError> {
    restore_backup_impl_with(guard, id, &mut |c| settings::rotate_library_generation(c))
}

fn restore_backup_impl_with(
    guard: &mut rusqlite::Connection,
    id: &str,
    rotate: &mut dyn FnMut(&rusqlite::Connection) -> anyhow::Result<String>,
) -> Result<(), AppError> {
    const CANT_USE: &str = "That backup can't be used. Your library is unchanged.";
    let candidate = backup::resolve_backup_by_id(id).map_err(|_| AppError::validation(CANT_USE))?;
    // REC-011 coherence gate — THE shared preflight (also used by the automatic
    // corruption recovery and undo): backups hold only the reading database,
    // never the imported book FILES. If this backup lists books that would not
    // READ (through the production read/regeneration path), restoring would
    // resurrect unreadable rows — reject with the precise fix instead.
    let missing = backup::restore_preflight(&candidate).map_err(|_| AppError::io(CANT_USE))?;
    if !missing.is_empty() {
        return Err(AppError::validation(format!(
            "This backup lists {} whose book {} no longer on this Mac: {}. \
             A backup holds your notes, plans, and reading history — not the book files themselves. \
             Use \"Add a missing book's file\" below to match the original file back to this backup, \
             then restore again. Your library is unchanged.",
            if missing.len() == 1 { "a book" } else { "books" },
            if missing.len() == 1 { "file is" } else { "files are" },
            missing.join(", "),
        )));
    }

    // R4: snapshot CREATION only — pruning is a separate step that runs only
    // after the swap SUCCEEDS, so no snapshot anyone might still need is ever
    // deleted on the way in.
    let snapshot = backup::write_pre_restore_snapshot(guard).map_err(|e| {
        AppError::io(format!(
            "Couldn't secure the current library first ({e}). Nothing was changed."
        ))
    })?;

    // R7-1: the rotation happens ON THE PREPARED CANDIDATE COPY, before its
    // atomic promotion (restore_into_place_prepared). A rotation failure
    // aborts with the live library byte-untouched — there is no swap-then-
    // rotate window, no rollback for rotation reasons, and no path that
    // returns control to a running app serving a replaced library under the
    // previous library's token.
    let swapped = swap_live_db_locked(
        guard,
        &candidate,
        &snapshot,
        "Couldn't restore that backup. Your library is unchanged.",
        Some(rotate),
    );
    match swapped {
        Ok(()) => {
            // Success: this snapshot is the one-shot undo target; older
            // pre-restore snapshots are strictly worse — prune them NOW.
            // R5: a prune failure PROPAGATES from backup.rs and is surfaced
            // (a leftover snapshot is a stale undo affordance) — but the
            // restore itself succeeded, so it does not fail the command.
            if let Err(e) = backup::prune_pre_restore_snapshots_except(&[&snapshot]) {
                tracing::warn!(
                    category = "restore",
                    "stale pre-restore snapshots could not be pruned: {e:#}"
                );
            }
            Ok(())
        }
        Err(SwapError::Unchanged(e)) => {
            // Nothing changed (or the swap rolled back to exactly this
            // state): the just-written snapshot equals the live library and
            // would only surface a bogus Undo affordance.
            let _ = std::fs::remove_file(&snapshot);
            Err(e)
        }
        Err(SwapError::AuxChanged(e)) => {
            // R9-1: the live library still serves, but files beside it were
            // mutated — the snapshot is RETAINED until a later attempt proves
            // a clean state (it is the exact pre-restore copy).
            Err(e)
        }
        Err(SwapError::AppliedUnproven(e)) => {
            // R8-1: the RESTORE APPLIED (candidate live, generation rotated)
            // but durability is unproven — the snapshot is a REAL undo
            // affordance and is RETAINED; the honest error tells the reader.
            Err(e)
        }
    }
}

/// Replace the live DB with `candidate` and reopen it, with `fallback` (a
/// just-written, known-good snapshot of the CURRENT library) as the recovery
/// source if the swapped-in file fails to reopen (REC-011 R3).
///
/// The guard is held throughout, so no other command can observe the
/// in-between state. A throwaway in-memory connection stands in ONLY inside
/// this call, while the file is being replaced — every return path either
/// installs a REAL on-disk connection or exits the process. Leaving the
/// placeholder as the served DbState is banned: commands would silently read
/// an empty library and write rows that vanish on quit.
/// R8-1/R9-1: what a failed swap left behind, so callers report honestly.
/// `Unchanged` ⇒ the previous library is (still) live, its file AND helper
/// files untouched — snapshots written for this attempt are bogus affordances
/// and may be removed. `AuxChanged` ⇒ the previous library's FILE is still
/// live and its content settled (the checkpoint below ran first), but its
/// WAL/SHM helper files were mutated — snapshots must be RETAINED and the
/// message must not claim "nothing was changed". `AppliedUnproven` ⇒ the
/// CANDIDATE is live (coherent, generation-rotated) but the transition's
/// durability could not be proven — rollback sources must be RETAINED, the
/// reader told the switch applied, and this process stops serving commands
/// (`db::require_relaunch`).
#[derive(Debug)]
pub(crate) enum SwapError {
    Unchanged(AppError),
    AuxChanged(AppError),
    AppliedUnproven(AppError),
}

fn swap_live_db_locked(
    guard: &mut rusqlite::Connection,
    candidate: &std::path::Path,
    fallback: &std::path::Path,
    fail_msg: &str,
    // R7-1: rotation runs on the PREPARED candidate copy before promotion
    // (Some for real switches). The internal reopen-failure rollback always
    // restores the fallback snapshot UNPREPARED (None): it carries exactly
    // the token the reader's drafts were typed under.
    rotate: Option<backup::RotateFn<'_>>,
) -> Result<(), SwapError> {
    // Close the live connection before moving files: swap in the throwaway
    // handle and take the old one out.
    let placeholder = rusqlite::Connection::open_in_memory().map_err(|e| {
        SwapError::Unchanged(AppError::internal(format!("restore staging failed: {e}")))
    })?;
    let live_conn = std::mem::replace(guard, placeholder);

    // R9-1: settle the live database BEFORE the promotion deletes its WAL —
    // committed data can live ONLY in the WAL, so deleting it un-checkpointed
    // would drop those commits from the live path. Explicit checkpoint with
    // the busy flag checked, then an explicit close with the error
    // propagated; on any failure the untouched live connection goes straight
    // back into service and the attempt reports honestly as unchanged.
    let busy: Result<i64, rusqlite::Error> =
        live_conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0));
    match busy {
        Ok(0) => {}
        Ok(_) => {
            *guard = live_conn;
            return Err(SwapError::Unchanged(AppError::io(
                "Couldn't settle the current library before switching (it is still \
                 in use). Nothing was changed — try again in a moment."
                    .to_string(),
            )));
        }
        Err(e) => {
            *guard = live_conn;
            return Err(SwapError::Unchanged(AppError::io(format!(
                "Couldn't settle the current library before switching ({e}). \
                 Nothing was changed."
            ))));
        }
    }
    if let Err((conn_back, e)) = live_conn.close() {
        *guard = conn_back;
        return Err(SwapError::Unchanged(AppError::io(format!(
            "Couldn't close the current library before switching ({e}). \
             Nothing was changed."
        ))));
    }

    let restore_result = backup::restore_backup_file_prepared(candidate, rotate);
    match crate::db::open_and_migrate() {
        Ok(reopened) => {
            *guard = reopened;
            match restore_result {
                Ok(()) => Ok(()),
                Err(backup::PromotionError::Untouched(e)) => {
                    tracing::warn!(category = "restore", "promotion aborted: {e:#}");
                    Err(SwapError::Unchanged(AppError::io(fail_msg.to_string())))
                }
                Err(backup::PromotionError::AuxMutated(e)) => {
                    // R9-1: the live FILE is untouched and its content was
                    // settled into that single file by the checkpoint above,
                    // but helper files beside it were mutated — this is NOT
                    // "nothing was changed", and the safety copy stays.
                    tracing::warn!(
                        category = "restore",
                        "promotion aborted after clearing live sidecars: {e:#}"
                    );
                    Err(SwapError::AuxChanged(AppError::io(
                        "The switch didn't complete. Your reading data is intact, \
                         but files beside the library changed on disk, so the \
                         safety copy has been kept. You can try again."
                            .to_string(),
                    )))
                }
                Err(backup::PromotionError::After(e)) => {
                    // The candidate IS live (the reopen above opened it).
                    tracing::error!(
                        category = "restore",
                        "promotion applied but unproven: {e:#}"
                    );
                    // R9-1: an applied-but-unproven library must not keep
                    // serving commands — latch the process until relaunch.
                    crate::db::require_relaunch(
                        "The last library switch couldn't be fully confirmed. \
                         Relaunch Throughline to finish checking it — your undo \
                         copy has been kept.",
                    );
                    Err(SwapError::AppliedUnproven(AppError::io(
                        "The switch was applied, but its durability couldn't be confirmed \
                         (a disk sync failed). Relaunch Throughline before continuing — \
                         your undo copy has been kept."
                            .to_string(),
                    )))
                }
            }
        }
        Err(reopen_err) => {
            // The swapped-in file will not open. Put the fallback snapshot —
            // the library exactly as it was moments ago — back in place.
            tracing::error!(
                category = "restore",
                "restored file failed to reopen ({reopen_err:#}); rolling back to the pre-restore snapshot"
            );
            let rolled_back = backup::restore_backup_file_prepared(fallback, None);
            match (rolled_back, crate::db::open_and_migrate()) {
                (Ok(()), Ok(reopened)) => {
                    *guard = reopened;
                    Err(SwapError::Unchanged(AppError::io(
                        "That backup couldn't be opened after restoring it. Your library was put back exactly as it was."
                            .to_string(),
                    )))
                }
                (rb, reopen2) => {
                    // FAIL CLOSED: no on-disk database can be served. Exiting
                    // (loudly) is the only honest option left — the app must
                    // not keep running against the in-memory placeholder,
                    // silently showing an empty library and losing every
                    // write. The next launch enters open_db_resilient's
                    // recovery with the snapshot still on disk.
                    tracing::error!(
                        category = "restore",
                        "rollback after failed reopen ALSO failed (rollback ok: {}, reopen ok: {}); exiting to protect the library",
                        rb.is_ok(),
                        reopen2.is_ok(),
                    );
                    std::process::exit(70);
                }
            }
        }
    }
}

/// Undo the last restore (REC-011): put the pre-restore snapshot — the library
/// exactly as it was the moment before the restore — back as the live DB. The
/// snapshot is consumed on success, so the undo is one-shot and the affordance
/// disappears. Uses the same validate → swap-connection → atomic-replace →
/// reopen sequence as the restore itself.
#[tauri::command]
pub fn cmd_undo_restore(state: State<DbState>) -> Result<(), AppError> {
    let mut guard = state.lock()?;
    undo_restore_impl(&mut guard)
}

/// `cmd_undo_restore`'s body over the locked connection (see
/// [`restore_backup_impl`]). R4: the selected undo candidate is RETAINED until
/// the swap succeeds — snapshot creation no longer prunes, so writing the
/// safety snapshot below can never delete the candidate it is protecting.
fn undo_restore_impl(guard: &mut rusqlite::Connection) -> Result<(), AppError> {
    undo_restore_impl_with(guard, &mut |c| settings::rotate_library_generation(c))
}

fn undo_restore_impl_with(
    guard: &mut rusqlite::Connection,
    rotate: &mut dyn FnMut(&rusqlite::Connection) -> anyhow::Result<String>,
) -> Result<(), AppError> {
    const GONE: &str = "There is no restore to undo. Your library is unchanged.";
    let snapshot = backup::newest_pre_restore_snapshot()
        .map_err(|e| AppError::io(e.to_string()))?
        .ok_or_else(|| AppError::validation(GONE))?;
    // The SAME coherence preflight as restore + automatic recovery (REC-011).
    let missing = backup::restore_preflight(&snapshot)
        .map_err(|_| AppError::io("The undo copy can't be used. Your library is unchanged."))?;
    if !missing.is_empty() {
        return Err(AppError::validation(format!(
            "Undo would bring back {} whose book {} no longer on this Mac: {}. \
             Add the missing file back first (the restore sheet's \"Add a missing book's file\"), \
             then undo. Your library is unchanged.",
            if missing.len() == 1 {
                "a book"
            } else {
                "books"
            },
            if missing.len() == 1 {
                "file is"
            } else {
                "files are"
            },
            missing.join(", "),
        )));
    }

    // The undo's own rollback source: the CURRENT (restored) library, secured
    // before anything moves — same protection the restore itself gets. Removed
    // on every outcome below so it never becomes a phantom "undo" affordance.
    // Creation no longer prunes (R4), so `snapshot` — the undo candidate
    // selected above — survives this write untouched.
    let safety = backup::write_pre_restore_snapshot(guard).map_err(|e| {
        AppError::io(format!(
            "Couldn't secure the current library first ({e}). Nothing was changed."
        ))
    })?;

    // R7-1: like the restore, the rotation happens on the PREPARED snapshot
    // copy before its atomic promotion — a rotation failure aborts with the
    // post-restore library untouched and the undo affordance intact.
    let swapped = swap_live_db_locked(
        guard,
        &snapshot,
        &safety,
        "Couldn't undo the restore. Your library is unchanged.",
        Some(rotate),
    );
    match swapped {
        Ok(()) => {}
        Err(SwapError::Unchanged(e)) => {
            // R5: cleanup failures are surfaced, never silently swallowed — a
            // leftover snapshot is an undo affordance pointing at stale state.
            if let Err(re) = std::fs::remove_file(&safety) {
                tracing::warn!(
                    category = "restore",
                    "undo safety snapshot could not be removed: {re}"
                );
            }
            return Err(e);
        }
        Err(SwapError::AuxChanged(e)) => {
            // R9-1: the post-restore library still serves but helper files
            // were mutated — BOTH sources are retained (the safety copy and
            // the undo snapshot) until a clean state is proven.
            return Err(e);
        }
        Err(SwapError::AppliedUnproven(e)) => {
            // R8-1: the UNDO APPLIED but its durability is unproven — both
            // rollback sources are RETAINED (the safety copy AND the undo
            // snapshot) and the reader is told honestly.
            return Err(e);
        }
    }
    if let Err(e) = std::fs::remove_file(&safety) {
        tracing::warn!(
            category = "restore",
            "undo safety snapshot could not be removed: {e}"
        );
    }
    // One-shot: consume the snapshot so the affordance disappears — only
    // AFTER the swap succeeded (a failed swap keeps the candidate for retry).
    if let Err(e) = std::fs::remove_file(&snapshot) {
        tracing::warn!(
            category = "restore",
            "consumed undo snapshot could not be removed: {e}"
        );
    }
    Ok(())
}

/// REC-011 "re-import, then restore": the reader picks the original book file;
/// we match it to a row in the CHOSEN backup by full SHA-256 and stage it under
/// that row's historical id (files only — the live library is untouched). On
/// success the restore/undo preflight for that book passes. Returns the matched
/// title so the sheet can confirm what happened.
#[derive(Serialize)]
pub struct StagedRestoreSource {
    pub title: String,
    pub source_type: String,
}

#[tauri::command]
pub fn cmd_stage_restore_source(id: String, path: String) -> Result<StagedRestoreSource, AppError> {
    let candidate = backup::resolve_backup_by_id(&id)
        .map_err(|_| AppError::validation("That backup can't be used."))?;
    let staged = backup::stage_book_for_restore(&candidate, std::path::Path::new(&path))
        .map_err(|e| AppError::validation(format!("{e:#}")))?;
    Ok(StagedRestoreSource {
        title: staged.title,
        source_type: staged.source_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R4: the COMMAND-LEVEL restore → Undo round trip, with two recognizably
    /// different libraries. Same-second execution is the natural case here
    /// (the whole trip runs in well under a second) — the collision-proof
    /// snapshot names and the creation/pruning split are what make it work:
    /// the old code overwrote same-second snapshots and pruned the selected
    /// undo candidate before the swap.
    #[test]
    fn restore_then_undo_round_trip_at_the_command_level_same_second() {
        run_restore_undo_round_trip(false);
    }

    /// The different-second variant (a reader who waits before undoing).
    #[test]
    fn restore_then_undo_round_trip_at_the_command_level_different_second() {
        run_restore_undo_round_trip(true);
    }

    fn run_restore_undo_round_trip(cross_second: bool) {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-cmd-restore-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let marker = |conn: &rusqlite::Connection| -> Option<String> {
                crate::settings::get_string(conn, "library_marker")
            };
            // Library A, captured as the restorable backup.
            let mut conn = crate::db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "library_marker", "LIBRARY A").unwrap();
            let backup_a = backup::write_rolling_backup(&conn).expect("backup A");
            let id_a = backup_a.file_name().unwrap().to_str().unwrap().to_string();

            // The library moves on to a recognizably different state B.
            crate::settings::set_string(&conn, "library_marker", "LIBRARY B").unwrap();

            let gen_before = crate::settings::get_library_generation(&conn);

            // Restore A (command level).
            restore_backup_impl(&mut conn, &id_a).expect("restore A");
            assert_eq!(marker(&conn).as_deref(), Some("LIBRARY A"), "restored to A");
            // R5: every library replacement rotates the generation token.
            let gen_after_restore = crate::settings::get_library_generation(&conn);
            assert_ne!(
                gen_after_restore, gen_before,
                "restore rotated the generation"
            );
            assert!(!gen_after_restore.is_empty());

            if cross_second {
                std::thread::sleep(std::time::Duration::from_millis(1100));
            }

            // Undo (command level): back to B. The old create-and-prune
            // coupling deleted the undo candidate here; the old
            // timestamp-only names overwrote it in the same-second case.
            undo_restore_impl(&mut conn).expect("undo restores B");
            assert_eq!(
                marker(&conn).as_deref(),
                Some("LIBRARY B"),
                "undo returned to B"
            );
            let gen_after_undo = crate::settings::get_library_generation(&conn);
            assert_ne!(
                gen_after_undo, gen_after_restore,
                "undo rotated the generation too"
            );

            // One-shot: the affordance is gone.
            assert!(backup::newest_pre_restore_snapshot().unwrap().is_none());
            let err = undo_restore_impl(&mut conn).expect_err("second undo refused");
            assert!(format!("{err:?}").contains("no restore to undo"));
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R6-4: a failed generation rotation ROLLS THE SWITCH BACK — neither
    /// restore nor undo may return with a replaced library under a stale
    /// token (the draft-resurrection window the token exists to close).
    /// Injected at both command-level replacement points; the same scenario
    /// then succeeds with the real rotation, proving clean recoverability.
    #[test]
    fn restore_and_undo_roll_back_when_the_generation_rotation_fails() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-cmd-genrot-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let marker = |conn: &rusqlite::Connection| -> Option<String> {
                crate::settings::get_string(conn, "library_marker")
            };
            let mut fail_rotation = |_c: &rusqlite::Connection| -> anyhow::Result<String> {
                anyhow::bail!("injected rotation failure")
            };

            let mut conn = crate::db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "library_marker", "LIBRARY A").unwrap();
            let backup_a = backup::write_rolling_backup(&conn).expect("backup A");
            let id_a = backup_a.file_name().unwrap().to_str().unwrap().to_string();
            crate::settings::set_string(&conn, "library_marker", "LIBRARY B").unwrap();
            let gen_before = crate::settings::get_library_generation(&conn);

            // RESTORE with a failing rotation: rolled back — still B, same
            // generation, and no phantom undo affordance.
            let err = restore_backup_impl_with(&mut conn, &id_a, &mut fail_rotation)
                .expect_err("rotation failure must fail the restore");
            assert!(
                format!("{err:?}").contains("unchanged"),
                "the refusal reports the library unchanged: {err:?}"
            );
            assert_eq!(
                marker(&conn).as_deref(),
                Some("LIBRARY B"),
                "rolled back to B"
            );
            assert_eq!(
                crate::settings::get_library_generation(&conn),
                gen_before,
                "the previous library keeps its own (still-valid) generation"
            );
            assert!(
                backup::newest_pre_restore_snapshot().unwrap().is_none(),
                "a rolled-back restore leaves no undo affordance"
            );

            // The same restore with the REAL rotation completes.
            restore_backup_impl(&mut conn, &id_a).expect("restore A");
            assert_eq!(marker(&conn).as_deref(), Some("LIBRARY A"));
            let gen_after_restore = crate::settings::get_library_generation(&conn);
            assert_ne!(gen_after_restore, gen_before);

            // UNDO with a failing rotation: rolled back — still A, same
            // generation, and the undo affordance SURVIVES for the retry.
            let err = undo_restore_impl_with(&mut conn, &mut fail_rotation)
                .expect_err("rotation failure must fail the undo");
            assert!(format!("{err:?}").contains("unchanged"));
            assert_eq!(
                marker(&conn).as_deref(),
                Some("LIBRARY A"),
                "undo rolled back to A"
            );
            assert_eq!(
                crate::settings::get_library_generation(&conn),
                gen_after_restore
            );
            assert!(
                backup::newest_pre_restore_snapshot().unwrap().is_some(),
                "the undo affordance survives a rolled-back undo"
            );

            // The same undo with the REAL rotation completes.
            undo_restore_impl(&mut conn).expect("undo restores B");
            assert_eq!(marker(&conn).as_deref(), Some("LIBRARY B"));
            assert_ne!(
                crate::settings::get_library_generation(&conn),
                gen_after_restore
            );
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R9-1: committed data living ONLY in the live WAL survives a promotion
    /// failure injected AFTER the live sidecars were cleared but BEFORE the
    /// rename — because the swap explicitly checkpoints (TRUNCATE) and closes
    /// the live connection, with errors propagated, before any WAL deletion.
    /// The outcome is reported as a sidecar-mutating failure (never
    /// "unchanged") and the pre-restore snapshot is RETAINED.
    #[test]
    fn wal_only_commits_survive_a_failure_after_sidecar_clearing_before_the_rename() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-walonly-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let marker = |conn: &rusqlite::Connection| -> Option<String> {
                crate::settings::get_string(conn, "library_marker")
            };
            // Library A, captured as the restorable backup. Checkpoint so the
            // MAIN FILE carries state A — the next commit is then WAL-only.
            let mut conn = crate::db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "library_marker", "LIBRARY A").unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
            let backup_a = backup::write_rolling_backup(&conn).expect("backup A");
            let id_a = backup_a.file_name().unwrap().to_str().unwrap().to_string();

            // A newer commit that lives ONLY in the WAL: prove it by opening
            // a copy of the MAIN FILE ALONE (no sidecars) — it still says A.
            crate::settings::set_string(&conn, "library_marker", "B-WAL-ONLY").unwrap();
            let live = paths::db_path().unwrap();
            let probe = data.join("main-only-probe.db");
            std::fs::copy(&live, &probe).unwrap();
            {
                let probe_conn = rusqlite::Connection::open(&probe).unwrap();
                assert_eq!(
                    marker(&probe_conn).as_deref(),
                    Some("LIBRARY A"),
                    "precondition: the newest commit exists ONLY in the WAL"
                );
            }

            // Fail AFTER the live sidecars were cleared, BEFORE the rename.
            backup::promotion_test_seam::arm(
                backup::promotion_test_seam::FailPoint::PreRenameDirFsync,
            );
            let err = restore_backup_impl(&mut conn, &id_a)
                .expect_err("the injected pre-rename failure must fail the restore");
            backup::promotion_test_seam::disarm();
            let msg = format!("{err:?}");
            assert!(
                !msg.to_lowercase().contains("unchanged"),
                "a sidecar-mutating failure must never claim 'unchanged': {msg}"
            );
            assert!(
                msg.contains("safety copy has been kept"),
                "the reader is told the safety copy stays: {msg}"
            );

            // The WAL-only commit SURVIVED: the checkpoint folded it into the
            // main file before the WAL was deleted.
            assert_eq!(
                marker(&conn).as_deref(),
                Some("B-WAL-ONLY"),
                "the WAL-only commit survived the failed swap"
            );
            // And it survived INTO THE MAIN FILE — a copy without sidecars
            // carries it now.
            let probe2 = data.join("main-only-probe-2.db");
            std::fs::copy(&live, &probe2).unwrap();
            {
                let probe_conn = rusqlite::Connection::open(&probe2).unwrap();
                assert_eq!(marker(&probe_conn).as_deref(), Some("B-WAL-ONLY"));
            }
            // The pre-restore snapshot is RETAINED (not deleted as bogus).
            assert!(
                backup::newest_pre_restore_snapshot().unwrap().is_some(),
                "the exact pre-restore snapshot is retained after an AuxChanged failure"
            );
        });

        backup::promotion_test_seam::disarm();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R9-1: a manual APPLIED-BUT-UNPROVEN outcome (post-rename fsync failed)
    /// retains the snapshot, reports honestly, and LATCHES the process — no
    /// further command may reach the database until relaunch.
    #[test]
    fn applied_unproven_latches_the_process_and_preserves_the_snapshot() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-unproven-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let marker = |conn: &rusqlite::Connection| -> Option<String> {
                crate::settings::get_string(conn, "library_marker")
            };
            let mut conn = crate::db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "library_marker", "LIBRARY A").unwrap();
            let backup_a = backup::write_rolling_backup(&conn).expect("backup A");
            let id_a = backup_a.file_name().unwrap().to_str().unwrap().to_string();
            crate::settings::set_string(&conn, "library_marker", "LIBRARY B").unwrap();

            assert!(
                crate::db::relaunch_required().is_none(),
                "precondition: no latch before the failure"
            );
            backup::promotion_test_seam::arm(
                backup::promotion_test_seam::FailPoint::PostRenameDirFsync,
            );
            let err = restore_backup_impl(&mut conn, &id_a)
                .expect_err("the unproven promotion must surface as an error");
            backup::promotion_test_seam::disarm();
            let msg = format!("{err:?}");
            assert!(
                msg.contains("Relaunch Throughline"),
                "the reader is told to relaunch: {msg}"
            );

            // The switch APPLIED (candidate live), the snapshot is retained…
            assert_eq!(marker(&conn).as_deref(), Some("LIBRARY A"));
            assert!(
                backup::newest_pre_restore_snapshot().unwrap().is_some(),
                "the undo snapshot is retained after AppliedUnproven"
            );
            // …and the process is LATCHED: commands can no longer reach the
            // database through DbState.
            assert!(crate::db::relaunch_required().is_some());
            let state = crate::db::DbState::new(rusqlite::Connection::open_in_memory().unwrap());
            let refused = state
                .lock()
                .expect_err("a latched process refuses commands");
            assert!(
                format!("{refused:?}").contains("Relaunch Throughline"),
                "the refusal carries the honest message: {refused:?}"
            );
        });

        backup::promotion_test_seam::disarm();
        crate::db::reset_relaunch_for_tests();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// REC-011 R3, the reopen-failure seam: when the swapped-in file will not
    /// reopen, the guard must end up serving the FALLBACK snapshot (the
    /// library exactly as it was) — never the in-memory placeholder, which
    /// would silently show an empty library and lose every write.
    #[test]
    fn failed_reopen_rolls_back_to_the_fallback_snapshot_never_a_placeholder() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-swapfail-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            // A real on-disk library with a recognizable marker row.
            let mut conn = crate::db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "marker", "the real library").unwrap();

            // The fallback: a valid snapshot of that library.
            let fallback = backup::write_pre_restore_snapshot(&conn).expect("snapshot");
            // The candidate: bytes that will NOT open as a database.
            let candidate = data.join("garbage-candidate.db");
            std::fs::write(&candidate, b"definitely not a sqlite database").unwrap();

            // R7-1: a PREPARED promotion catches the garbage during
            // preparation — BEFORE anything replaces the live file. The
            // library is untouched and still served.
            let swapped = swap_live_db_locked(
                &mut conn,
                &candidate,
                &fallback,
                "failed",
                Some(&mut |c: &rusqlite::Connection| crate::settings::rotate_library_generation(c)),
            );
            assert!(swapped.is_err(), "the unopenable candidate must error");
            assert_eq!(
                crate::settings::get_string(&conn, "marker").as_deref(),
                Some("the real library"),
                "preparation failure leaves the live library serving"
            );

            // The UNPREPARED path (how rollbacks promote): the garbage reaches
            // the live file and the reopen-failure rollback restores the
            // fallback snapshot.
            let swapped = swap_live_db_locked(&mut conn, &candidate, &fallback, "failed", None);
            assert!(swapped.is_err(), "the unopenable candidate must error");
            let msg = format!("{:?}", swapped.unwrap_err());
            assert!(
                msg.contains("put back exactly as it was"),
                "the reader is told the rollback happened: {msg}"
            );

            // The guard serves the ROLLED-BACK on-disk library — provably not
            // the in-memory placeholder (the marker row only exists on disk).
            let marker = crate::settings::get_string(&conn, "marker");
            assert_eq!(marker.as_deref(), Some("the real library"));
            // And the live FILE is that library too (a fresh open agrees).
            drop(conn);
            let reopened = crate::db::open_and_migrate().expect("live file reopens");
            assert_eq!(
                crate::settings::get_string(&reopened, "marker").as_deref(),
                Some("the real library")
            );
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }
}

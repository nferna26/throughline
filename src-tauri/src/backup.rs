//! Rolling backup + restore-before-fresh recovery for `reading.db`.
//!
//! **Why this exists.** `reading.db` holds the reader's whole library —
//! books, plans, sessions, and notes. (No book *text* lives here; imported
//! books are separate immutable files. So a backup is small and cheap.) The
//! launch audit named a silently-wiped `reading.db` the #1 data-loss risk:
//! the corruption path renames the bad DB aside and starts a *fresh empty* one,
//! which means a single corruption event erases the reader's entire library.
//! "The first paying reader's reading.db is forever" — so we keep a rolling
//! backup and, on corruption, restore from the newest good backup BEFORE
//! falling through to the fresh-DB behavior.
//!
//! Two hooks, both driven from the launch path (`open_db_resilient`):
//!
//! 1. [`write_rolling_backup`] — after a clean open+migrate, write a consistent
//!    copy of the live DB with SQLite `VACUUM INTO` (not a raw file copy, which
//!    would race the WAL) into `<appdata>/backups/reading-YYYYMMDD-HHMMSS.db`,
//!    then keep only the newest [`KEEP_BACKUPS`] and delete older ones. Runs at
//!    most once per launch and is fast for a small DB.
//! 2. [`try_restore_newest_backup`] — in the corruption path, before the
//!    rename-aside + fresh-DB step, try the newest backup: if it opens, passes
//!    `PRAGMA integrity_check`, and migrates cleanly, copy it into place as the
//!    live DB so the reader loses only since-last-backup, not everything.
//!
//! No schema change, no new dependency, idempotent, and safe to run every
//! launch. Logs describe *what happened* only — never any row content.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

use crate::{migrations, paths};

/// How many good backups to retain. The newest is the restore source; the
/// second is a safety net in case the newest was itself taken moments before a
/// problem surfaced. Older ones are pruned every launch.
pub const KEEP_BACKUPS: usize = 2;

/// Filename prefix + extension for rolling backups. The timestamp between them
/// (`YYYYMMDD-HHMMSS`) sorts lexically in chronological order, so "newest" is
/// just the lexical max.
const BACKUP_PREFIX: &str = "reading-";
const BACKUP_EXT: &str = "db";

/// Write a consistent copy of the live DB and prune old backups, keeping the
/// newest [`KEEP_BACKUPS`]. Best-effort: a backup failure must never break
/// launch, so the caller logs and proceeds. Returns the path written on success.
///
/// Uses `VACUUM INTO`, which produces a transactionally-consistent snapshot of
/// the database even while WAL is active — unlike a raw file copy, which could
/// capture a torn page set mid-checkpoint.
pub fn write_rolling_backup(conn: &Connection) -> Result<PathBuf> {
    let dir = paths::backups_dir()?;
    std::fs::create_dir_all(&dir).context("create backups dir")?;

    let dest = dir.join(format!(
        "{}{}.{}",
        BACKUP_PREFIX,
        timestamp_slug(),
        BACKUP_EXT
    ));

    // VACUUM INTO refuses to overwrite an existing file. In the vanishingly
    // unlikely case of a same-second collision on a prior launch, remove the
    // stale file first so the backup still succeeds.
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }

    // `VACUUM INTO ?` takes the destination path as a bound parameter.
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])
        .context("VACUUM INTO backup")?;

    prune_old_backups(&dir, KEEP_BACKUPS)?;
    Ok(dest)
}

/// Delete all but the newest `keep` backups in `dir`. Only files matching the
/// rolling-backup naming scheme are ever considered, so nothing else in the
/// directory is touched.
fn prune_old_backups(dir: &Path, keep: usize) -> Result<()> {
    let mut backups = list_backups(dir)?;
    // Newest last (lexical == chronological); drop from the front.
    backups.sort();
    while backups.len() > keep {
        let victim = backups.remove(0);
        let _ = std::fs::remove_file(&victim);
    }
    Ok(())
}

/// All rolling-backup files in `dir`, oldest-first by name. A missing directory
/// yields an empty list (no backups yet is a normal first-launch state).
pub fn list_backups(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e).context("read backups dir"),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if is_backup_file(&path) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn is_backup_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    name.starts_with(BACKUP_PREFIX) && name.ends_with(&format!(".{BACKUP_EXT}"))
}

/// Try to restore the live DB from the newest usable backup. Returns:
/// - `Ok(Some(path))` — a backup was validated and copied into place as the
///   live `reading.db`; the caller can re-open and proceed with recovered rows.
/// - `Ok(None)` — no backup was usable (none exist, or every candidate failed
///   validation); the caller falls through to rename-aside + fresh DB.
///
/// A backup is "usable" only if it opens, passes `PRAGMA integrity_check`, AND
/// migrates cleanly — so we never trade one corrupt DB for another. Candidates
/// are tried newest-first; a bad newest backup falls back to the next-newest.
pub fn try_restore_newest_backup() -> Result<Option<PathBuf>> {
    let dir = paths::backups_dir()?;
    let live = paths::db_path()?;
    let mut backups = list_backups(&dir)?;
    // Newest first.
    backups.sort();
    backups.reverse();

    for candidate in backups {
        match backup_is_usable(&candidate) {
            Ok(true) => {
                restore_into_place(&candidate, &live)
                    .with_context(|| format!("restore backup into {live:?}"))?;
                return Ok(Some(candidate));
            }
            Ok(false) => {
                tracing::warn!("backup failed validation; trying older backup");
            }
            Err(e) => {
                tracing::warn!("backup could not be validated ({e:#}); trying older backup");
            }
        }
    }
    Ok(None)
}

/// True iff `candidate` opens, passes `PRAGMA integrity_check`, and migrates
/// cleanly. Opened read-only-ish (we never write the candidate itself; migrate
/// runs against the *copy* we place, not here — here we only prove the file is
/// a healthy SQLite DB whose schema we can bring current).
fn backup_is_usable(candidate: &Path) -> Result<bool> {
    let conn = Connection::open(candidate).context("open backup candidate")?;
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .context("integrity_check on backup")?;
    if ok != "ok" {
        return Ok(false);
    }
    // A healthy file whose schema we can migrate to current is genuinely
    // restorable. Migrations are idempotent, so running them here is safe; we
    // discard this connection and copy the original file into place.
    migrations::apply_pending(&conn).context("migrate backup candidate")?;
    Ok(true)
}

/// Copy a validated backup over the live DB path, and clear any stale WAL/SHM
/// sidecars so the restored file is read as-is on next open. Done as a temp
/// copy + atomic rename so a crash mid-restore can't leave a half-written DB.
fn restore_into_place(backup: &Path, live: &Path) -> Result<()> {
    let parent = live
        .parent()
        .ok_or_else(|| anyhow::anyhow!("db path has no parent: {live:?}"))?;
    std::fs::create_dir_all(parent).context("ensure data dir for restore")?;

    let tmp = live.with_extension(format!("db.restore-tmp.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    std::fs::copy(backup, &tmp).context("copy backup to temp")?;
    std::fs::rename(&tmp, live).context("rename restored DB into place")?;

    // Remove stale WAL/SHM belonging to the (now-replaced) corrupt DB. The
    // restored file is a self-contained VACUUM INTO snapshot with no pending WAL.
    let _ = std::fs::remove_file(live.with_extension("db-wal"));
    let _ = std::fs::remove_file(live.with_extension("db-shm"));
    Ok(())
}

/// `YYYYMMDD-HHMMSS` in local time, for human-greppable, chronologically-sorting
/// backup names. Local time is fine here: these names are never parsed back into
/// instants, only sorted lexically and shown in logs.
fn timestamp_slug() -> String {
    use chrono::Local;
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Open an isolated DB under a fresh temp data dir, returning the env guard
    /// so the caller controls when the override is released. All paths
    /// (`db_path`, `backups_dir`) then resolve under the temp dir.
    fn isolated_open() -> (std::sync::MutexGuard<'static, ()>, Connection, PathBuf) {
        let g = paths::lock_env_for_test();
        let unique = format!(
            "tl-backup-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        );
        let data = std::env::temp_dir().join(&unique);
        let _ = std::fs::remove_dir_all(&data);
        unsafe {
            std::env::set_var("THROUGHLINE_DATA_DIR", &data);
        }
        let conn = crate::db::open_and_migrate().expect("open_and_migrate");
        (g, conn, data)
    }

    fn cleanup(data: &Path) {
        unsafe {
            std::env::remove_var("THROUGHLINE_DATA_DIR");
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        let _ = std::fs::remove_dir_all(data);
    }

    fn seed_book(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES (?1,'T','txt','/p','h','2026-01-01')",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn clean_open_creates_a_backup() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b1");
        let dest = write_rolling_backup(&conn).expect("backup");
        assert!(dest.exists(), "backup file should exist at {dest:?}");
        assert!(
            dest.starts_with(&data),
            "backup {dest:?} must live under the app data dir {data:?}"
        );
        // The backup is a real, healthy SQLite DB containing the seeded row.
        let bconn = Connection::open(&dest).unwrap();
        let n: i64 = bconn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "backup must contain the reader's row");
        drop(conn);
        drop(g);
        cleanup(&data);
    }

    #[test]
    fn rotation_keeps_only_the_last_n() {
        let (g, conn, data) = isolated_open();
        let dir = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        // Plant more than KEEP_BACKUPS backup-named files with distinct,
        // sortable names, then prune.
        for i in 0..(KEEP_BACKUPS + 3) {
            let f = dir.join(format!("{BACKUP_PREFIX}2026010{i}-000000.{BACKUP_EXT}"));
            std::fs::write(&f, b"x").unwrap();
        }
        // A non-backup file must survive pruning untouched.
        let keep_me = dir.join("notes.txt");
        std::fs::write(&keep_me, b"unrelated").unwrap();

        prune_old_backups(&dir, KEEP_BACKUPS).unwrap();

        let remaining = list_backups(&dir).unwrap();
        assert_eq!(
            remaining.len(),
            KEEP_BACKUPS,
            "rotation must keep exactly KEEP_BACKUPS backups, got {remaining:?}"
        );
        // The newest ones survive (highest indices).
        let names: Vec<String> = remaining
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.contains("20260104")));
        assert!(keep_me.exists(), "non-backup files must not be pruned");
        drop(conn);
        drop(g);
        cleanup(&data);
    }

    #[test]
    fn corrupt_db_with_good_backup_recovers_rows_not_wipes() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b_recovered");
        write_rolling_backup(&conn).expect("backup");
        // Drop the live connection, then corrupt the live DB on disk.
        drop(conn);
        let live = paths::db_path().unwrap();
        let _ = std::fs::remove_file(live.with_extension("db-wal"));
        let _ = std::fs::remove_file(live.with_extension("db-shm"));
        std::fs::write(&live, b"this is not a sqlite database at all").unwrap();

        // Restore path: newest good backup is validated and copied into place.
        let restored = try_restore_newest_backup().expect("restore call");
        assert!(
            restored.is_some(),
            "a good backup should have been restored"
        );

        // The live DB now opens and still has the reader's row — not wiped.
        let conn2 = crate::db::open_and_migrate().expect("open after restore");
        let n: i64 = conn2
            .query_row(
                "SELECT COUNT(*) FROM books WHERE id='b_recovered'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "reader's row must survive corruption via restore");
        drop(conn2);
        drop(g);
        cleanup(&data);
    }

    #[test]
    fn corrupt_db_with_no_backup_falls_through_to_none() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b1");
        drop(conn);
        // No backup was ever written. Corrupt the live DB.
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"garbage, not sqlite").unwrap();

        let restored = try_restore_newest_backup().expect("restore call");
        assert!(
            restored.is_none(),
            "with no usable backup, restore must report None (caller goes fresh)"
        );
        drop(g);
        cleanup(&data);
    }

    #[test]
    fn corrupt_backup_is_rejected_and_falls_through() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b1");
        drop(conn);
        // Plant a corrupt "backup" file and corrupt the live DB.
        let dir = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{BACKUP_PREFIX}20260101-000000.{BACKUP_EXT}")),
            b"not a database either",
        )
        .unwrap();
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"corrupt live").unwrap();

        let restored = try_restore_newest_backup().expect("restore call");
        assert!(
            restored.is_none(),
            "a corrupt backup must be rejected, not restored"
        );
        drop(g);
        cleanup(&data);
    }

    #[test]
    fn newest_good_backup_wins_over_older_corrupt_one() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b_newest");
        // Good newest backup.
        write_rolling_backup(&conn).expect("backup");
        drop(conn);
        let dir = paths::backups_dir().unwrap();
        // Plant an OLDER (lexically smaller) corrupt backup that must be ignored
        // because the newer good one is preferred.
        std::fs::write(
            dir.join(format!("{BACKUP_PREFIX}20000101-000000.{BACKUP_EXT}")),
            b"ancient corrupt",
        )
        .unwrap();
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"corrupt").unwrap();

        let restored = try_restore_newest_backup().expect("restore call");
        assert!(restored.is_some(), "the newest GOOD backup should restore");
        let conn2 = crate::db::open_and_migrate().expect("open after restore");
        let n: i64 = conn2
            .query_row("SELECT COUNT(*) FROM books WHERE id='b_newest'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
        drop(conn2);
        drop(g);
        cleanup(&data);
    }

    /// Backups must never land in the export tree — only under app data.
    #[test]
    fn backups_never_land_in_export_dir() {
        let g = paths::lock_env_for_test();
        let unique = format!("tl-backup-exp-{}", std::process::id());
        let data = std::env::temp_dir().join(format!("{unique}-data"));
        let export = std::env::temp_dir().join(format!("{unique}-export"));
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&export);
        unsafe {
            std::env::set_var("THROUGHLINE_DATA_DIR", &data);
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export);
        }
        let conn = crate::db::open_and_migrate().expect("open");
        let dest = write_rolling_backup(&conn).expect("backup");
        assert!(
            dest.starts_with(&data),
            "backup {dest:?} must be under data dir {data:?}"
        );
        assert!(
            !dest.starts_with(&export),
            "backup {dest:?} must NOT be under export dir {export:?}"
        );
        // The export dir must not have been created by the backup at all.
        assert!(
            !export.exists(),
            "backup must not create the export tree {export:?}"
        );
        drop(conn);
        drop(g);
        cleanup(&data);
        let _ = std::fs::remove_dir_all(&export);
    }
}

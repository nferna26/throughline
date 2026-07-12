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

use crate::{migrations, paths, settings};

/// R7-1: the injectable generation-rotation seam threaded through every
/// library-promotion path (restore/undo/automatic recovery).
pub(crate) type RotateFn<'a> = &'a mut dyn FnMut(&Connection) -> Result<String>;

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
    // R6-2: entry errors PROPAGATE. `flatten()` silently dropped an erroring
    // entry — in automatic recovery that could hide the newest coherent
    // candidate and walk on to an older library (or none) off a transient
    // io error.
    for entry in rd {
        let path = entry.context("read a backups dir entry")?.path();
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

/// Filename prefix for the one-shot safety snapshot written just before a
/// reader-initiated restore. Deliberately does NOT start with [`BACKUP_PREFIX`],
/// so it is invisible to the rolling list/prune logic — restoring can never
/// prune away the very backup being restored.
const PRE_RESTORE_PREFIX: &str = "pre-restore-";

/// When the backup at `path` was taken, parsed from its own filename
/// (`reading-YYYYMMDD-HHMMSS.db`, local time). None for a name that doesn't
/// carry a well-formed timestamp.
pub fn backup_taken_at(path: &Path) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    let name = path.file_name()?.to_str()?;
    let stamp = name
        .strip_prefix(BACKUP_PREFIX)?
        .strip_suffix(&format!(".{BACKUP_EXT}"))?;
    let naive = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    chrono::Local.from_local_datetime(&naive).single()
}

/// RFC3339 timestamp of the newest rolling backup, or None when there isn't
/// one yet. This is what the Files pane shows as "last backup …".
pub fn newest_backup_taken_at() -> Result<Option<String>> {
    let dir = paths::backups_dir()?;
    let backups = list_backups(&dir)?;
    Ok(backups
        .last()
        .and_then(|p| backup_taken_at(p))
        .map(|t| t.to_rfc3339()))
}

/// How stale the newest backup may get while the app stays open before the
/// in-app schedule writes a fresh one. One day: the launch backup already
/// covers normal open-daily use; this catches the always-open Mac.
pub const BACKUP_INTERVAL: chrono::Duration = chrono::Duration::hours(24);

/// Whether the schedule should write a backup now. Pure, so the schedule's
/// decision is testable without a filesystem: due when backups are enabled and
/// there is no backup yet, or the newest is at least [`BACKUP_INTERVAL`] old.
pub fn backup_due(
    enabled: bool,
    newest: Option<chrono::DateTime<chrono::Local>>,
    now: chrono::DateTime<chrono::Local>,
) -> bool {
    if !enabled {
        return false;
    }
    match newest {
        None => true,
        Some(t) => now.signed_duration_since(t) >= BACKUP_INTERVAL,
    }
}

/// Resolve a reader-picked backup id (a bare rolling-backup file name) to its
/// path under the backups dir. Refuses anything that isn't a single, plain
/// backup-scheme file name — an id flows in from IPC, so a path separator or
/// an off-scheme name must never reach the filesystem join.
pub fn resolve_backup_by_id(id: &str) -> Result<PathBuf> {
    let mut comps = Path::new(id).components();
    let single = matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    );
    let candidate = paths::backups_dir()?.join(id);
    if !single || !is_backup_file(&candidate) {
        anyhow::bail!("not a backup name: {id:?}");
    }
    if !candidate.is_file() {
        anyhow::bail!("backup not found: {id:?}");
    }
    Ok(candidate)
}

/// Prove a reader-picked backup is genuinely restorable (opens, integrity-checks,
/// migrates). Public face of [`backup_is_usable`] for the restore command.
pub fn validate_backup(candidate: &Path) -> Result<bool> {
    backup_is_usable(candidate)
}

/// Snapshot the CURRENT live DB right before a restore replaces it, so a
/// mistaken restore is itself undoable. Named outside the rolling scheme (see
/// [`PRE_RESTORE_PREFIX`]).
///
/// R4: creation ONLY — this function never prunes. The old create-and-prune
/// coupling meant `cmd_undo_restore`'s safety snapshot DELETED the very undo
/// candidate it had just selected, before the swap ran. Pruning is a separate,
/// caller-timed step ([`prune_pre_restore_snapshots_except`]) that runs only
/// AFTER a successful swap.
pub fn write_pre_restore_snapshot(conn: &Connection) -> Result<PathBuf> {
    write_pre_restore_snapshot_stamped(conn, &timestamp_slug())
}

/// [`write_pre_restore_snapshot`] with the timestamp injectable, so tests can
/// prove both same-second and different-second behavior without sleeping.
/// COLLISION-PROOF: a pid + counter suffix is appended until the name is free
/// — a restore and an Undo inside the same second must never overwrite each
/// other's snapshots.
/// R5: COLLISION-PROOF and CREATION-ORDERED — every name leads with a
/// zero-padded, strictly-increasing ORDINAL (max existing + 1), so "newest"
/// is an explicit creation-order fact, never an accident of how pids and
/// second-granular stamps sort lexically. The stamp + pid stay in the name
/// for human forensics only. The snapshot directory is fsynced after the
/// write so the new name is durable before any caller relies on it.
pub(crate) fn write_pre_restore_snapshot_stamped(
    conn: &Connection,
    stamp: &str,
) -> Result<PathBuf> {
    let dir = paths::backups_dir()?;
    std::fs::create_dir_all(&dir).context("create backups dir")?;
    let ordinal = next_snapshot_ordinal(&dir)?;
    let mut n = 0u32;
    let dest = loop {
        let name = if n == 0 {
            format!(
                "{PRE_RESTORE_PREFIX}{ordinal:06}-{stamp}-{}.{BACKUP_EXT}",
                std::process::id()
            )
        } else {
            format!(
                "{PRE_RESTORE_PREFIX}{ordinal:06}-{stamp}-{}-{n}.{BACKUP_EXT}",
                std::process::id()
            )
        };
        let c = dir.join(&name);
        if !c.exists() {
            break c;
        }
        n += 1;
        if n > 1000 {
            anyhow::bail!("could not find a free pre-restore snapshot name");
        }
    };
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])
        .context("VACUUM INTO pre-restore snapshot")?;
    std::fs::File::open(&dir)
        .and_then(|d| d.sync_all())
        .context("fsync backups dir after snapshot")?;
    Ok(dest)
}

/// The creation ordinal embedded in a snapshot name (0 for legacy names that
/// predate ordinals — always older than any ordinal-named snapshot).
fn snapshot_ordinal(name: &str) -> u64 {
    name.strip_prefix(PRE_RESTORE_PREFIX)
        .and_then(|rest| rest.get(..6))
        .and_then(|d| d.parse::<u64>().ok())
        .unwrap_or(0)
}

fn next_snapshot_ordinal(dir: &Path) -> Result<u64> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(1),
        Err(e) => return Err(e).context("read backups dir for snapshot ordinal"),
    };
    let mut max = 0u64;
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(PRE_RESTORE_PREFIX) {
            max = max.max(snapshot_ordinal(&name));
        }
    }
    Ok(max + 1)
}

/// Remove every pre-restore snapshot EXCEPT the given keepers. Called only
/// after a successful swap — never as a side effect of creating a snapshot.
/// R5: removal failures PROPAGATE (a leftover snapshot is an undo affordance
/// pointing at stale state — the caller decides how loudly to surface it),
/// and the directory is fsynced so completed removals are durable.
pub fn prune_pre_restore_snapshots_except(keep: &[&Path]) -> Result<()> {
    let dir = paths::backups_dir()?;
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).context("read backups dir"),
    };
    let mut first_err: Option<anyhow::Error> = None;
    for entry in rd.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with(PRE_RESTORE_PREFIX) && !keep.contains(&p.as_path()) {
            if let Err(e) = std::fs::remove_file(&p) {
                if first_err.is_none() {
                    first_err = Some(anyhow::Error::from(e).context("prune pre-restore snapshot"));
                }
            }
        }
    }
    let _ = std::fs::File::open(&dir).and_then(|d| d.sync_all());
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Copy a validated backup over the live DB (the reader-initiated restore).
/// The caller must have closed every live connection first; this only moves
/// files. Atomic-rename semantics come from [`restore_into_place`].
pub fn restore_backup_file(candidate: &Path) -> Result<()> {
    let live = paths::db_path()?;
    restore_into_place(candidate, &live)
}

/// R7-1: the injectable-promotion variant for the command layer. `rotate =
/// None` restores a ROLLBACK snapshot as-it-was (its token is the one the
/// reader's drafts were typed under). R8-1/R9-1: the error is TYPED — see
/// [`PromotionError`] for the three outcome classes.
pub(crate) fn restore_backup_file_prepared(
    candidate: &Path,
    rotate: Option<RotateFn<'_>>,
) -> std::result::Result<(), PromotionError> {
    let live = paths::db_path().map_err(PromotionError::Untouched)?;
    restore_into_place_prepared(candidate, &live, rotate)
}

/// R5: the TYPED outcome of the automatic restore attempt. `NoneUsable`
/// distinguishes "every candidate was definitively invalid" (fresh start is
/// legitimate) from "at least one candidate could not even be assessed"
/// (`any_unassessable` — the caller must FAIL CLOSED before any clear/fresh:
/// an environmental error must never authorize an empty library).
#[derive(Debug)]
pub enum RestoreOutcome {
    Restored(PathBuf),
    NoneUsable { any_unassessable: bool },
}

impl RestoreOutcome {
    pub fn restored(&self) -> Option<&PathBuf> {
        match self {
            RestoreOutcome::Restored(p) => Some(p),
            RestoreOutcome::NoneUsable { .. } => None,
        }
    }
}

/// R9-1: the typed error of the automatic restore attempt. The promotion
/// classification is PRESERVED end-to-end so the launch path can hard-stop
/// TRUTHFULLY: an `After` failure means the restored library IS at the live
/// path — a "nothing was changed" message would be a lie.
#[derive(Debug)]
pub enum RestoreError {
    Promotion(PromotionError),
    /// Everything else: listing backups, resolving paths, assessing.
    Env(anyhow::Error),
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `{:#}` on the inner anyhow prints the full context chain; callers
        // format this error with `{e}` or `{e:#}` interchangeably.
        match self {
            RestoreError::Promotion(PromotionError::Untouched(e)) => {
                write!(f, "promotion aborted (live DB untouched): {e:#}")
            }
            RestoreError::Promotion(PromotionError::AuxMutated(e)) => write!(
                f,
                "promotion aborted (live DB file untouched; its WAL/SHM sidecars were cleared): {e:#}"
            ),
            RestoreError::Promotion(PromotionError::After(e)) => write!(
                f,
                "PROMOTED, but the transition could not be proven: {e:#}"
            ),
            RestoreError::Env(e) => write!(f, "{e:#}"),
        }
    }
}

/// Try to restore the live DB from the newest usable backup (see
/// [`RestoreOutcome`]). A backup is "usable" only if it opens, passes
/// `PRAGMA integrity_check`, migrates cleanly on a disposable probe, AND every
/// book row it lists reads through the production path. Candidates are tried
/// newest-first; a definitively-invalid newest falls back to the next-newest.
/// When an OLDER coherent candidate is chosen past an unassessable newer one,
/// that is logged loudly (the restore may be older than the best data).
pub fn try_restore_newest_backup() -> std::result::Result<RestoreOutcome, RestoreError> {
    try_restore_newest_backup_with(&mut |c| settings::rotate_library_generation(c))
}

/// R7-1: injectable-rotation variant. The rotation happens on the PREPARED
/// candidate copy BEFORE promotion (see [`restore_into_place_prepared`]) — a
/// rotation failure aborts with the live path byte-untouched, never with a
/// replaced library running under the previous library's token.
pub(crate) fn try_restore_newest_backup_with(
    rotate: RotateFn<'_>,
) -> std::result::Result<RestoreOutcome, RestoreError> {
    let dir = paths::backups_dir().map_err(RestoreError::Env)?;
    let live = paths::db_path().map_err(RestoreError::Env)?;
    let mut backups = list_backups(&dir).map_err(RestoreError::Env)?;
    // Newest first.
    backups.sort();
    backups.reverse();

    // REQUIRED precondition (REC-011): the caller (`open_db_resilient`) has
    // already preserved the corrupt live DB + sidecars — on preservation
    // failure it fails loudly and never reaches here.
    let mut any_unassessable = false;
    for candidate in backups {
        match assess_backup(&candidate) {
            BackupAssessment::Coherent => {
                if any_unassessable {
                    tracing::warn!(
                        "restoring an OLDER coherent backup past a newer candidate that could not be assessed"
                    );
                }
                restore_into_place_prepared(&candidate, &live, Some(rotate))
                    .map_err(RestoreError::Promotion)?;
                return Ok(RestoreOutcome::Restored(candidate));
            }
            BackupAssessment::Invalid => {
                tracing::warn!("backup candidate definitively unusable; trying older backup");
            }
            BackupAssessment::Unassessable => {
                any_unassessable = true;
                tracing::warn!("backup candidate could NOT be assessed (environment); continuing");
            }
        }
    }
    Ok(RestoreOutcome::NoneUsable { any_unassessable })
}

/// A DISPOSABLE, MIGRATED copy of a backup candidate (REC-011 / R4). The
/// candidate's own bytes are never touched: `apply_pending` WRITES, so running
/// it on the candidate itself could damage the very backup being validated
/// (possibly the reader's only one). Every deep candidate query runs against
/// THIS migrated copy — a pre-v004 backup (no `assignable` column) is
/// perfectly restorable after migration, and querying the original old-schema
/// file would wrongly refuse it. Files are cleaned up on Drop.
pub(crate) struct MigratedProbe {
    path: PathBuf,
}

impl MigratedProbe {
    /// Copy, open, integrity-check, and migrate. `Ok(None)` = the candidate is
    /// genuinely corrupt (fails integrity); `Err` = environmental failure.
    fn create(candidate: &Path) -> Result<Option<Self>> {
        let path = candidate.with_extension(format!(
            "validate-tmp-{}-{}.db",
            std::process::id(),
            timestamp_slug()
        ));
        let _ = std::fs::remove_file(&path);
        std::fs::copy(candidate, &path).context("copy backup for validation")?;
        let probe = MigratedProbe { path };
        let conn = Connection::open(&probe.path).context("open backup validation copy")?;
        // R5/R6: an integrity check that errors with a BYTE-LEVEL verdict
        // ("file is not a database", corrupt pages) is DEFINITIVE about the
        // copied bytes — the copy itself succeeded. But the engine failing to
        // RUN the check (io, locks, permissions, memory, disk) says nothing
        // about the candidate: that is environmental and must fail closed,
        // never count as "this backup is bad, move on".
        let ok: String = match conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)) {
            Ok(v) => v,
            Err(e) if integrity_error_is_definitive(&e) => return Ok(None),
            Err(e) => return Err(e).context("run integrity check on validation copy"),
        };
        if ok != "ok" {
            return Ok(None); // probe Drop cleans up
        }
        migrations::apply_pending(&conn).context("migrate backup validation copy")?;
        Ok(Some(probe))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for MigratedProbe {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let s = self.path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(format!("{s}-wal"));
        let _ = std::fs::remove_file(format!("{s}-shm"));
    }
}

/// R6-2: is this integrity-check ERROR a definitive verdict about the file's
/// bytes? Only corruption-class codes are — everything else (SQLITE_IOERR,
/// SQLITE_BUSY, SQLITE_PERM, SQLITE_CANTOPEN, SQLITE_NOMEM, SQLITE_FULL, …)
/// is the environment failing to produce a verdict at all.
fn integrity_error_is_definitive(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(f, _) if matches!(
            f.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        )
    )
}

/// R6-2: is this candidate-QUERY failure a definitive verdict about the
/// backup's bytes/schema (undecodable rows, corrupt pages) rather than the
/// environment failing to run the query (open/io/locks)? Automatic recovery
/// maps definitive → `Invalid` and everything else → `Unassessable`.
fn query_failure_is_definitive(e: &anyhow::Error) -> bool {
    for cause in e.chain() {
        if let Some(sql) = cause.downcast_ref::<rusqlite::Error>() {
            return match sql {
                rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::InvalidColumnName(_)
                | rusqlite::Error::InvalidColumnIndex(_)
                | rusqlite::Error::FromSqlConversionFailure(..)
                | rusqlite::Error::IntegralValueOutOfRange(..) => true,
                rusqlite::Error::SqliteFailure(f, _) => matches!(
                    f.code,
                    rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
                ),
                _ => false,
            };
        }
    }
    false
}

/// True iff `candidate` opens, passes `PRAGMA integrity_check`, and migrates
/// cleanly — proven against a disposable copy ([`MigratedProbe`]).
fn backup_is_usable(candidate: &Path) -> Result<bool> {
    Ok(MigratedProbe::create(candidate)?.is_some())
}

/// The file operations `preserve_corrupt_live` performs, as a seam so tests
/// can inject a failure AFTER EVERY SINGLE OPERATION and prove the originals
/// stay byte-identical. Production uses [`RealPreserveFs`].
pub(crate) trait PreserveFs {
    fn copy(&mut self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn fsync_file(&mut self, p: &Path) -> std::io::Result<()>;
    fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn fsync_dir(&mut self, p: &Path) -> std::io::Result<()>;
    // R5: the crash-safe fresh-start transition also writes its durable marker
    // and removes the cleared triple through the same injectable seam.
    fn write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<()>;
    fn remove_file(&mut self, p: &Path) -> std::io::Result<()>;
    // R9-2: staging cleanup (tmp/aside directories) goes through the seam too,
    // so revert-path failures are injectable and provable.
    fn remove_dir_all(&mut self, p: &Path) -> std::io::Result<()>;
    // R10-2/R11-3: EXCLUSIVE no-follow creation (O_CREAT|O_EXCL) — the
    // atomic replacement for metadata-check-then-write. The exclusive
    // descriptor stays OWNED through write + fsync (never closed and
    // reopened by pathname), and its (device, inode) identity is returned so
    // the caller can verify the entry that later lands at the final name IS
    // this exclusively-written record.
    fn create_new_write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<(u64, u64)>;
}

pub(crate) struct RealPreserveFs;
impl PreserveFs for RealPreserveFs {
    fn copy(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::copy(from, to).map(|_| ())
    }
    fn fsync_file(&mut self, p: &Path) -> std::io::Result<()> {
        std::fs::File::open(p)?.sync_all()
    }
    fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }
    fn fsync_dir(&mut self, p: &Path) -> std::io::Result<()> {
        std::fs::File::open(p)?.sync_all()
    }
    fn write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::write(p, bytes)
    }
    fn remove_file(&mut self, p: &Path) -> std::io::Result<()> {
        std::fs::remove_file(p)
    }
    fn remove_dir_all(&mut self, p: &Path) -> std::io::Result<()> {
        crate::import::remove_book_dir_quiet(p);
        match std::fs::symlink_metadata(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
            Ok(_) => Err(std::io::Error::other(format!("{p:?} survived removal"))),
        }
    }
    fn create_new_write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<(u64, u64)> {
        use std::io::Write;
        use std::os::unix::fs::MetadataExt;
        let mut f = std::fs::File::options()
            .write(true)
            .create_new(true)
            .open(p)?;
        f.write_all(bytes)?;
        // Durability on the SAME exclusive descriptor — a pathname reopen
        // could be redirected between close and fsync.
        f.sync_all()?;
        let m = f.metadata()?;
        Ok((m.dev(), m.ino()))
    }
}

/// REC-011: preserve the (presumed corrupt) live DB and EVERY existing WAL/SHM
/// sidecar under a UNIQUE name, fsynced, as a REQUIRED precondition of any
/// recovery: corrupt bytes are forensic material a professional may still
/// salvage rows from. On ANY failure here the caller must replace NOTHING and
/// fail loudly — a fresh/restored DB over unsaved corrupt bytes is data loss.
/// Returns the preserved DB path (None when there was no live file).
pub fn preserve_corrupt_live(live: &Path) -> Result<Option<PathBuf>> {
    preserve_corrupt_live_with(live, &mut RealPreserveFs)
}

/// [`preserve_corrupt_live`] over an injectable [`PreserveFs`].
///
/// COPY-BASED, in three stages — the ORIGINALS ARE NEVER TOUCHED, period
/// (R4; the old rename-based version mutated the live triple as its FIRST
/// step, and an intermediate revision removed the originals after copying,
/// which meant a failure between removal and recovery left NO live file, so
/// the next launch silently created a fresh empty library):
///
/// 1. COPY each existing member (db, then -wal, then -shm) to a temp name
///    beside the destination, fsyncing each copy;
/// 2. atomically RENAME each temp to its final unique preserved name;
/// 3. fsync the directory — only now is the preservation durable.
///
/// The corrupt originals STAY at the live path. Recovery then either replaces
/// the live DB via the ATOMIC restore (`restore_into_place` renames over it
/// and clears its sidecars), or — when no backup is usable — the caller
/// explicitly clears the live triple (`clear_live_db_after_preservation`)
/// before starting fresh. A failure ANYWHERE here (including the final
/// directory fsync) leaves the originals byte-identical AND present, so a
/// relaunch re-enters corruption recovery instead of finding an absent DB and
/// minting an empty library. At every single operation boundary, a complete
/// copy of the corrupt bytes exists on disk.
pub(crate) fn preserve_corrupt_live_with(
    live: &Path,
    ops: &mut dyn PreserveFs,
) -> Result<Option<PathBuf>> {
    if !live.exists() {
        return Ok(None);
    }
    let parent = live
        .parent()
        .ok_or_else(|| anyhow::anyhow!("live DB path has no parent: {live:?}"))?;

    // A UNIQUE destination stem: timestamp + pid, with a counter suffix if a
    // previous preservation from the same second exists. Never overwrite an
    // earlier preservation — each one is a distinct forensic artifact.
    let stamp = format!("{}-{}", timestamp_slug(), std::process::id());
    let mut n = 0u32;
    let dest = loop {
        let name = if n == 0 {
            format!("reading.corrupt-{stamp}.db")
        } else {
            format!("reading.corrupt-{stamp}-{n}.db")
        };
        let c = live.with_file_name(&name);
        let side_free = ["wal", "shm"]
            .iter()
            .all(|ext| !c.with_file_name(format!("{name}-{ext}")).exists());
        if !c.exists() && side_free {
            break c;
        }
        n += 1;
        if n > 1000 {
            anyhow::bail!("could not find a free preservation name beside {live:?}");
        }
    };
    let dest_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("reading.corrupt.db")
        .to_string();

    // The members that exist right now: (original, final preserved name).
    let live_str = live.to_string_lossy().to_string();
    let mut members: Vec<(PathBuf, PathBuf)> = vec![(live.to_path_buf(), dest.clone())];
    for ext in ["wal", "shm"] {
        let side = PathBuf::from(format!("{live_str}-{ext}"));
        if side.exists() {
            members.push((side, live.with_file_name(format!("{dest_name}-{ext}"))));
        }
    }
    let tmp_for = |kept: &Path| -> PathBuf {
        let name = kept.file_name().and_then(|s| s.to_str()).unwrap_or("kept");
        kept.with_file_name(format!("{name}.copy-tmp"))
    };

    // Stages 1–3, with temp sweep on failure. Every op goes through `ops`.
    let staged = (|| -> Result<()> {
        for (orig, kept) in &members {
            let tmp = tmp_for(kept);
            ops.copy(orig, &tmp)
                .with_context(|| format!("copy {:?} for preservation", orig.file_name()))?;
            ops.fsync_file(&tmp).context("fsync preservation copy")?;
        }
        for (_, kept) in &members {
            ops.rename(&tmp_for(kept), kept)
                .context("finalize preservation copy")?;
        }
        ops.fsync_dir(parent)
            .context("fsync data dir after preserving corrupt DB")?;
        Ok(())
    })();
    if let Err(e) = staged {
        for (_, kept) in &members {
            let _ = std::fs::remove_file(tmp_for(kept));
        }
        return Err(e);
    }
    Ok(Some(dest))
}

// ── R5: the CRASH-SAFE fresh-start transition ────────────────────────────────
// The decision "no backup is usable — start fresh" must survive a crash at any
// point without being mistaken for an ordinary missing DB (which would
// silently mint an empty library with none of the recovery context). A
// DURABLE MARKER brackets the transition:
//
//   1. begin_fresh_start      — write + fsync the marker, fsync the dir;
//   2. clear_live_db_after_preservation — remove db/-wal/-shm, fsync the dir;
//   3. (caller creates the fresh DB at the live path);
//   4. finish_fresh_start     — remove the marker, fsync the dir.
//
// INVARIANT at every boundary: the marker exists OR the live DB exists — so a
// relaunch either re-enters normal corruption recovery (live present) or
// resumes this transition (marker present); it can never see the
// nothing-at-all state that looks like a first run.

/// The durable fresh-start marker beside the live DB.
pub fn fresh_start_marker_path(live: &Path) -> PathBuf {
    live.with_file_name(".recovery-fresh-start")
}

/// R7-1: marker presence is a THREE-way answer — an unreadable marker
/// (metadata/permission failure) is NOT "absent". `Path::exists()` collapses
/// errors into `false`, which would skip the resume and silently mint an
/// empty library over an interrupted transition. Callers hard-stop on Err.
pub fn fresh_start_marker_present(live: &Path) -> Result<bool> {
    fresh_start_marker_path(live)
        .try_exists()
        .context("determine fresh-start marker state")
}

pub fn begin_fresh_start(live: &Path) -> Result<()> {
    begin_fresh_start_with(live, &mut RealPreserveFs)
}

pub(crate) fn begin_fresh_start_with(live: &Path, ops: &mut dyn PreserveFs) -> Result<()> {
    let parent = live
        .parent()
        .ok_or_else(|| anyhow::anyhow!("live DB path has no parent: {live:?}"))?;
    let marker = fresh_start_marker_path(live);
    ops.write(&marker, b"fresh-start transition in progress\n")
        .context("write fresh-start marker")?;
    ops.fsync_file(&marker)
        .context("fsync fresh-start marker")?;
    ops.fsync_dir(parent)
        .context("fsync data dir after writing the fresh-start marker")?;
    Ok(())
}

/// R4/R5: clear the (already-preserved) corrupt live triple so a FRESH
/// database can be created at the live path. Called ONLY inside the marker
/// bracket above, strictly after [`preserve_corrupt_live`] returned Ok — the
/// restore path never needs it (its atomic rename replaces the live file). A
/// failure here aborts recovery with the marker still down and whatever
/// remains of the originals still on disk.
pub fn clear_live_db_after_preservation(live: &Path) -> Result<()> {
    clear_live_db_after_preservation_with(live, &mut RealPreserveFs)
}

pub(crate) fn clear_live_db_after_preservation_with(
    live: &Path,
    ops: &mut dyn PreserveFs,
) -> Result<()> {
    let parent = live
        .parent()
        .ok_or_else(|| anyhow::anyhow!("live DB path has no parent: {live:?}"))?;
    let live_str = live.to_string_lossy().to_string();
    for p in [
        live.to_path_buf(),
        PathBuf::from(format!("{live_str}-wal")),
        PathBuf::from(format!("{live_str}-shm")),
    ] {
        if p.exists() {
            ops.remove_file(&p)
                .with_context(|| format!("clear preserved-corrupt {:?}", p.file_name()))?;
        }
    }
    ops.fsync_dir(parent)
        .context("fsync data dir after clearing the corrupt live DB")?;
    Ok(())
}

pub fn finish_fresh_start(live: &Path) -> Result<()> {
    finish_fresh_start_with(live, &mut RealPreserveFs)
}

pub(crate) fn finish_fresh_start_with(live: &Path, ops: &mut dyn PreserveFs) -> Result<()> {
    let parent = live
        .parent()
        .ok_or_else(|| anyhow::anyhow!("live DB path has no parent: {live:?}"))?;
    let marker = fresh_start_marker_path(live);
    if marker.exists() {
        ops.remove_file(&marker)
            .context("remove fresh-start marker")?;
    }
    ops.fsync_dir(parent)
        .context("fsync data dir after removing the fresh-start marker")?;
    Ok(())
}

/// REC-011: whether one restored-book row would actually READ, proven through
/// the PRODUCTION paths — never bare file existence:
/// - every source type must serve real text through `read_txt_section` (the
///   exact call the reader screen makes), OR
/// - an "epub" row whose derived text is missing must hold a `source.epub`
///   that genuinely OPENS as an EPUB (`EpubDoc::new` — the same entry the
///   runtime `ensure_epub_text` backfill regenerates from).
fn book_row_readable(book_id: &str, source_type: &str) -> bool {
    let reads = crate::commands::books::read_txt_section(book_id, 0, Some(256))
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if reads {
        return true;
    }
    if source_type == "epub" {
        if let Ok(dir) = paths::book_dir(book_id) {
            let epub_path = dir.join("source.epub");
            if epub_path.is_file() && epub::doc::EpubDoc::new(&epub_path).is_ok() {
                return true; // regenerable through the production backfill path
            }
        }
    }
    false
}

/// One row of a candidate's books table, for coherence checks + re-import
/// staging.
#[derive(Debug, Clone)]
pub struct CandidateBook {
    pub id: String,
    pub title: String,
    pub source_type: String,
    pub source_sha256: String,
}

fn candidate_books(db: &Path) -> Result<Vec<CandidateBook>> {
    let conn = Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("open backup for coherence check")?;
    let mut stmt =
        conn.prepare("SELECT id, title, source_type, source_sha256 FROM books ORDER BY title")?;
    // Row-decode failures PROPAGATE (never `filter_map`-dropped): a book row
    // this check can't even decode is exactly the kind of candidate the
    // preflight exists to refuse — silently skipping it would let an
    // incoherent restore pass as "all books verified".
    let rows = stmt
        .query_map([], |r| {
            Ok(CandidateBook {
                id: r.get(0)?,
                title: r.get(1)?,
                source_type: r.get(2)?,
                source_sha256: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("decode a books row in the backup")?;
    Ok(rows)
}

/// One historical section row of a candidate's `book_sections`, as the deep
/// preflight (and staging remap) needs it.
#[derive(Debug, Clone)]
struct CandidateSection {
    id: String,
    label: String,
    start_locator: Option<String>,
    end_locator: Option<String>,
    assignable: bool,
}

fn candidate_sections(db: &Path, book_id: &str) -> Result<Vec<CandidateSection>> {
    let conn = Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("open backup for section check")?;
    let mut stmt = conn.prepare(
        "SELECT id, label, start_locator, end_locator, assignable
         FROM book_sections WHERE book_id = ?1 ORDER BY sort_order",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![book_id], |r| {
            Ok(CandidateSection {
                id: r.get(0)?,
                label: r.get(1)?,
                start_locator: r.get(2)?,
                end_locator: r.get(3)?,
                assignable: r.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("decode a book_sections row in the backup")?;
    Ok(rows)
}

/// R5: one candidate book's coherence problem, TYPED. `Definitive` means the
/// backup is provably unusable as-is (missing/mismatched/misaligned data);
/// `Environmental` means the check itself could not run (io/permissions) — a
/// state that must FAIL CLOSED in automatic recovery rather than count as
/// "this backup is bad, move on" (which, across every candidate, would
/// authorize a fresh empty library off a transient error).
#[derive(Debug)]
pub(crate) enum BookIssue {
    Definitive(String),
    Environmental(String),
}

impl BookIssue {
    fn reason(&self) -> &str {
        match self {
            BookIssue::Definitive(r) | BookIssue::Environmental(r) => r,
        }
    }
}

/// REC-011 DEEP coherence for ONE candidate book: not just "would the first
/// page read", but "would every section this backup's rows point into actually
/// serve". Returns Err(reason) — the reason is section-structural only, never
/// book content. Checks, in order:
///
/// 1. the production read/regeneration gate ([`book_row_readable`]);
/// 2. the on-disk immutable source hashes to EXACTLY the row's source_sha256
///    (a same-named different file would silently misalign every locator);
/// 3. every section's stored locators — parsed by the ONE production owner
///    (`sittings::parse_loc`) — are in-bounds for the derived text, ordered
///    and non-overlapping across sort_order, and every ASSIGNABLE section
///    reads NONEMPTY through the production `read_txt_section` path (this is
///    what catches a truncated `reader.txt` whose first page still reads);
/// 4. a `structure.json`, when present, is keyed ONLY by this candidate's
///    historical section ids (foreign keys mean an un-remapped re-import —
///    typography would silently vanish for every section).
///
/// An "epub" row whose derived text is missing but whose `source.epub`
/// genuinely opens is accepted on regenerability (the production backfill
/// re-derives the text deterministically); its section reads are then checked
/// on the regenerated text at first open, not here.
fn book_restores_coherently(db: &Path, book: &CandidateBook) -> std::result::Result<(), BookIssue> {
    let dir = paths::book_dir(&book.id)
        .map_err(|_| BookIssue::Environmental("book dir unresolvable".into()))?;
    let source = dir.join(format!("source.{}", book.source_type));
    // R6-2: "missing" is a definitive verdict ONLY when the filesystem
    // affirmatively says NotFound. A metadata/permission failure proves
    // nothing about the file and must stay environmental — `is_file()`
    // collapses both into `false`.
    match std::fs::metadata(&source) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(BookIssue::Definitive(
                "immutable source file is missing".into(),
            ));
        }
        Err(_) => {
            return Err(BookIssue::Environmental(
                "source file state unreadable".into(),
            ));
        }
        Ok(m) if !m.is_file() => {
            return Err(BookIssue::Definitive(
                "immutable source path is not a regular file".into(),
            ));
        }
        Ok(_) => {}
    }
    if !book_row_readable(&book.id, &book.source_type) {
        // The files are present but the production read path refuses them —
        // could be an empty derivation (definitive) or an unreadable file
        // (environmental). Conservative: treat as environmentally
        // unassessable, so automatic recovery FAILS CLOSED instead of
        // treating a permission blip as a definitively dead book.
        return Err(BookIssue::Environmental(
            "does not read through the production path".into(),
        ));
    }
    let sha = crate::import::hash_file(&source)
        .map_err(|_| BookIssue::Environmental("source unreadable".into()))?;
    if sha != book.source_sha256 {
        return Err(BookIssue::Definitive(
            "source file content does not match this backup's record".into(),
        ));
    }

    // Content-free reasons throughout (R4): sections are named by POSITION
    // (sort_order), never by label — reasons reach tracing::warn, and a
    // section label is book content (invariant 1).
    // R6-2: an undecodable section ROW is definitive; the section query
    // failing to RUN (open/io/busy on the probe) is environmental.
    let sections = candidate_sections(db, &book.id).map_err(|e| {
        if query_failure_is_definitive(&e) {
            BookIssue::Definitive("sections undecodable".into())
        } else {
            BookIssue::Environmental("sections unqueryable".into())
        }
    })?;
    if sections.is_empty() {
        return Err(BookIssue::Definitive(
            "backup lists no sections for this book".into(),
        ));
    }

    // Derived text present → deep per-section validation through the
    // production read path. Absent for an EPUB → the production backfill
    // derivation is run IN ISOLATION and proven against the historical rows:
    // "the EPUB opens" says nothing about whether ensure_epub_text would
    // succeed, keep the historical section ids aligned, or serve nonempty
    // assignable sections (R4).
    let Ok(body) = crate::commands::books::read_txt_section(&book.id, 0, None) else {
        if book.source_type != "epub" {
            // The derived text file exists (book_row_readable passed above)
            // but the full read failed — environmental.
            return Err(BookIssue::Environmental("derived text unreadable".into()));
        }
        return epub_backfill_would_succeed(&dir, &sections);
    };
    let body_len = body.len();
    let mut prev_end: usize = 0;
    for (idx, s) in sections.iter().enumerate() {
        let start = crate::sittings::parse_loc(s.start_locator.as_deref());
        let end = crate::sittings::parse_loc(s.end_locator.as_deref());
        if let (Some(start), Some(end)) = (start, end) {
            if start > end {
                return Err(BookIssue::Definitive(format!(
                    "section {idx} has reversed bounds"
                )));
            }
            if end > body_len {
                return Err(BookIssue::Definitive(format!(
                    "section {idx} points past the end of the book text (truncated file?)"
                )));
            }
            if start < prev_end {
                return Err(BookIssue::Definitive(format!(
                    "section {idx} overlaps the previous section"
                )));
            }
            prev_end = end;
            if s.assignable {
                let text = crate::commands::books::read_txt_section(&book.id, start, Some(end))
                    .map_err(|_| {
                        BookIssue::Environmental(format!("section {idx} failed to read"))
                    })?;
                if text.trim().is_empty() {
                    return Err(BookIssue::Definitive(format!(
                        "section {idx} reads back empty through the production path"
                    )));
                }
            }
        } else if s.assignable {
            // An assignable section whose locators don't parse would never
            // serve an assignment — refuse rather than restore a dead book.
            return Err(BookIssue::Definitive(format!(
                "section {idx} has unparseable locators"
            )));
        }
    }

    // structure.json (typography ranges) must key by THESE section ids.
    // R6-2: absence must be AFFIRMATIVE (NotFound). A metadata failure here
    // used to fall through `is_file() == false` and silently SKIP the check —
    // an environmental error masquerading as "no structure.json, all good".
    let structure_path = dir.join("structure.json");
    match std::fs::metadata(&structure_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // genuinely absent — fine
        Err(_) => {
            return Err(BookIssue::Environmental(
                "structure.json state unreadable".into(),
            ));
        }
        Ok(_) => {
            let raw = std::fs::read_to_string(&structure_path)
                .map_err(|_| BookIssue::Environmental("structure.json unreadable".into()))?;
            let map: std::collections::HashMap<String, serde_json::Value> =
                serde_json::from_str(&raw)
                    .map_err(|_| BookIssue::Definitive("structure.json invalid".into()))?;
            let ids: std::collections::HashSet<&str> =
                sections.iter().map(|s| s.id.as_str()).collect();
            if let Some(foreign) = map.keys().find(|k| !ids.contains(k.as_str())) {
                let _ = foreign;
                return Err(BookIssue::Definitive(
                    "structure.json is keyed to different section ids than this backup".into(),
                ));
            }
        }
    }
    Ok(())
}

/// R4: prove a SOURCE-ONLY EPUB (derived text missing) would genuinely
/// backfill: run the exact production derivation in isolation (no writes) and
/// hold it against the candidate's historical rows — the same alignment
/// `ensure_epub_text` enforces, plus locator equality when history recorded
/// locators (the backfill OVERWRITES locators, so a mismatch would silently
/// misalign every anchored note), plus nonempty assignable sections. Reasons
/// stay content-free (positions, never labels).
/// R7-8: classify an EPUB-derivation failure. Only a verdict about the FILE
/// (zip/xml/format corruption — `DocError`'s non-io classes) is definitive;
/// the derivation failing to RUN (an `std::io::Error` anywhere in the chain:
/// permissions, resources, transient io) — or failing UNTYPEABLY — is
/// environmental, so automatic recovery fails closed instead of walking past
/// the candidate toward a fresh start.
fn classify_epub_derivation_failure(e: &anyhow::Error) -> BookIssue {
    if e.chain()
        .any(|c| c.downcast_ref::<std::io::Error>().is_some())
    {
        return BookIssue::Environmental("EPUB derivation could not run (io)".into());
    }
    if e.chain()
        .any(|c| c.downcast_ref::<epub::doc::DocError>().is_some())
    {
        return BookIssue::Definitive(
            "EPUB derivation failed (the backfill would refuse this file)".into(),
        );
    }
    BookIssue::Environmental("EPUB derivation failed untypeably".into())
}

fn epub_backfill_would_succeed(
    dir: &Path,
    sections: &[CandidateSection],
) -> std::result::Result<(), BookIssue> {
    let derived = crate::import_epub::derive_epub_sections_isolated(&dir.join("source.epub"))
        .map_err(|e| classify_epub_derivation_failure(&e))?;
    if derived.len() != sections.len() {
        return Err(BookIssue::Definitive(format!(
            "EPUB derives {} sections where the backup recorded {} — the backfill would refuse",
            derived.len(),
            sections.len()
        )));
    }
    for (idx, (s, d)) in sections.iter().zip(derived.iter()).enumerate() {
        let start = crate::sittings::parse_loc(s.start_locator.as_deref());
        let end = crate::sittings::parse_loc(s.end_locator.as_deref());
        if let (Some(start), Some(end)) = (start, end) {
            // History recorded locators: the backfill would overwrite them
            // with the derived values — anything but equality silently
            // misaligns every anchored note in section-relative space.
            if start != d.start || end != d.end {
                return Err(BookIssue::Definitive(format!(
                    "section {idx} derives different bounds than the backup recorded"
                )));
            }
        }
        if s.assignable && !d.nonempty {
            return Err(BookIssue::Definitive(format!(
                "section {idx} would backfill EMPTY"
            )));
        }
    }
    Ok(())
}

/// REC-011: a rolling backup holds ONLY `reading.db` — imported book files live
/// outside it and are deleted with their book. Restoring a DB that lists books
/// whose files are gone, unreadable, mismatched, or sectionally incoherent
/// would resurrect ghost rows. Returns the titles of every book in `db` that
/// fails [`book_restores_coherently`].
///
/// R4: the deep queries run against a MIGRATED disposable probe of the
/// candidate, never the original file — a pre-v004 backup (no `assignable`
/// column) is perfectly restorable after migration, and querying the
/// old-schema original wrongly refused it. Reasons are logged content-free
/// (positions, never labels/titles/paths).
pub fn books_missing_files(db: &Path) -> Result<Vec<String>> {
    let probe = MigratedProbe::create(db)?
        .ok_or_else(|| anyhow::anyhow!("backup failed validation (integrity)"))?;
    let mut failed = Vec::new();
    for b in candidate_books(probe.path())? {
        if let Err(issue) = book_restores_coherently(probe.path(), &b) {
            let reason = issue.reason();
            tracing::warn!(category = "restore", "preflight: a book failed: {reason}");
            failed.push(b.title);
        }
    }
    Ok(failed)
}

/// R5: TYPED assessment of one backup candidate for AUTOMATIC recovery.
/// `Invalid` is definitive (integrity failure, undecodable rows, or any
/// definitively incoherent book); `Unassessable` means the assessment itself
/// could not run to a verdict (environment) — automatic recovery must treat
/// that as "fail closed", never as "skip". Definitive problems take
/// precedence: a backup with a provably missing book is unusable now even if
/// another book also hit an environmental error.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BackupAssessment {
    Coherent,
    Invalid,
    Unassessable,
}

pub fn assess_backup(candidate: &Path) -> BackupAssessment {
    let probe = match MigratedProbe::create(candidate) {
        Ok(Some(p)) => p,
        Ok(None) => return BackupAssessment::Invalid, // integrity: definitive
        Err(e) => {
            tracing::warn!(
                category = "restore",
                "candidate unassessable (probe): {e:#}"
            );
            return BackupAssessment::Unassessable;
        }
    };
    let books = match candidate_books(probe.path()) {
        Ok(b) => b,
        // R6-2: only a DECODE-level failure (undecodable rows / corrupt pages)
        // is definitive; the query failing to run (open/io/busy) is the
        // environment and must fail closed, not skip to an older candidate.
        Err(e) if query_failure_is_definitive(&e) => return BackupAssessment::Invalid,
        Err(e) => {
            tracing::warn!(
                category = "restore",
                "candidate unassessable (books query): {e:#}"
            );
            return BackupAssessment::Unassessable;
        }
    };
    let mut invalid = false;
    let mut unassessable = false;
    for b in &books {
        match book_restores_coherently(probe.path(), b) {
            Ok(()) => {}
            Err(BookIssue::Definitive(reason)) => {
                tracing::warn!(category = "restore", "candidate invalid: {reason}");
                invalid = true;
            }
            Err(BookIssue::Environmental(reason)) => {
                tracing::warn!(category = "restore", "candidate unassessable: {reason}");
                unassessable = true;
            }
        }
    }
    if invalid {
        BackupAssessment::Invalid
    } else if unassessable {
        BackupAssessment::Unassessable
    } else {
        BackupAssessment::Coherent
    }
}

/// THE restore coherence preflight (REC-011) — the ONE gate shared by the
/// reader-initiated restore, the automatic corruption recovery, and undo. A
/// candidate passes iff it validates on a disposable MIGRATED copy (opens,
/// integrity-checks, migrates) AND every book row it lists reads through the
/// production path. `Ok(missing)` is empty on a fully coherent candidate.
pub fn restore_preflight(candidate: &Path) -> Result<Vec<String>> {
    if !backup_is_usable(candidate)? {
        anyhow::bail!("backup failed validation (integrity/migration)");
    }
    books_missing_files(candidate)
}

/// REC-011 "re-import, then restore": stage a reader-picked source file under
/// the HISTORICAL book id a backup row expects, matched by FULL SHA-256 —
/// never by name or guesswork. On a match, the production importer re-runs its
/// deterministic derivation INTO that id's directory (files only; no live DB
/// rows are touched), so the backup row's sections/notes line up with the
/// regenerated derived text. Refuses loudly when the file matches no row, the
/// extension contradicts the row's source type, or the id's directory already
/// holds a DIFFERENT source.
pub fn stage_book_for_restore(candidate_db: &Path, src: &Path) -> Result<CandidateBook> {
    // R4: every candidate query runs against a MIGRATED disposable probe, so
    // a pre-v004 backup stages correctly instead of failing on old schema.
    let probe = MigratedProbe::create(candidate_db)?
        .ok_or_else(|| anyhow::anyhow!("backup failed validation (integrity)"))?;
    // R7-3: resume interrupted staging transactions BEFORE hashing — the
    // picked file may BE the managed source, currently parked in a
    // transaction's aside while the book dir is absent. Hashing first would
    // fail on the missing path before any recovery could run.
    resume_all_interrupted_rebuilds()?;
    let sha = crate::import::hash_file(src).context("hash the picked file")?;
    let books = candidate_books(probe.path())?;
    let Some(row) = books.iter().find(|b| b.source_sha256 == sha) else {
        anyhow::bail!(
            "That file doesn't match any book in this backup. Pick the exact file you originally imported (the match is by content, not by name)."
        );
    };
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != row.source_type {
        anyhow::bail!(
            "That file's type (.{ext}) doesn't match how \"{}\" was imported ({}).",
            row.title,
            row.source_type
        );
    }

    let dir = paths::book_dir(&row.id)?;
    let existing = dir.join(format!("source.{}", row.source_type));
    if existing.is_file() {
        let existing_sha = crate::import::hash_file(&existing)?;
        if existing_sha != sha {
            anyhow::bail!(
                "\"{}\" already has a different file on this Mac; refusing to replace it.",
                row.title
            );
        }
        // R4: a matching source is NOT proof of a complete staging — an
        // interrupted earlier attempt can leave the source in place with the
        // derived artifacts missing or un-remapped. Validate the derived
        // artifacts fully; when they hold, this is the idempotent no-op. When
        // they don't, REBUILD the staging — in a SIBLING TEMP DIRECTORY (R5),
        // fully validated, then swapped in atomically. The previous
        // source/staging is never destroyed on error, and `src` may safely BE
        // the managed source file itself (it is read before anything moves).
        if book_restores_coherently(probe.path(), row).is_ok() {
            return Ok(row.clone());
        }
        tracing::warn!(
            category = "restore",
            "staged source matches by SHA but its derived artifacts are incomplete — rebuilding the staging in a sibling temp dir"
        );
        return rebuild_staging_in_sibling_temp(probe.path(), row, &dir, src);
    }

    // R8-2: FIRST-TIME staging routes through the SAME sibling-temp durable
    // transaction as rebuilds — derive into a fully-validated tmp, then
    // promote. A crash mid-derivation can never leave a partial live source
    // that a retry would refuse as "a different file".
    rebuild_staging_in_sibling_temp(probe.path(), row, &dir, src)
}

/// R5: rebuild a same-SHA-but-incoherent staging WITHOUT ever destroying the
/// previous source/staging on error:
///
///   1. derive into a SIBLING temp directory (the previous staging — and the
///      picked file, which may be the managed source itself — stay untouched);
///   2. validate fully there (sectionization vs history, structure remap,
///      nonempty derived text);
///   3. only then replace via [`swap_rebuilt_staging`] (R6-3): previous →
///      aside, temp → in place, parent fsync PROPAGATED, production
///      readability proven on the live path — and only then is the aside
///      released. Every swap failure puts the previous staging back.
fn rebuild_staging_in_sibling_temp(
    probe_db: &Path,
    row: &CandidateBook,
    dir: &Path,
    src: &Path,
) -> Result<CandidateBook> {
    let parent = dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("book dir has no parent"))?;
    let tmp = parent.join(format!(".rebuild-{}-{}", row.id, std::process::id()));
    crate::import::remove_book_dir_quiet(&tmp);
    // R9-2: a symlink that survived the cleanup must never receive the
    // derivation — the import below would write THROUGH it.
    refuse_symlink(&tmp, "staging tmp")?;

    let staged = match row.source_type.as_str() {
        "txt" => crate::import::import_txt_into_dir(&row.id, &tmp, src),
        "epub" => crate::import_epub::import_epub_into_dir(&row.id, &tmp, src),
        other => Err(anyhow::anyhow!(
            "unsupported source type in backup: {other}"
        )),
    };
    let staged = match staged {
        Ok(s) => s,
        Err(e) => {
            crate::import::remove_book_dir_quiet(&tmp);
            return Err(e.context("rebuild staging (previous staging untouched)"));
        }
    };
    if let Err(reason) = remap_staged_structure_to_history(probe_db, row, &staged.sections, &tmp) {
        crate::import::remove_book_dir_quiet(&tmp);
        anyhow::bail!(
            "The re-imported file for \"{}\" does not line up with this backup ({reason}); \
             the previous staging is untouched.",
            row.title
        );
    }
    // The rebuilt derivation must actually read nonempty before it replaces
    // anything (for EPUBs the derived body IS source.txt; txt derives reader.txt).
    let derived_file = if row.source_type == "epub" {
        "source.txt"
    } else {
        "reader.txt"
    };
    let derived_ok = std::fs::read_to_string(tmp.join(derived_file))
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);
    if !derived_ok {
        crate::import::remove_book_dir_quiet(&tmp);
        anyhow::bail!(
            "The rebuilt staging for \"{}\" does not read back; the previous staging is untouched.",
            row.title
        );
    }

    let mut ops = RealPreserveFs;
    // R7-3: the validated staging is made DURABLE before it may replace
    // anything — every generated regular file, then the staged directory.
    // Failures propagate (the previous staging is untouched).
    if let Err(e) = fsync_staging_tree(&tmp, &mut ops) {
        crate::import::remove_book_dir_quiet(&tmp);
        return Err(e.context(format!(
            "make the rebuilt staging for \"{}\" durable (previous staging untouched)",
            row.title
        )));
    }

    // R6-3/R7-3: the swap itself — a recorded transaction with revert-on-
    // failure at every boundary; the aside is retained until the new staging
    // is durable AND reads through the production path.
    let source_file = format!("source.{}", row.source_type);
    swap_rebuilt_staging(
        dir,
        &tmp,
        &row.id,
        &source_file,
        derived_file,
        &mut ops,
        &mut || book_row_readable(&row.id, &row.source_type),
    )
    .with_context(|| format!("swap the rebuilt staging for \"{}\" into place", row.title))?;
    Ok(row.clone())
}

// ── R7-3: the staging swap as an IDENTIFIED, DURABLE transaction ────────────

/// The durable record of an in-flight staging swap: the EXACT book id, tmp
/// path, aside path, the file names a complete staging must hold, whether a
/// previous staging existed, and the recorded phase. Written and fsynced
/// BEFORE the first rename; a resume acts only on the paths this record
/// names — never on "the first directory whose name looks right".
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub(crate) struct StagingTxn {
    pub book_id: String,
    pub tmp: PathBuf,
    pub aside: PathBuf,
    /// Nonempty presence of BOTH files marks a complete staging for this book
    /// (full sectionization validation ran before any rename — this is the
    /// promotion-choice check a resume can still make).
    pub source_file: String,
    pub derived_file: String,
    /// "prepared" = recorded, the new staging not yet renamed in;
    /// "swapping" = the rename-in has been issued;
    /// "verified" (R8-2) = the swapped-in staging PASSED the production
    /// readability check — only this phase authorizes releasing the aside.
    pub phase: String,
    /// R8-2: whether a previous staging existed (first-time stagings run the
    /// same transaction with no aside step).
    #[serde(default = "default_had_previous")]
    pub had_previous: bool,
}

fn default_had_previous() -> bool {
    true // journals written before this field always had a previous staging
}

fn staging_txn_path(parent: &Path, book_id: &str) -> PathBuf {
    parent.join(format!(".staging-txn-{book_id}.json"))
}

/// R9-2: refuse to act THROUGH a symlink, checked with `symlink_metadata`
/// (never following). Returns whether something non-link exists at the path.
/// Every staging-transaction path — journal, journal temp, tmp, aside, and
/// the live book dir — goes through this before it is read, chmodded,
/// renamed, or deleted: a planted link must never direct an operation
/// outside the books directory.
fn refuse_symlink(p: &Path, what: &str) -> Result<bool> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => {
            anyhow::bail!("{what} {p:?} is a symlink — refusing to act through it")
        }
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("inspect {what} {p:?} (no-follow)")),
    }
}

/// R10-2: the between-open-and-validation hook for the descriptor-validated
/// reads below — tests use it to SWAP the path (regular file ↔ symlink)
/// inside the exact race window the naive check-then-read left open.
#[cfg(test)]
pub(crate) mod nofollow_test_seam {
    use std::cell::RefCell;
    use std::path::Path;
    type Hook = Box<dyn FnMut(&Path)>;
    thread_local! {
        static BETWEEN: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }
    pub(crate) fn arm(f: Hook) {
        BETWEEN.with(|c| *c.borrow_mut() = Some(f));
    }
    pub(crate) fn disarm() {
        BETWEEN.with(|c| *c.borrow_mut() = None);
    }
    pub(crate) fn fire(p: &Path) {
        BETWEEN.with(|c| {
            if let Some(f) = c.borrow_mut().as_mut() {
                f(p)
            }
        });
    }
}

/// R11-3: named-point race hooks — tests swap files inside the exact
/// windows the descriptor checks close (after exclusive temp creation /
/// after resume validation).
#[cfg(test)]
pub(crate) mod staging_race_seam {
    use std::cell::RefCell;
    use std::path::Path;
    type Hook = Box<dyn FnMut(&str, &Path)>;
    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }
    pub(crate) fn arm(f: Hook) {
        HOOK.with(|c| *c.borrow_mut() = Some(f));
    }
    pub(crate) fn disarm() {
        HOOK.with(|c| *c.borrow_mut() = None);
    }
    pub(crate) fn fire(point: &str, p: &Path) {
        HOOK.with(|c| {
            if let Some(f) = c.borrow_mut().as_mut() {
                f(point, p)
            }
        });
    }
}

/// R11-3: open flags for descriptor-safe journal reads. `O_NOFOLLOW` makes
/// the KERNEL refuse a symlink at the path (ELOOP) — validation after a
/// plain `File::open` was insufficient, since the open itself already
/// followed the link. `O_NONBLOCK` makes an open of a FIFO return
/// immediately instead of blocking until a writer appears (harmless on
/// regular files); the fstat below then refuses every non-regular type.
#[cfg(target_os = "macos")]
const O_NOFOLLOW_FLAG: i32 = 0x0100;
#[cfg(target_os = "linux")]
const O_NOFOLLOW_FLAG: i32 = 0o400000;
#[cfg(target_os = "macos")]
const O_NONBLOCK_FLAG: i32 = 0x0004;
#[cfg(target_os = "linux")]
const O_NONBLOCK_FLAG: i32 = 0o4000;
#[cfg(target_os = "macos")]
const ELOOP_CODE: i32 = 62;
#[cfg(target_os = "linux")]
const ELOOP_CODE: i32 = 40;

/// R10-2/R11-3: DESCRIPTOR-VALIDATED no-follow read. The open itself carries
/// `O_NOFOLLOW` (a symlink is refused BY THE KERNEL, never followed — a
/// symlink to a FIFO or device is rejected without ever opening or blocking
/// on the target) and `O_NONBLOCK` (a direct FIFO cannot block the open).
/// The open descriptor must then be a REGULAR file whose (dev, ino) equals
/// the path's non-followed identity — any swap between open and validation
/// fails the comparison and no byte is trusted. `Ok(None)` = nothing there.
fn read_nofollow(path: &Path, what: &str) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = match std::fs::File::options()
        .read(true)
        .custom_flags(O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.raw_os_error() == Some(ELOOP_CODE) => {
            anyhow::bail!("{what} {path:?} is a symlink — refusing to read through it")
        }
        Err(e) => return Err(e).with_context(|| format!("open {what} {path:?} (O_NOFOLLOW)")),
    };
    #[cfg(test)]
    nofollow_test_seam::fire(path);
    let fd_meta = file
        .metadata()
        .with_context(|| format!("stat the open {what} descriptor"))?;
    let path_meta = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect {what} {path:?} (no-follow)"))?;
    if path_meta.file_type().is_symlink() {
        anyhow::bail!("{what} {path:?} is a symlink — refusing to read through it");
    }
    if !fd_meta.is_file() {
        anyhow::bail!(
            "{what} {path:?} is not a regular file (FIFO/device/dir) — refusing to read it"
        );
    }
    if fd_meta.dev() != path_meta.dev() || fd_meta.ino() != path_meta.ino() {
        anyhow::bail!(
            "{what} {path:?} changed identity between open and validation — refusing to read it"
        );
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .with_context(|| format!("read {what} {path:?}"))?;
    Ok(Some(buf))
}

/// R8-2: journal writes are ATOMIC — sibling temp record → fsync → rename →
/// parent fsync. The only journal is never truncated in place: a crash
/// mid-write leaves either the previous record or the new one, never a torn
/// file. R9-2: both the temp and the final journal name are checked no-follow
/// first — a planted symlink at either name refuses the write instead of
/// writing through it.
fn write_staging_txn(parent: &Path, txn: &StagingTxn, ops: &mut dyn PreserveFs) -> Result<()> {
    let path = staging_txn_path(parent, &txn.book_id);
    // R10-2: a UNIQUE temp name per write, created EXCLUSIVELY (create_new =
    // O_CREAT|O_EXCL, which never follows) — the metadata-check-then-write
    // pattern is gone; a planted entry at the temp name fails the create
    // atomically instead of being written through. The final name is
    // pre-flighted no-follow as a loud refusal (the rename itself would
    // replace a planted link without following it).
    let tmp = parent.join(format!(
        ".staging-txn-{}.json.tmp-{}-{}",
        txn.book_id,
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    refuse_symlink(&path, "staging txn journal")?;
    let bytes = serde_json::to_vec_pretty(txn).context("serialize staging txn")?;
    let write = |ops: &mut dyn PreserveFs| -> Result<()> {
        // R11-3: written AND fsynced on the exclusive descriptor itself —
        // never closed and re-fsynced by pathname.
        let written_id = ops
            .create_new_write(&tmp, &bytes)
            .context("create staging txn temp (exclusive descriptor: write + fsync)")?;
        #[cfg(test)]
        staging_race_seam::fire("journal-temp-durable", &tmp);
        ops.rename(&tmp, &path)
            .context("rename staging txn into place")?;
        ops.fsync_dir(parent)
            .context("fsync books dir after staging-txn write")?;
        // R11-3: the entry now at the journal name must BE the record the
        // exclusive descriptor wrote — a temp swapped between creation and
        // rename would land foreign bytes under the journal's name.
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect renamed journal {path:?} (no-follow)"))?;
        if m.file_type().is_symlink() || !m.is_file() || (m.dev(), m.ino()) != written_id {
            anyhow::bail!(
                "journal {path:?} is not the exclusively-written record (identity changed \
                 between creation and rename) — refusing to trust this transaction write"
            );
        }
        Ok(())
    };
    let result = write(ops);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp); // never leave a torn sibling record
    }
    result
}

/// R8-2: journal removal PROPAGATES its failures (a dangling journal is a
/// pending recovery decision, not litter). R9-2: routed through the
/// injectable seam and no-follow-checked before the delete.
fn remove_staging_txn(parent: &Path, book_id: &str, ops: &mut dyn PreserveFs) -> Result<()> {
    let path = staging_txn_path(parent, book_id);
    if !refuse_symlink(&path, "staging txn journal")? {
        return Ok(());
    }
    match ops.remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e).context("remove staging txn"),
    }
    ops.fsync_dir(parent)
        .context("fsync books dir after staging-txn removal")?;
    Ok(())
}

/// A directory holds a COMPLETE staging for `txn` iff the exact source and
/// derived files it names are nonempty. NOTE (R8-2): completeness is
/// necessary but NOT sufficient — only the recorded "verified" phase proves
/// a staging passed the production readability gate.
///
/// R10-2: a staged file is TRUSTED only when it is a NO-FOLLOW regular file.
/// A regular tmp/aside directory whose child is a SYMLINK (to a file outside
/// the books directory, say) must never be promoted into the live library —
/// that is an `Err`, which the resume propagates with the journal RETAINED,
/// never a silent "incomplete".
fn staging_complete(dir: &Path, txn: &StagingTxn) -> Result<bool> {
    Ok(staging_children_validated(dir, txn)?.is_some())
}

/// R11-3: a required staged child's identity, captured at validation so the
/// SAME inode can be proven present after the tmp→live promotion — a child
/// swapped between validation and promotion is caught before the journal is
/// ever consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct StagedChildId {
    name: String,
    dev: u64,
    ino: u64,
}

/// Validate the REQUIRED children of a recorded staging (no-follow regular
/// files, nonempty) and capture their identities. `Ok(None)` = incomplete
/// (absent or empty child); `Err` = a symlink or non-regular child — the
/// caller refuses and RETAINS the journal.
fn staging_children_validated(dir: &Path, txn: &StagingTxn) -> Result<Option<Vec<StagedChildId>>> {
    use std::os::unix::fs::MetadataExt;
    let mut ids = Vec::new();
    for name in [&txn.source_file, &txn.derived_file] {
        let p = dir.join(name.as_str());
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => {
                anyhow::bail!("staged file {p:?} is a symlink — refusing to trust this staging")
            }
            Ok(m) if !m.is_file() => anyhow::bail!(
                "staged file {p:?} is not a regular file — refusing to trust this staging"
            ),
            Ok(m) => {
                if m.len() == 0 {
                    return Ok(None);
                }
                ids.push(StagedChildId {
                    name: name.to_string(),
                    dev: m.dev(),
                    ino: m.ino(),
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(e).with_context(|| format!("inspect staged file {p:?} (no-follow)"))
            }
        }
    }
    Ok(Some(ids))
}

/// R11-3: REVALIDATE promoted children against the identities captured at
/// validation — same inode, still a no-follow regular file — before the
/// journal is consumed. Any drift refuses (the propagated error leaves the
/// journal as the pending recovery decision).
fn revalidate_children(dir: &Path, ids: &[StagedChildId]) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    for id in ids {
        let p = dir.join(&id.name);
        let m = std::fs::symlink_metadata(&p)
            .with_context(|| format!("revalidate promoted child {p:?} (no-follow)"))?;
        if m.file_type().is_symlink() || !m.is_file() {
            anyhow::bail!(
                "promoted child {p:?} is no longer a regular file — refusing to consume the journal"
            );
        }
        if (m.dev(), m.ino()) != (id.dev, id.ino) {
            anyhow::bail!(
                "promoted child {p:?} changed identity between validation and promotion — refusing to consume the journal"
            );
        }
    }
    Ok(())
}

/// R8-2: a journal is acted on ONLY when everything it names is confined to
/// the books directory and to this transaction's own naming scheme — a
/// tampered or corrupted record must never direct a rename or delete outside
/// its lane.
fn staging_txn_confined(parent: &Path, txn: &StagingTxn, journal_name: &str) -> Result<()> {
    let id_ok = !txn.book_id.is_empty()
        && txn
            .book_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !id_ok {
        anyhow::bail!("journal {journal_name}: book id is not a plain identifier");
    }
    if journal_name != format!(".staging-txn-{}.json", txn.book_id) {
        anyhow::bail!("journal {journal_name}: file name does not match its recorded book id");
    }
    for (label, p, prefix) in [
        ("tmp", &txn.tmp, format!(".rebuild-{}-", txn.book_id)),
        (
            "aside",
            &txn.aside,
            format!(".pre-rebuild-{}-", txn.book_id),
        ),
    ] {
        if p.parent() != Some(parent) {
            anyhow::bail!("journal {journal_name}: {label} path escapes the books directory");
        }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.starts_with(&prefix) {
            anyhow::bail!(
                "journal {journal_name}: {label} file name is not this transaction's own"
            );
        }
    }
    for (label, f) in [
        ("source_file", &txn.source_file),
        ("derived_file", &txn.derived_file),
    ] {
        if f.is_empty() || f.contains('/') || f.contains('\\') || f.contains("..") {
            anyhow::bail!("journal {journal_name}: {label} is not a plain file name");
        }
    }
    if !matches!(txn.phase.as_str(), "prepared" | "swapping" | "verified") {
        anyhow::bail!("journal {journal_name}: unknown phase {:?}", txn.phase);
    }
    Ok(())
}

/// R7-3: fsync every generated regular file in the staged tree, then the
/// directory itself — a validated staging whose bytes sit only in the page
/// cache is not one the swap may rely on. Enumeration, metadata, and fsync
/// errors all PROPAGATE.
fn fsync_staging_tree(dir: &Path, ops: &mut dyn PreserveFs) -> Result<()> {
    let rd = std::fs::read_dir(dir).with_context(|| format!("enumerate staged dir {dir:?}"))?;
    for entry in rd {
        let entry = entry.context("read a staged-dir entry")?;
        let path = entry.path();
        let meta = entry.metadata().context("stat a staged file")?;
        if meta.is_dir() {
            fsync_staging_tree(&path, ops)?;
        } else {
            ops.fsync_file(&path)
                .with_context(|| format!("fsync staged file {path:?}"))?;
        }
    }
    ops.fsync_dir(dir)
        .with_context(|| format!("fsync staged dir {dir:?}"))?;
    Ok(())
}

/// R7-3: resume every interrupted staging transaction recorded under the
/// books dir — called BEFORE any staging work, including hashing a possibly
/// managed source. Directory-enumeration errors PROPAGATE (an unreadable
/// books dir is unknown state, not "nothing to resume"), and an unreadable,
/// unparseable, or UNCONFINED record is a refusal, never a guess.
pub(crate) fn resume_all_interrupted_rebuilds() -> Result<()> {
    let parent = paths::books_dir()?;
    let rd = match std::fs::read_dir(&parent) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()), // no books yet
        Err(e) => return Err(e).context("enumerate books dir for staging transactions"),
    };
    let mut txns = Vec::new();
    for entry in rd {
        let entry = entry.context("read a books-dir entry")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(".staging-txn-") && name.ends_with(".json") {
            // R9-2/R10-2: DESCRIPTOR-VALIDATED no-follow read — a symlinked
            // journal, or one swapped mid-read, is refused before any byte
            // is trusted (its target could sit outside the books directory).
            let Some(bytes) = read_nofollow(&entry.path(), "staging txn journal")? else {
                continue; // vanished between readdir and open
            };
            let raw = String::from_utf8(bytes)
                .with_context(|| format!("staging txn {name} is not UTF-8"))?;
            let txn: StagingTxn = serde_json::from_str(&raw).with_context(|| {
                format!("staging txn {name} is unparseable — refusing to guess at an interrupted swap's state")
            })?;
            staging_txn_confined(&parent, &txn, name)?;
            txns.push(txn);
        }
    }
    for txn in txns {
        resume_staging_txn(&parent, &txn)?;
    }
    Ok(())
}

/// Resume ONE recorded transaction using only the exact paths it names.
///
/// R8-2 decision table: a live dir that merely LOOKS complete (two nonempty
/// files) is trusted only when the journal recorded "verified"; otherwise a
/// complete recorded aside is the known-good state and is RESTORED, never
/// deleted.
fn resume_staging_txn(parent: &Path, txn: &StagingTxn) -> Result<()> {
    let ops: &mut dyn PreserveFs = &mut RealPreserveFs;
    let dir = parent.join(&txn.book_id);
    // R9-2: no-follow on every path the record names AND the live dir — a
    // planted symlink refuses the whole resume rather than directing a
    // rename, read, or delete outside the books directory.
    let dir_exists = refuse_symlink(&dir, "live book dir")?;
    let tmp_exists = refuse_symlink(&txn.tmp, "recorded tmp")?;
    let aside_exists = refuse_symlink(&txn.aside, "recorded aside")?;
    let fsync_parent = || {
        std::fs::File::open(parent)
            .and_then(|d| d.sync_all())
            .context("fsync books dir after resume")
    };

    if dir_exists {
        if txn.phase == "verified" && staging_complete(&dir, txn)? {
            // Production verification was durably recorded — the identified
            // leftovers are redundant/re-derivable.
            if tmp_exists {
                crate::import::remove_book_dir_quiet(&txn.tmp);
            }
            if aside_exists {
                crate::import::remove_book_dir_quiet(&txn.aside);
            }
            fsync_parent()?;
            return remove_staging_txn(parent, &txn.book_id, ops);
        }
        // NOT verified: the live dir is an unproven swap product. When the
        // recorded aside holds a complete previous staging, THAT is the
        // known-good state — restore it (the unproven dir is re-derivable).
        if aside_exists && staging_complete(&txn.aside, txn)? {
            let failed = parent.join(format!(
                ".staging-failed-{}-{}",
                txn.book_id,
                std::process::id()
            ));
            crate::import::remove_book_dir_quiet(&failed);
            std::fs::rename(&dir, &failed).context("park the unverified staging")?;
            std::fs::rename(&txn.aside, &dir).context("resume: restore the previous staging")?;
            // R9-2: the restored namespace becomes durable BEFORE anything
            // (parked product, leftover tmp, journal) is deleted.
            fsync_parent()?;
            crate::import::remove_book_dir_quiet(&failed);
            if tmp_exists {
                crate::import::remove_book_dir_quiet(&txn.tmp);
            }
            tracing::warn!(
                category = "restore",
                "resumed an interrupted staging swap by restoring the recorded previous staging over an unverified swap product"
            );
            return remove_staging_txn(parent, &txn.book_id, ops);
        }
        // No recorded previous to prefer — leave the dir to the normal
        // rebuild flow (its coherence gate decides; it derives a FRESH tmp).
        if tmp_exists {
            crate::import::remove_book_dir_quiet(&txn.tmp);
        }
        return remove_staging_txn(parent, &txn.book_id, ops);
    }

    // Book dir ABSENT (death between the renames): promote the recorded new
    // staging only after VALIDATING it; otherwise restore the recorded aside.
    if tmp_exists {
        if let Some(ids) = staging_children_validated(&txn.tmp, txn)? {
            #[cfg(test)]
            staging_race_seam::fire("resume-validated", &txn.tmp);
            std::fs::rename(&txn.tmp, &dir).context("resume: promote the recorded staging")?;
            fsync_parent()?;
            // R11-3: the promoted children must still BE the validated inodes
            // (no-follow regular files) before the journal is consumed.
            revalidate_children(&dir, &ids)?;
            // R8-2: the promoted staging is complete but NOT production-
            // verified — the known-good aside is RETAINED (inert) rather
            // than deleted.
            tracing::warn!(
                category = "restore",
                "resumed an interrupted staging swap by promoting the recorded rebuild (previous staging retained beside it)"
            );
            return remove_staging_txn(parent, &txn.book_id, ops);
        }
    }
    if aside_exists {
        if let Some(ids) = staging_children_validated(&txn.aside, txn)? {
            #[cfg(test)]
            staging_race_seam::fire("resume-validated", &txn.aside);
            std::fs::rename(&txn.aside, &dir).context("resume: restore the previous staging")?;
            // R9-2: the restored namespace becomes durable BEFORE the
            // recorded-but-incomplete tmp or the journal is deleted.
            fsync_parent()?;
            // R11-3: same revalidation on the restore path.
            revalidate_children(&dir, &ids)?;
            if tmp_exists {
                crate::import::remove_book_dir_quiet(&txn.tmp); // recorded but incomplete
            }
            tracing::warn!(
                category = "restore",
                "resumed an interrupted staging swap by restoring the recorded previous staging"
            );
            return remove_staging_txn(parent, &txn.book_id, ops);
        }
    }
    // Neither recorded path holds a complete staging: keep what exists for
    // inspection and let the fresh-staging path import anew.
    remove_staging_txn(parent, &txn.book_id, ops)
}

/// R7-3/R8-2: the staging swap as a recorded transaction, injectable
/// (PreserveFs + a live-read verifier) so every boundary is provable:
///
/// - the transaction record (exact tmp/aside paths + phase) is durably and
///   ATOMICALLY written BEFORE any replacement — if it cannot persist, the
///   swap ABORTS with the previous staging untouched;
/// - FIRST-TIME stagings (`dir` absent) run the same transaction with no
///   aside step;
/// - "verified" is recorded AFTER the production readability check and
///   BEFORE the aside is released — a resume trusts only that record;
/// - `Err` ⇒ the previous state (previous staging, or absence) is live at
///   `dir` again, or the error says exactly where everything is preserved
///   and the record STAYS for the next resume.
fn swap_rebuilt_staging(
    dir: &Path,
    tmp: &Path,
    book_id: &str,
    source_file: &str,
    derived_file: &str,
    ops: &mut dyn PreserveFs,
    verify_live: &mut dyn FnMut() -> bool,
) -> Result<()> {
    let parent = dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("book dir has no parent"))?;
    let aside = parent.join(format!(".pre-rebuild-{}-{}", book_id, std::process::id()));
    // R9-2: no-follow on every path this transaction will act on — a planted
    // symlink refuses the swap before anything moves.
    refuse_symlink(dir, "live book dir")?;
    refuse_symlink(tmp, "staging tmp")?;
    refuse_symlink(&aside, "staging aside")?;
    crate::import::remove_book_dir_quiet(&aside);
    let had_previous = dir.try_exists().context("stat book dir before swap")?;

    let mut txn = StagingTxn {
        book_id: book_id.to_string(),
        tmp: tmp.to_path_buf(),
        aside: aside.clone(),
        source_file: source_file.to_string(),
        derived_file: derived_file.to_string(),
        phase: "prepared".to_string(),
        had_previous,
    };
    if let Err(e) = write_staging_txn(parent, &txn, ops) {
        // Abort BEFORE any replacement — including a partially-persisted
        // record: with the previous state intact it would only resolve to
        // cleanup, but leave nothing to resolve. Cleanup failures ride along
        // in the reported error instead of vanishing.
        let mut e = e.context("record the staging transaction (nothing was replaced)");
        if let Err(re) = remove_staging_txn(parent, book_id, ops) {
            e = e.context(format!("(the partial record could not be removed: {re:#})"));
        }
        crate::import::remove_book_dir_quiet(tmp);
        return Err(e);
    }

    // On revert success the transaction is RESOLVED (previous state live);
    // on a blocked revert the record STAYS so the next resume can finish.
    // R9-2: every step goes through the injectable seam; the restored
    // namespace is made durable BEFORE any recovery source (tmp, journal) is
    // deleted; and durability/cleanup failures PROPAGATE as compound context
    // on the original cause — never silently swallowed.
    let revert = |ops: &mut dyn PreserveFs, cause: anyhow::Error| -> anyhow::Error {
        if dir.exists() {
            if let Err(e) = ops.rename(dir, tmp) {
                return cause.context(format!(
                    "REVERT BLOCKED: could not clear the book dir ({e}); the previous staging \
                     is preserved beside it, nothing was deleted, and the recorded transaction \
                     will finish the recovery on the next attempt"
                ));
            }
        }
        if had_previous {
            if let Err(e) = ops.rename(&aside, dir) {
                return cause.context(format!(
                    "REVERT BLOCKED: could not restore the previous staging ({e}); it is preserved \
                     beside the book dir, nothing was deleted, and the recorded transaction will \
                     finish the recovery on the next attempt"
                ));
            }
        }
        if let Err(e) = ops.fsync_dir(parent) {
            return cause.context(format!(
                "REVERTED, but the revert's durability could not be proven ({e}); nothing was \
                 deleted — the rebuilt staging and the recorded transaction are preserved, and \
                 the next attempt will finish the recovery"
            ));
        }
        if let Err(e) = ops.remove_dir_all(tmp) {
            return cause.context(format!(
                "REVERTED, but the leftover rebuilt staging could not be removed ({e}); the \
                 recorded transaction will finish the cleanup on the next attempt"
            ));
        }
        if let Err(e) = remove_staging_txn(parent, book_id, ops) {
            return cause.context(format!(
                "REVERTED, but the transaction record could not be removed ({e:#}); the next \
                 resume will resolve it"
            ));
        }
        cause
    };

    if had_previous {
        if let Err(e) = ops.rename(dir, &aside) {
            let mut e = anyhow::Error::from(e).context("set aside the previous staging");
            if let Err(re) = remove_staging_txn(parent, book_id, ops) {
                e = e.context(format!(
                    "(the prepared record could not be removed: {re:#})"
                ));
            }
            crate::import::remove_book_dir_quiet(tmp);
            return Err(e);
        }
    }
    txn.phase = "swapping".to_string();
    if let Err(e) = write_staging_txn(parent, &txn, ops) {
        return Err(revert(ops, e.context("record the swap phase")));
    }
    if let Err(e) = ops.rename(tmp, dir) {
        return Err(revert(
            ops,
            anyhow::Error::from(e).context("swap the rebuilt staging into place"),
        ));
    }
    if let Err(e) = ops.fsync_dir(parent) {
        return Err(revert(
            ops,
            anyhow::Error::from(e).context("make the staging swap durable (parent fsync)"),
        ));
    }
    if !verify_live() {
        return Err(revert(
            ops,
            anyhow::anyhow!(
                "the rebuilt staging swapped in but does not read back through the production path"
            ),
        ));
    }
    // R8-2: durably record the verification BEFORE releasing the previous
    // staging — this record is the ONLY thing a resume trusts more than the
    // aside.
    txn.phase = "verified".to_string();
    if let Err(e) = write_staging_txn(parent, &txn, ops) {
        return Err(revert(ops, e.context("record the verified phase")));
    }
    if had_previous {
        // Only now may the previous staging go; a removal failure leaves an
        // inert leftover that the (verified) record resolves at next resume.
        let _ = ops.remove_dir_all(&aside);
    }
    let _ = ops.fsync_dir(parent);
    // R8-2: journal-removal failures PROPAGATE — a dangling record is a
    // pending recovery decision. (Phase "verified" is already durable, so a
    // retry converges: resume cleans up, the coherence gate then no-ops.)
    remove_staging_txn(parent, book_id, ops)
}

/// Verify the freshly generated sections reproduce the candidate's historical
/// sectionization exactly (count + per-index label/start/end), then rewrite
/// the staged `structure.json` keyed by the HISTORICAL ids. Err(reason) means
/// the staging must be refused and cleaned up.
fn remap_staged_structure_to_history(
    candidate_db: &Path,
    row: &CandidateBook,
    generated: &[crate::models::BookSection],
    dir: &Path,
) -> std::result::Result<(), String> {
    let history = candidate_sections(candidate_db, &row.id)
        .map_err(|_| "sections undecodable".to_string())?;
    if history.is_empty() {
        return Err("the backup lists no sections for this book".into());
    }
    if history.len() != generated.len() {
        return Err(format!(
            "the file derives {} sections where the backup recorded {}",
            generated.len(),
            history.len()
        ));
    }
    for (idx, (h, g)) in history.iter().zip(generated.iter()).enumerate() {
        if h.label != g.label
            || h.start_locator != g.start_locator
            || h.end_locator != g.end_locator
        {
            // Position only — a section label is book content (invariant 1)
            // and this reason can reach logs.
            return Err(format!(
                "section {idx} derives different bounds than the backup recorded"
            ));
        }
    }

    let structure_path = dir.join("structure.json");
    if !structure_path.is_file() {
        return Ok(()); // no typography sidecar — nothing to remap
    }
    let raw = std::fs::read_to_string(&structure_path)
        .map_err(|e| format!("staged structure.json unreadable: {e}"))?;
    let map: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| format!("staged structure.json invalid: {e}"))?;
    let mut remapped: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::with_capacity(map.len());
    for (new_id, ranges) in map {
        let Some(idx) = generated.iter().position(|g| g.id == new_id) else {
            return Err("staged structure.json keys an unknown generated section".into());
        };
        remapped.insert(history[idx].id.clone(), ranges);
    }
    let body =
        serde_json::to_string(&remapped).map_err(|e| format!("remap serialize failed: {e}"))?;
    paths::atomic_write_string(&structure_path, &body)
        .map_err(|e| format!("remapped structure.json write failed: {e}"))?;
    Ok(())
}

/// The newest pre-restore snapshot (the undo target for the last restore), or
/// None when no restore has happened / the snapshot was consumed by an undo.
pub fn newest_pre_restore_snapshot() -> Result<Option<PathBuf>> {
    let dir = paths::backups_dir()?;
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("read backups dir"),
    };
    // R5: EXPLICIT creation ordering — newest = highest embedded ordinal
    // (legacy ordinal-less names count as 0), name as the deterministic
    // tie-break. Lexical sorting of the whole name is NOT creation order once
    // pids and counters are in play.
    let mut candidates: Vec<(u64, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter_map(|p| {
            let name = p.file_name().and_then(|s| s.to_str())?;
            if name.starts_with(PRE_RESTORE_PREFIX) && name.ends_with(&format!(".{BACKUP_EXT}")) {
                Some((snapshot_ordinal(name), p.clone()))
            } else {
                None
            }
        })
        .collect();
    candidates.sort();
    Ok(candidates.pop().map(|(_, p)| p))
}

/// Copy a validated backup over the live DB path, preparing it first (R7-1),
/// with the sidecar-safe transition (R8-1). Used by automatic recovery.
fn restore_into_place(backup: &Path, live: &Path) -> Result<()> {
    restore_into_place_prepared(backup, live, Some(&mut settings::rotate_library_generation))
        .map_err(PromotionError::into_anyhow)
}

/// R8-1/R9-1: a promotion failure, TYPED by what the failure left behind.
/// "The live file was not replaced" is not one state — deleting the live
/// database's -wal/-shm is a real mutation (committed data can live only in
/// the WAL), so a failure after that deletion must never be reported as
/// "nothing was changed".
///
/// - `Untouched` ⇒ the live database FILE **and** its -wal/-shm sidecars are
///   byte-untouched. Only this class may honestly say "nothing was changed".
/// - `AuxMutated` ⇒ the live database FILE is byte-untouched, but its
///   -wal/-shm sidecars were (possibly) removed — and that removal possibly
///   made durable — before the failure. Every caller has SECURED the previous
///   library before calling (the checkpointed pre-restore snapshot for
///   commands, the preserved corrupt triple for automatic recovery), so no
///   committed data is lost, but the on-disk state is NOT "unchanged".
/// - `After` ⇒ the prepared candidate IS at the live path (content coherent,
///   generation already rotated) but the transition's durability or sidecar
///   hygiene could not be proven — callers must report that honestly, never
///   as "your library is unchanged".
#[derive(Debug)]
pub enum PromotionError {
    Untouched(anyhow::Error),
    AuxMutated(anyhow::Error),
    After(anyhow::Error),
}

impl PromotionError {
    pub(crate) fn into_anyhow(self) -> anyhow::Error {
        match self {
            PromotionError::Untouched(e) => e.context("promotion aborted (live DB untouched)"),
            PromotionError::AuxMutated(e) => e.context(
                "promotion aborted (live DB file untouched; its WAL/SHM sidecars were cleared)",
            ),
            PromotionError::After(e) => e.context(
                "PROMOTED, but the transition could not be proven — relaunch to re-verify",
            ),
        }
    }
}

/// R9-1: a named-boundary failure seam for the promotion protocol, usable
/// through the COMMAND layer and AUTOMATIC recovery (which construct their
/// own `RealPreserveFs` internally, out of reach of `FailAtOp`). Thread-local
/// and self-disarming: the injected failure fires exactly once, so a caller's
/// own rollback promotion still works.
#[cfg(test)]
pub(crate) mod promotion_test_seam {
    use std::cell::Cell;

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(crate) enum FailPoint {
        PreRenameDirFsync,
        Rename,
        PostRenameDirFsync,
    }

    thread_local! {
        static FAIL_AT: Cell<Option<FailPoint>> = const { Cell::new(None) };
    }

    pub(crate) fn arm(p: FailPoint) {
        FAIL_AT.with(|c| c.set(Some(p)));
    }

    pub(crate) fn disarm() {
        FAIL_AT.with(|c| c.set(None));
    }

    pub(crate) fn fail_here(p: FailPoint) -> anyhow::Result<()> {
        let fires = FAIL_AT.with(|c| {
            if c.get() == Some(p) {
                c.set(None);
                true
            } else {
                false
            }
        });
        if fires {
            anyhow::bail!("injected promotion failure at {p:?}");
        }
        Ok(())
    }
}

/// R8-1: sidecar paths for a database main file.
fn db_sidecars(main: &Path) -> [PathBuf; 2] {
    let s = main.to_string_lossy();
    [
        PathBuf::from(format!("{s}-wal")),
        PathBuf::from(format!("{s}-shm")),
    ]
}

/// Remove `main`'s -wal/-shm and PROVE them absent (NotFound is fine; any
/// other failure, or a surviving sidecar, propagates). A stale WAL beside a
/// database file is not mere litter: SQLite will REPLAY a self-consistent
/// WAL into whatever main file sits at that path.
fn clear_and_prove_sidecars_absent(main: &Path, ops: &mut dyn PreserveFs) -> Result<()> {
    for side in db_sidecars(main) {
        match ops.remove_file(&side) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("remove sidecar {side:?}")),
        }
        if side
            .try_exists()
            .with_context(|| format!("prove sidecar {side:?} absent"))?
        {
            anyhow::bail!("sidecar {side:?} still exists after removal");
        }
    }
    Ok(())
}

/// R7-1/R8-1: promote `backup` into place GENERATION-SAFELY and
/// SIDECAR-SAFELY. `rotate` is `None` only for ROLLBACKS: a rollback restores
/// a snapshot of the previous library as-it-was, and that snapshot already
/// carries the very token the reader's drafts were typed under.
pub(crate) fn restore_into_place_prepared(
    backup: &Path,
    live: &Path,
    rotate: Option<RotateFn<'_>>,
) -> std::result::Result<(), PromotionError> {
    // R8-1: a UNIQUE basename per attempt — a crashed earlier attempt (pid
    // reuse included) can never leave sidecars this attempt would inherit.
    let tmp = live.with_extension(format!(
        "db.restore-tmp.{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    restore_into_place_prepared_at(backup, live, &tmp, rotate, &mut RealPreserveFs)
}

/// R8-1: the promotion protocol, with the temp path and file ops injectable
/// so the stale-WAL and crash-boundary regressions can drive it directly:
///
///   1. copy the candidate to `tmp`;
///   2. PROVE tmp's -wal/-shm absent BEFORE SQLite opens the path (a planted
///      or stale WAL would otherwise be replayed into the candidate);
///   3. prepare (migrate + rotate + checkpoint TRUNCATE), prove the temp
///      sidecars gone again, fsync the main file;
///   4. clear the LIVE database's -wal/-shm, prove them absent, and FSYNC
///      THE DATA DIRECTORY (R9-1) BEFORE the rename — the sidecar unlinks
///      must be durable before the rename can become durable, or a crash
///      could persist the rename but not the unlinks and leave the REPLACED
///      database's WAL beside the candidate for SQLite to replay;
///   5. rename tmp → live (THE commit point), fsync the parent, and prove
///      the promoted file still has no sidecars.
///
/// Failures through step 3 are `PromotionError::Untouched` (live file AND
/// sidecars untouched); failures from step 4 through the rename are
/// `AuxMutated` (live file untouched, sidecars possibly cleared); failures
/// after the rename are `After` (promoted, unproven).
pub(crate) fn restore_into_place_prepared_at(
    backup: &Path,
    live: &Path,
    tmp: &Path,
    rotate: Option<RotateFn<'_>>,
    ops: &mut dyn PreserveFs,
) -> std::result::Result<(), PromotionError> {
    let untouched = PromotionError::Untouched;
    let aux = PromotionError::AuxMutated;
    let parent = match live.parent() {
        Some(p) => p,
        None => {
            return Err(untouched(anyhow::anyhow!(
                "db path has no parent: {live:?}"
            )))
        }
    };
    // R10-2: WAL-sensitive promotion runs only under this process's
    // exclusive interprocess lock — no second process can open the database
    // (recreating -wal/-shm) between the sidecar clearing and the rename.
    crate::db::acquire_process_lock_for(parent).map_err(untouched)?;
    std::fs::create_dir_all(parent)
        .context("ensure data dir for restore")
        .map_err(untouched)?;

    let _ = std::fs::remove_file(tmp);
    ops.copy(backup, tmp)
        .context("copy backup to temp")
        .map_err(untouched)?;
    // Step 2: no sidecar may exist when SQLite first opens this path.
    clear_and_prove_sidecars_absent(tmp, ops).map_err(untouched)?;
    if let Some(rotate) = rotate {
        let prepare = |rotate: &mut dyn FnMut(&Connection) -> Result<String>| -> Result<()> {
            let conn = Connection::open(tmp).context("open restore temp for preparation")?;
            migrations::apply_pending(&conn).context("migrate restore temp")?;
            rotate(&conn)
                .context("rotate the library generation on the restore temp (before promotion)")?;
            // Fold any WAL back into the main file so the rename promotes ONE
            // self-contained file.
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .context("checkpoint restore temp")?;
            Ok(())
        };
        if let Err(e) = prepare(rotate) {
            for side in db_sidecars(tmp) {
                let _ = std::fs::remove_file(&side);
            }
            let _ = std::fs::remove_file(tmp);
            return Err(untouched(e));
        }
        // Step 3: nothing rides along with the main file into promotion.
        clear_and_prove_sidecars_absent(tmp, ops).map_err(untouched)?;
    }
    ops.fsync_file(tmp)
        .context("fsync prepared restore temp")
        .map_err(untouched)?;

    // Step 4: the REPLACED database's WAL goes before its main file does —
    // from here on the live path is no longer "untouched".
    clear_and_prove_sidecars_absent(live, ops).map_err(aux)?;
    // R9-1: make the sidecar unlinks durable BEFORE the rename. Without this
    // ordering fsync a crash could persist the rename but not the unlinks,
    // leaving the replaced database's WAL beside the promoted candidate.
    #[cfg(test)]
    promotion_test_seam::fail_here(promotion_test_seam::FailPoint::PreRenameDirFsync)
        .map_err(aux)?;
    ops.fsync_dir(parent)
        .context("fsync data dir after clearing live sidecars (pre-rename)")
        .map_err(aux)?;

    // Step 5: THE commit point.
    #[cfg(test)]
    promotion_test_seam::fail_here(promotion_test_seam::FailPoint::Rename).map_err(aux)?;
    ops.rename(tmp, live)
        .context("rename restored DB into place")
        .map_err(aux)?;
    #[cfg(test)]
    promotion_test_seam::fail_here(promotion_test_seam::FailPoint::PostRenameDirFsync)
        .map_err(PromotionError::After)?;
    ops.fsync_dir(parent)
        .context("fsync data dir after promotion")
        .map_err(PromotionError::After)?;
    // Belt: nothing may have recreated live sidecars between the pre-rename
    // proof and now (nothing had the DB open) — an unprovable state reports.
    for side in db_sidecars(live) {
        match side.try_exists() {
            Ok(false) => {}
            Ok(true) => {
                return Err(PromotionError::After(anyhow::anyhow!(
                    "sidecar {side:?} reappeared beside the promoted database"
                )))
            }
            Err(e) => {
                return Err(PromotionError::After(
                    anyhow::Error::from(e).context("prove promoted sidecars absent"),
                ))
            }
        }
    }
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

    /// MUST run while the caller still holds the env lock: it removes the
    /// THROUGHLINE_* overrides and deletes the data dir — done after dropping
    /// the lock, another test could resolve its DB path into a directory being
    /// torn down ("file is not a database" on CI, where timing is unfriendly).
    fn cleanup(data: &Path) {
        unsafe {
            std::env::remove_var("THROUGHLINE_DATA_DIR");
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        let _ = std::fs::remove_dir_all(data);
    }

    /// Seed a book the DEEP preflight accepts: a real source file whose
    /// SHA-256 matches the row, a derived reader.txt, and section rows whose
    /// locators cover the text — mirroring what a real import produces.
    fn seed_book(conn: &Connection, id: &str) {
        seed_book_with_sections(
            conn,
            id,
            "seeded readable words for tests",
            &[("Reading", 0)],
        );
    }

    /// [`seed_book`] with a caller-chosen display title.
    fn seed_titled_book(conn: &Connection, id: &str, title: &str, body: &str) {
        seed_book_with_sections(conn, id, body, &[("Reading", 0)]);
        conn.execute(
            "UPDATE books SET title = ?2 WHERE id = ?1",
            rusqlite::params![id, title],
        )
        .unwrap();
    }

    /// `sections` are (label, start) pairs; each section runs to the next
    /// section's start (the last to the end of `body`).
    fn seed_book_with_sections(
        conn: &Connection,
        id: &str,
        body: &str,
        sections: &[(&str, usize)],
    ) {
        let dir = paths::book_dir(id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("source.txt"), body).unwrap();
        std::fs::write(dir.join("reader.txt"), body).unwrap();
        let sha = crate::import::hash_file(&dir.join("source.txt")).unwrap();
        conn.execute(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES (?1,'T','txt','/p',?2,'2026-01-01')",
            rusqlite::params![id, sha],
        )
        .unwrap();
        for (i, (label, start)) in sections.iter().enumerate() {
            let end = sections.get(i + 1).map(|s| s.1).unwrap_or(body.len());
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, start_locator, end_locator, sort_order, assignable)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                rusqlite::params![
                    format!("sec_{id}_{i}"),
                    id,
                    label,
                    start.to_string(),
                    end.to_string(),
                    i as i64
                ],
            )
            .unwrap();
        }
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
        cleanup(&data);
        drop(g);
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
        cleanup(&data);
        drop(g);
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
            restored.restored().is_some(),
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
        cleanup(&data);
        drop(g);
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
            restored.restored().is_none(),
            "with no usable backup, restore must report None (caller goes fresh)"
        );
        cleanup(&data);
        drop(g);
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
            restored.restored().is_none(),
            "a corrupt backup must be rejected, not restored"
        );
        cleanup(&data);
        drop(g);
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
        assert!(
            restored.restored().is_some(),
            "the newest GOOD backup should restore"
        );
        let conn2 = crate::db::open_and_migrate().expect("open after restore");
        let n: i64 = conn2
            .query_row("SELECT COUNT(*) FROM books WHERE id='b_newest'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
        drop(conn2);
        cleanup(&data);
        drop(g);
    }

    #[test]
    fn taken_at_parses_the_filename_timestamp_and_rejects_garbage() {
        use chrono::{Datelike, Timelike};
        let t = backup_taken_at(Path::new("/x/backups/reading-20260703-091205.db"))
            .expect("well-formed name parses");
        assert_eq!(
            (t.year(), t.month(), t.day(), t.hour(), t.minute()),
            (2026, 7, 3, 9, 12)
        );
        for bad in [
            "reading-.db",
            "reading-2026.db",
            "pre-restore-20260703-091205.db",
            "notes.txt",
            "reading-20261399-991205.db", // impossible date
        ] {
            assert!(
                backup_taken_at(Path::new(bad)).is_none(),
                "{bad} must not parse"
            );
        }
    }

    #[test]
    fn backup_due_is_enabled_gated_and_24h_bounded() {
        use chrono::TimeZone;
        let now = chrono::Local
            .with_ymd_and_hms(2026, 7, 3, 12, 0, 0)
            .unwrap();
        // Disabled → never due, even with no backup at all.
        assert!(!backup_due(false, None, now));
        // Enabled + no backup yet → due.
        assert!(backup_due(true, None, now));
        // Fresh backup → not due; a day-old one → due.
        let fresh = now - chrono::Duration::hours(1);
        let stale = now - chrono::Duration::hours(25);
        assert!(!backup_due(true, Some(fresh), now));
        assert!(backup_due(true, Some(stale), now));
    }

    #[test]
    fn resolve_backup_by_id_refuses_traversal_and_off_scheme_names() {
        let (g, conn, data) = isolated_open();
        let dest = write_rolling_backup(&conn).expect("backup");
        let id = dest.file_name().unwrap().to_str().unwrap().to_string();
        // The genuine id resolves to the file that was written.
        assert_eq!(resolve_backup_by_id(&id).unwrap(), dest);
        // IPC-shaped hostile ids never reach the filesystem join.
        for bad in [
            "../reading.db",
            "/etc/passwd",
            "reading-20260101-000000.db/..",
            "nested/reading-20260101-000000.db",
            "notes.txt",
            "pre-restore-20260101-000000.db",
            "",
            "reading-99999999-999999.db", // scheme-shaped but nonexistent
        ] {
            assert!(
                resolve_backup_by_id(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    #[test]
    fn newest_backup_taken_at_reports_the_newest_or_none() {
        let (g, conn, data) = isolated_open();
        assert_eq!(
            newest_backup_taken_at().expect("call"),
            None,
            "no backups yet → None"
        );
        let dir = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        for stamp in ["20260101-000000", "20260301-120000"] {
            std::fs::write(
                dir.join(format!("{BACKUP_PREFIX}{stamp}.{BACKUP_EXT}")),
                b"x",
            )
            .unwrap();
        }
        let newest = newest_backup_taken_at().expect("call").expect("some");
        assert!(
            newest.starts_with("2026-03-01T12:00:00"),
            "newest must win, got {newest}"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    #[test]
    fn restore_by_id_round_trips_and_pre_restore_snapshot_survives_pruning() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "b_keep");
        let dest = write_rolling_backup(&conn).expect("backup");
        let id = dest.file_name().unwrap().to_str().unwrap().to_string();

        // Diverge the live DB after the backup, then snapshot it pre-restore.
        seed_book(&conn, "b_after_backup");
        let snap = write_pre_restore_snapshot(&conn).expect("snapshot");
        assert!(snap.exists());
        assert!(
            !is_backup_file(&snap),
            "the safety snapshot must be invisible to the rolling scheme"
        );
        assert!(
            !list_backups(&paths::backups_dir().unwrap())
                .unwrap()
                .contains(&snap),
            "list_backups must not offer the snapshot for restore-pruning"
        );

        // Restore: close the live connection first (the command layer's job).
        drop(conn);
        let candidate = resolve_backup_by_id(&id).expect("resolve");
        assert!(validate_backup(&candidate).expect("validate"));
        restore_backup_file(&candidate).expect("restore");

        let conn2 = crate::db::open_and_migrate().expect("reopen");
        let count = |id: &str| -> i64 {
            conn2
                .query_row("SELECT COUNT(*) FROM books WHERE id=?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count("b_keep"), 1, "the backed-up row is back");
        assert_eq!(
            count("b_after_backup"),
            0,
            "post-backup divergence is gone (that's what restore means)"
        );
        // …but not lost: the pre-restore snapshot still holds it.
        let sconn = Connection::open(&snap).unwrap();
        let n: i64 = sconn
            .query_row(
                "SELECT COUNT(*) FROM books WHERE id='b_after_backup'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "the safety snapshot preserves the pre-restore state");
        drop(conn2);
        cleanup(&data);
        drop(g);
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
        cleanup(&data);
        drop(g);
        let _ = std::fs::remove_dir_all(&export);
    }

    // ── REC-011: truthful, coherent, undoable restore ──

    /// Validation must run against a DISPOSABLE COPY: a candidate with a
    /// PENDING migration (its newest schema_migrations row removed) forces a
    /// real migration write during validation, and the candidate must still
    /// come out byte-identical (the old code migrated — wrote — the sole
    /// backup itself).
    #[test]
    fn validation_runs_on_a_disposable_copy_and_never_mutates_the_backup() {
        let (g, conn, data) = isolated_open();
        let dir = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let candidate = dir.join("reading-20200101-000000.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        {
            // Make one migration PENDING on the candidate (up fns are
            // idempotent by contract, so re-running it on the copy is legal).
            let c = Connection::open(&candidate).unwrap();
            let newest = crate::migrations::MIGRATIONS.last().unwrap().version;
            c.execute("DELETE FROM schema_migrations WHERE version = ?1", [newest])
                .unwrap();
        }
        let before = std::fs::read(&candidate).unwrap();

        let usable = validate_backup(&candidate).expect("validation runs");

        let after = std::fs::read(&candidate).unwrap();
        let litter: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("validate-tmp"))
            .collect();
        drop(conn);
        cleanup(&data);
        drop(g);

        assert!(usable, "an empty DB migrates cleanly on the copy");
        assert_eq!(
            before, after,
            "the sole backup must never be written during validation"
        );
        assert!(litter.is_empty(), "no validation litter left behind");
    }

    /// The automatic corruption recovery must preserve the corrupt live DB and
    /// its WAL/SHM sidecars BYTE-FOR-BYTE before the restore replaces them —
    /// corrupt bytes are salvage material, never disposable.
    #[test]
    fn automatic_restore_preserves_the_corrupt_live_db_and_sidecars() {
        let (g, conn, data) = isolated_open();
        write_rolling_backup(&conn).expect("good backup");
        drop(conn);

        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"CORRUPT BYTES").unwrap();
        std::fs::write(format!("{}-wal", live.display()), b"WAL JUNK").unwrap();
        std::fs::write(format!("{}-shm", live.display()), b"SHM JUNK").unwrap();

        // The caller's REQUIRED order (lib.rs): preserve, then restore.
        let kept = preserve_corrupt_live(&live)
            .expect("preservation is a hard precondition")
            .expect("there was a live file to preserve");
        assert!(kept.exists());
        let restored = try_restore_newest_backup().expect("restore runs");
        let restored = restored.restored().expect("a backup restored");
        assert!(restored.exists());

        let preserved: Vec<PathBuf> = std::fs::read_dir(live.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("reading.corrupt-")
            })
            .collect();
        let db_kept = preserved
            .iter()
            .find(|p| p.to_string_lossy().ends_with(".db"))
            .expect("corrupt db preserved");
        assert_eq!(
            std::fs::read(db_kept).unwrap(),
            b"CORRUPT BYTES",
            "preserved corrupt DB is byte-identical"
        );
        assert!(
            preserved
                .iter()
                .any(|p| p.to_string_lossy().ends_with("db-wal")),
            "WAL sidecar preserved: {preserved:?}"
        );
        assert!(
            preserved
                .iter()
                .any(|p| p.to_string_lossy().ends_with("db-shm")),
            "SHM sidecar preserved: {preserved:?}"
        );
        // And the restored live DB genuinely opens.
        let reopened = crate::db::open_and_migrate().expect("restored DB opens");
        drop(reopened);
        cleanup(&data);
        drop(g);
    }

    /// A backup listing a book whose files are gone must be NAMED as missing —
    /// the coherence gate the restore command rejects on. With the file back
    /// (any of reader.txt / source.txt / source.epub), it becomes coherent.
    #[test]
    fn restore_coherence_names_books_whose_files_are_gone() {
        let (g, conn, data) = isolated_open();
        seed_titled_book(&conn, "bk_present", "Kept Book", "kept book readable words");
        // Ghost Book: a coherent-looking ROW whose files are simply gone.
        conn.execute_batch(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('bk_gone','Ghost Book','txt','/y','s2','2026-01-01');",
        )
        .unwrap();
        let candidate = data.join("candidate.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();

        let missing = books_missing_files(&candidate).expect("coherence check runs");
        assert_eq!(missing, vec!["Ghost Book".to_string()]);

        // Making it TRULY coherent — matching source bytes, derived text, and
        // section rows — clears it (snapshotted as a fresh candidate, since
        // coherence is judged between a candidate's rows and the disk).
        conn.execute("DELETE FROM books WHERE id = 'bk_gone'", [])
            .unwrap();
        seed_titled_book(
            &conn,
            "bk_gone",
            "Ghost Book",
            "ghost book words, readable again",
        );
        let candidate_fixed = data.join("candidate-fixed.db");
        conn.execute(
            "VACUUM INTO ?1",
            [candidate_fixed.to_string_lossy().as_ref()],
        )
        .unwrap();
        assert!(books_missing_files(&candidate_fixed).unwrap().is_empty());

        // …while an epub row whose only artifact is GARBAGE bytes stays
        // missing: existence is not readability (the production regeneration
        // entry must actually open it).
        conn.execute(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('bk_junk_epub','Junk Epub','epub','/z','s3','2026-01-01')",
            [],
        )
        .unwrap();
        let d3 = paths::book_dir("bk_junk_epub").unwrap();
        std::fs::create_dir_all(&d3).unwrap();
        std::fs::write(d3.join("source.epub"), "not actually a zip").unwrap();
        let candidate2 = data.join("candidate2.db");
        conn.execute("VACUUM INTO ?1", [candidate2.to_string_lossy().as_ref()])
            .unwrap();
        assert_eq!(
            books_missing_files(&candidate2).unwrap(),
            vec!["Junk Epub".to_string()],
            "a garbage source.epub must not count as readable"
        );

        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// backup → add a book → restore → the library is back at backup time and
    /// the surviving book still READS; undo → the pre-restore library returns.
    #[test]
    fn restore_then_undo_round_trip_returns_the_pre_restore_library() {
        let (g, conn, data) = isolated_open();
        fn titles(conn: &Connection) -> Vec<String> {
            let mut stmt = conn
                .prepare("SELECT title FROM books ORDER BY title")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .filter_map(|x| x.ok())
                .collect()
        }
        // T0: book A with a real readable file (fully coherent seed).
        seed_titled_book(&conn, "bk_a", "Book A", "the words of book A");
        write_rolling_backup(&conn).expect("T0 backup");

        // T1: book B is added AFTER the backup.
        seed_titled_book(&conn, "bk_b", "Book B", "the words of book B");

        // Reader-initiated restore: snapshot first (the undo target), then T0.
        write_pre_restore_snapshot(&conn).expect("pre-restore snapshot");
        drop(conn);
        let dir = paths::backups_dir().unwrap();
        let newest = list_backups(&dir).unwrap().pop().expect("rolling backup");
        assert!(
            books_missing_files(&newest).unwrap().is_empty(),
            "the T0 backup is coherent (book A's file exists)"
        );
        restore_backup_file(&newest).expect("restore");

        let conn = crate::db::open_and_migrate().expect("reopen after restore");
        assert_eq!(titles(&conn), vec!["Book A".to_string()]);
        // The restored book still READS through the real read path.
        let body =
            crate::commands::books::read_txt_section("bk_a", 0, None).expect("restored book reads");
        assert!(body.contains("words of book A"));
        drop(conn);

        // Undo: the pre-restore snapshot brings book B back.
        let snap = newest_pre_restore_snapshot()
            .unwrap()
            .expect("undo target exists after a restore");
        assert!(validate_backup(&snap).unwrap(), "undo copy validates");
        restore_backup_file(&snap).expect("undo restore");
        let conn = crate::db::open_and_migrate().expect("reopen after undo");
        assert_eq!(
            titles(&conn),
            vec!["Book A".to_string(), "Book B".to_string()],
            "undo returns the exact pre-restore library"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── REC-011 round 2: staging by SHA, incoherent auto-restore, required preservation ──

    /// The full "re-import, then restore" loop with a REAL book: import the
    /// canonical fixture, back up, remove the book's files (what cmd_delete_book
    /// does), watch restore refuse, stage the SAME file back by full SHA-256
    /// under the historical id, then restore and READ through the production path.
    #[test]
    fn real_import_backup_remove_stage_by_sha_restore_read() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/confessions_augustine.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        // The section rows too — a real library DB always carries them
        // (insert_book_atomic), and the deep preflight + staging remap key
        // off these HISTORICAL ids.
        for s in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator,
                    s.estimated_units, s.sort_order, s.assignable as i64
                ],
            )
            .unwrap();
        }
        let historical_ids: std::collections::HashSet<String> =
            result.sections.iter().map(|s| s.id.clone()).collect();
        write_rolling_backup(&conn).expect("backup with the real book");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();

        // Remove the book's FILES (the delete path removes the whole book dir).
        crate::import::remove_book_dir_for_tests(&paths::book_dir(&book_id).unwrap());
        assert!(!paths::book_dir(&book_id).unwrap().exists());

        // The shared preflight now refuses this backup, naming the book.
        let missing = restore_preflight(&backup_file).expect("preflight runs");
        assert_eq!(missing.len(), 1);
        assert!(missing[0].contains("Confessions") || !missing[0].is_empty());

        // A NON-matching file is refused by content (never by name).
        let other = std::path::Path::new("tests/fixtures/corpus/meditations.txt");
        let err = stage_book_for_restore(&backup_file, other)
            .expect_err("a different book's file must not match");
        assert!(format!("{err:#}").contains("doesn't match"), "{err:#}");

        // The ORIGINAL file matches by SHA-256 and stages under the historical id.
        let staged = stage_book_for_restore(&backup_file, fixture).expect("stage by SHA");
        assert_eq!(staged.id, book_id, "staged under the HISTORICAL id");
        // The regenerated structure.json was REMAPPED onto the HISTORICAL
        // section ids (the importer generated fresh ones): every key must be
        // an id the backup's rows actually reference — otherwise typography
        // silently vanishes for every section after restore.
        let structure_path = paths::book_dir(&book_id).unwrap().join("structure.json");
        if structure_path.is_file() {
            let map: std::collections::HashMap<String, serde_json::Value> =
                serde_json::from_str(&std::fs::read_to_string(&structure_path).unwrap()).unwrap();
            for k in map.keys() {
                assert!(
                    historical_ids.contains(k),
                    "structure.json key {k} is not a historical section id"
                );
            }
        }
        assert!(
            restore_preflight(&backup_file)
                .expect("preflight")
                .is_empty(),
            "staging makes the backup coherent"
        );
        // Staging is idempotent.
        stage_book_for_restore(&backup_file, fixture).expect("re-stage is a no-op");

        // Restore, reopen, and READ the book through the production path.
        drop(conn);
        restore_backup_file(&backup_file).expect("restore");
        let conn = crate::db::open_and_migrate().expect("reopen");
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id = ?1", [&book_id], |r| {
                r.get(0)
            })
            .expect("restored row present");
        assert!(!title.is_empty());
        let body = crate::commands::books::read_txt_section(&book_id, 0, Some(400))
            .expect("restored book reads");
        assert!(!body.trim().is_empty());
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// Automatic recovery must SKIP a backup whose books would not read
    /// (unreadable artifacts) and fall through to None rather than resurrect
    /// ghost rows.
    #[test]
    fn automatic_restore_skips_incoherent_backups() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "bk_will_vanish");
        write_rolling_backup(&conn).expect("backup");
        drop(conn);
        // The book's files vanish AFTER the backup; the live DB corrupts.
        let _ = std::fs::remove_dir_all(paths::book_dir("bk_will_vanish").unwrap());
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"CORRUPT").unwrap();
        preserve_corrupt_live(&live)
            .expect("preserve")
            .expect("live existed");

        let restored = try_restore_newest_backup().expect("restore call");
        assert!(
            restored.restored().is_none(),
            "an incoherent backup must be skipped, never restored into ghost rows"
        );
        cleanup(&data);
        drop(g);
    }

    /// Preservation is REQUIRED, unique, and total: when the data dir refuses
    /// writes, preservation fails, and the caller must replace NOTHING — the
    /// corrupt live DB and BOTH sidecars stay exactly where and what they were.
    #[cfg(unix)]
    #[test]
    fn preservation_failure_replaces_nothing_and_errors() {
        use std::os::unix::fs::PermissionsExt;
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"CORRUPT DB").unwrap();
        std::fs::write(format!("{}-wal", live.display()), b"WAL BYTES").unwrap();
        std::fs::write(format!("{}-shm", live.display()), b"SHM BYTES").unwrap();

        let dir = live.parent().unwrap().to_path_buf();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let enforced = std::fs::write(dir.join(".probe"), b"x").is_err();
        let result = if enforced {
            Some(preserve_corrupt_live(&live))
        } else {
            None
        };
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let db_after = std::fs::read(&live).unwrap();
        let wal_after = std::fs::read(format!("{}-wal", live.display())).unwrap();
        let shm_after = std::fs::read(format!("{}-shm", live.display())).unwrap();
        cleanup(&data);
        drop(g);

        let Some(result) = result else {
            eprintln!("skipping preservation-failure assertion: permissions not enforced (root?)");
            return;
        };
        assert!(
            result.is_err(),
            "preservation failure must be an ERROR, never silent"
        );
        assert_eq!(
            db_after, b"CORRUPT DB",
            "live DB untouched on preservation failure"
        );
        assert_eq!(wal_after, b"WAL BYTES", "WAL untouched");
        assert_eq!(shm_after, b"SHM BYTES", "SHM untouched");
    }

    /// Two preservations in the same second must land under DISTINCT names —
    /// a later one never overwrites an earlier forensic artifact.
    #[test]
    fn repeated_preservation_never_overwrites_an_earlier_artifact() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"FIRST CORRUPT").unwrap();
        let first = preserve_corrupt_live(&live).unwrap().unwrap();
        std::fs::write(&live, b"SECOND CORRUPT").unwrap();
        let second = preserve_corrupt_live(&live).unwrap().unwrap();
        assert_ne!(first, second, "unique preservation names");
        assert_eq!(std::fs::read(&first).unwrap(), b"FIRST CORRUPT");
        assert_eq!(std::fs::read(&second).unwrap(), b"SECOND CORRUPT");
        cleanup(&data);
        drop(g);
    }

    // ── REC-011 R3: copy-based preservation, injected at EVERY op boundary ──

    /// A [`PreserveFs`] that delegates to the real one but fails exactly the
    /// N-th operation (0-indexed), counting every call across all five ops.
    struct FailAtOp {
        real: RealPreserveFs,
        fail_at: usize,
        count: usize,
    }
    impl FailAtOp {
        fn step(&mut self) -> std::io::Result<()> {
            let n = self.count;
            self.count += 1;
            if n == self.fail_at {
                Err(std::io::Error::other("injected preservation failure"))
            } else {
                Ok(())
            }
        }
    }
    impl PreserveFs for FailAtOp {
        fn copy(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.copy(from, to)
        }
        fn fsync_file(&mut self, p: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.fsync_file(p)
        }
        fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.rename(from, to)
        }
        fn fsync_dir(&mut self, p: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.fsync_dir(p)
        }
        fn write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<()> {
            self.step()?;
            self.real.write(p, bytes)
        }
        fn remove_file(&mut self, p: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.remove_file(p)
        }
        fn remove_dir_all(&mut self, p: &Path) -> std::io::Result<()> {
            self.step()?;
            self.real.remove_dir_all(p)
        }
        fn create_new_write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<(u64, u64)> {
            self.step()?;
            self.real.create_new_write(p, bytes)
        }
    }

    /// THE preservation invariant, proven by injecting a failure after every
    /// single file operation and directory fsync: at every boundary, a
    /// complete byte-identical copy of the corrupt triple exists on disk —
    /// as the untouched originals until the preserved copy is durable, then
    /// as the preserved copy. The old rename-based code failed this at op 0.
    #[test]
    fn preservation_failure_at_every_op_boundary_keeps_a_complete_copy() {
        let dir = std::env::temp_dir().join(format!(
            "tl-preserve-inject-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let setup = |dir: &Path| -> PathBuf {
            let _ = std::fs::remove_dir_all(dir);
            std::fs::create_dir_all(dir).unwrap();
            let live = dir.join("reading.db");
            std::fs::write(&live, b"CORRUPT DB BYTES").unwrap();
            std::fs::write(dir.join("reading.db-wal"), b"CORRUPT WAL").unwrap();
            std::fs::write(dir.join("reading.db-shm"), b"CORRUPT SHM").unwrap();
            live
        };
        let originals: [(&str, &[u8]); 3] = [
            ("reading.db", b"CORRUPT DB BYTES"),
            ("reading.db-wal", b"CORRUPT WAL"),
            ("reading.db-shm", b"CORRUPT SHM"),
        ];

        // Count the total ops on a clean run first.
        let live = setup(&dir);
        let mut counter = FailAtOp {
            real: RealPreserveFs,
            fail_at: usize::MAX,
            count: 0,
        };
        let kept = preserve_corrupt_live_with(&live, &mut counter)
            .expect("clean run preserves")
            .expect("live existed");
        let total_ops = counter.count;
        assert!(total_ops >= 10, "3 members × copy+fsync + renames + fsync");
        // Clean run: preserved copy complete — and the ORIGINALS STAY (R4):
        // recovery replaces them atomically (restore) or clears them
        // explicitly (fresh start); preservation itself never removes them,
        // so no failure window can leave the live path absent.
        assert_eq!(std::fs::read(&kept).unwrap(), b"CORRUPT DB BYTES");
        for (name, bytes) in &originals {
            assert_eq!(
                std::fs::read(dir.join(name)).unwrap(),
                *bytes,
                "clean run: original {name} still present and byte-identical"
            );
        }

        for fail_at in 0..total_ops {
            let live = setup(&dir);
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at,
                count: 0,
            };
            let result = preserve_corrupt_live_with(&live, &mut ops);
            assert!(result.is_err(), "op {fail_at} was injected to fail");

            // R4 invariant: the originals are ALWAYS present and byte-identical
            // at every failure boundary — a relaunch re-enters corruption
            // recovery; it can never find an absent DB and mint a fresh library.
            for (name, bytes) in &originals {
                let orig = dir.join(name);
                assert!(
                    orig.exists(),
                    "op {fail_at}: original {name} must still exist"
                );
                assert_eq!(
                    std::fs::read(&orig).unwrap(),
                    *bytes,
                    "op {fail_at}: original {name} must be BYTE-IDENTICAL"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R4: a failure at the FINAL directory fsync — after every copy landed —
    /// followed by a "relaunch". The live path must never be absent (an absent
    /// DB would silently mint a fresh empty library); the relaunch preserves
    /// again under a new unique name and only the explicit fresh-start step
    /// may clear the live triple.
    #[test]
    fn failure_after_final_fsync_keeps_live_present_and_relaunch_recovers() {
        let dir = std::env::temp_dir().join(format!(
            "tl-preserve-finalfsync-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("reading.db");
        std::fs::write(&live, b"CORRUPT DB BYTES").unwrap();
        std::fs::write(dir.join("reading.db-wal"), b"CORRUPT WAL").unwrap();

        // Count ops, then fail exactly the LAST one (the directory fsync).
        let mut counter = FailAtOp {
            real: RealPreserveFs,
            fail_at: usize::MAX,
            count: 0,
        };
        preserve_corrupt_live_with(&live, &mut counter).unwrap();
        let total = counter.count;
        // Reset to the pre-preservation state.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&live, b"CORRUPT DB BYTES").unwrap();
        std::fs::write(dir.join("reading.db-wal"), b"CORRUPT WAL").unwrap();

        let mut ops = FailAtOp {
            real: RealPreserveFs,
            fail_at: total - 1,
            count: 0,
        };
        preserve_corrupt_live_with(&live, &mut ops)
            .expect_err("the final fsync was injected to fail");
        assert!(
            live.exists(),
            "the live DB must never be absent after a preservation failure"
        );
        assert_eq!(std::fs::read(&live).unwrap(), b"CORRUPT DB BYTES");

        // "Relaunch": preservation runs again (new unique name) and succeeds.
        let kept = preserve_corrupt_live(&live)
            .expect("relaunch preserves")
            .expect("live existed");
        assert_eq!(std::fs::read(&kept).unwrap(), b"CORRUPT DB BYTES");
        assert!(
            live.exists(),
            "originals still in place after successful preservation"
        );

        // Only the explicit fresh-start step clears the live triple.
        clear_live_db_after_preservation(&live).expect("clear for fresh start");
        assert!(!live.exists());
        assert!(!dir.join("reading.db-wal").exists());
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"CORRUPT DB BYTES",
            "preserved copy untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── R4: snapshot creation is collision-proof and prune-free ──

    /// Two snapshots inside the SAME second (and across seconds) must coexist
    /// — the old timestamp-only name silently overwrote, so a restore and its
    /// Undo in one second destroyed each other's safety copies.
    #[test]
    fn pre_restore_snapshots_never_collide_and_creation_never_prunes() {
        let (g, conn, data) = isolated_open();

        // Same second (same stamp): the pid/counter suffix must disambiguate.
        let a = write_pre_restore_snapshot_stamped(&conn, "20260710-101010").unwrap();
        let b = write_pre_restore_snapshot_stamped(&conn, "20260710-101010").unwrap();
        // A different second coexists too.
        let c = write_pre_restore_snapshot_stamped(&conn, "20260710-101011").unwrap();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert!(
            a.exists() && b.exists() && c.exists(),
            "creation never pruned a sibling"
        );

        // Pruning is explicit and keeps exactly the keepers.
        prune_pre_restore_snapshots_except(&[&c]).unwrap();
        assert!(!a.exists() && !b.exists());
        assert!(c.exists());

        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R4: deep queries run on the MIGRATED probe (pre-v004 backups) ──

    /// A backup taken BEFORE v004 (no `assignable` column) migrates cleanly on
    /// a probe — the preflight must accept it, and the restore must read.
    /// Querying the old-schema original refused every such backup.
    #[test]
    fn pre_v004_backup_preflights_restores_and_reads() {
        let (g, conn, data) = isolated_open();
        seed_titled_book(&conn, "bk_old", "Old Schema Book", "old schema book words");
        let candidate = data.join("candidate-old.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        // Devolve the CANDIDATE to the pre-v004 schema.
        {
            let old = Connection::open(&candidate).unwrap();
            old.execute_batch(
                "ALTER TABLE book_sections DROP COLUMN assignable;
                 DELETE FROM schema_migrations WHERE version = 'v004_book_sections_assignable';",
            )
            .unwrap();
        }

        let missing = restore_preflight(&candidate).expect("pre-v004 candidate preflights");
        assert!(
            missing.is_empty(),
            "coherent old backup passes: {missing:?}"
        );
        // The candidate ITSELF was not migrated (probe-only).
        {
            let old = Connection::open(&candidate).unwrap();
            let has: i64 = old
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('book_sections') WHERE name='assignable'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has, 0, "the original backup bytes stay old-schema");
        }

        // Restore + reopen (live migration) + read through production.
        drop(conn);
        restore_into_place(&candidate, &paths::db_path().unwrap()).unwrap();
        let conn = crate::db::open_and_migrate().expect("reopen migrates live");
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id='bk_old'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Old Schema Book");
        let body = crate::commands::books::read_txt_section("bk_old", 0, None).unwrap();
        assert!(body.contains("old schema book words"));
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R4: source-only EPUBs must PROVE the backfill, not just open ──

    /// Build a minimal but genuine 2-chapter EPUB on disk.
    fn write_test_epub(dir: &Path) -> PathBuf {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let path = dir.join("fixture.epub");
        let f = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        zip.start_file("content.opf", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:creator>Test Author</dc:creator><dc:identifier id="id">fixture-1</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#).unwrap();
        zip.start_file("c1.xhtml", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>The opening chapter has enough prose to be a real section for the derivation to chew on.</p></body></html>"#).unwrap();
        zip.start_file("c2.xhtml", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Chapter Two</h1><p>The closing chapter also carries genuine paragraph text so both sections derive nonempty.</p></body></html>"#).unwrap();
        zip.finish().unwrap();
        path
    }

    /// A source-only EPUB (derived text gone — the pre-pivot install shape)
    /// passes ONLY when the isolated production derivation reproduces the
    /// backup's recorded sectionization; tampered history is refused even
    /// though the EPUB itself opens fine.
    #[test]
    fn source_only_epub_is_proven_by_isolated_derivation_not_by_opening() {
        let (g, conn, data) = isolated_open();
        let epub = write_test_epub(&data);
        let result = crate::import_epub::import_epub_into("bk_epub", &epub).expect("epub import");
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at)
             VALUES ('bk_epub', 'Fixture Book', 'Test Author', 'epub', '/x', ?1, '2026-01-01')",
            [&result.book.source_sha256],
        )
        .unwrap();
        for s in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator,
                    s.estimated_units, s.sort_order, s.assignable as i64
                ],
            )
            .unwrap();
        }
        let candidate = data.join("candidate-epub.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();

        // Devolve the on-disk book to SOURCE-ONLY (pre-pivot install shape).
        let dir = paths::book_dir("bk_epub").unwrap();
        for derived in [
            "source.txt",
            "structure.json",
            "body_offsets.json",
            "reader.txt",
        ] {
            let p = dir.join(derived);
            if p.exists() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644));
                }
                std::fs::remove_file(&p).unwrap();
            }
        }
        assert!(dir.join("source.epub").is_file(), "source-only shape");

        // Coherent history → the isolated derivation proves the backfill.
        assert!(
            books_missing_files(&candidate).unwrap().is_empty(),
            "coherent source-only epub passes via isolated derivation"
        );

        // Tampered history (a moved end locator) → refused, even though the
        // EPUB opens fine — "it opens" is not the bar (R4).
        let tampered = data.join("candidate-epub-tampered.db");
        conn.execute(
            "UPDATE book_sections SET end_locator = CAST(CAST(end_locator AS INTEGER) + 7 AS TEXT)
             WHERE book_id='bk_epub' AND sort_order = 0",
            [],
        )
        .unwrap();
        conn.execute("VACUUM INTO ?1", [tampered.to_string_lossy().as_ref()])
            .unwrap();
        assert_eq!(
            books_missing_files(&tampered).unwrap(),
            vec!["Fixture Book".to_string()],
            "derivation mismatch must be refused"
        );

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R7-8: an EPUB derivation that fails to RUN (injected io failure —
    /// unreadable source.epub) is ENVIRONMENTAL: the candidate becomes
    /// Unassessable, automatic recovery fails closed, and a fresh start is
    /// never authorized. Only a format/corruption verdict stays definitive.
    #[cfg(unix)]
    #[test]
    fn epub_derivation_io_failure_is_environmental_and_never_authorizes_fresh_start() {
        use std::os::unix::fs::PermissionsExt;
        let (g, conn, data) = isolated_open();
        let epub = write_test_epub(&data);
        let result = crate::import_epub::import_epub_into("bk_env", &epub).expect("epub import");
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at)
             VALUES ('bk_env', 'Env Book', 'Test Author', 'epub', '/x', ?1, '2026-01-01')",
            [&result.book.source_sha256],
        )
        .unwrap();
        for s in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator,
                    s.estimated_units, s.sort_order, s.assignable as i64
                ],
            )
            .unwrap();
        }
        let backups = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&backups).unwrap();
        let candidate = backups.join("reading-20260101-000000.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();

        // Devolve to source-only, then make the source UNREADABLE: the
        // isolated derivation now fails with io, not a format verdict.
        let dir = paths::book_dir("bk_env").unwrap();
        for derived in [
            "source.txt",
            "structure.json",
            "body_offsets.json",
            "reader.txt",
        ] {
            let p = dir.join(derived);
            if p.exists() {
                std::fs::remove_file(&p).unwrap();
            }
        }
        let source = dir.join("source.epub");
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o000)).unwrap();
        let perms_enforced = std::fs::read(&source).is_err();
        if perms_enforced {
            assert_eq!(
                assess_backup(&candidate),
                BackupAssessment::Unassessable,
                "an io derivation failure must not read as a definitive verdict"
            );
            match try_restore_newest_backup().expect("attempt runs") {
                RestoreOutcome::NoneUsable { any_unassessable } => assert!(
                    any_unassessable,
                    "fail closed — a fresh start is NOT authorized"
                ),
                other => panic!("expected fail-closed NoneUsable, got {other:?}"),
            }
        } else {
            eprintln!("skipping: permissions not enforced (root?)");
        }
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).unwrap();

        // With the io failure gone, the same candidate assesses cleanly —
        // the refusal above was the ENVIRONMENT, not the backup.
        assert_eq!(assess_backup(&candidate), BackupAssessment::Coherent);

        // A garbage source is still refused fail-closed (it reaches the
        // conservative production-read gate before any derivation runs).
        std::fs::write(&source, b"definitely not a zip archive").unwrap();
        assert!(
            matches!(
                assess_backup(&candidate),
                BackupAssessment::Unassessable | BackupAssessment::Invalid
            ),
            "garbage bytes never assess Coherent"
        );

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R7-8: the derivation-failure CLASSIFIER itself — io anywhere in the
    /// chain is environmental, a typed epub format verdict is definitive,
    /// and an untypeable failure is conservatively environmental.
    #[test]
    fn epub_derivation_failure_classifier_is_typed() {
        let io = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ))
        .context("open EPUB for isolated derivation");
        assert!(matches!(
            classify_epub_derivation_failure(&io),
            BookIssue::Environmental(_)
        ));

        let doc = anyhow::Error::new(epub::doc::DocError::InvalidEpub)
            .context("open EPUB for isolated derivation");
        assert!(matches!(
            classify_epub_derivation_failure(&doc),
            BookIssue::Definitive(_)
        ));

        // DocError WRAPPING an io error: the io wins (environmental).
        let doc_io = anyhow::Error::new(epub::doc::DocError::IOError(std::io::Error::other(
            "disk hiccup",
        )));
        assert!(matches!(
            classify_epub_derivation_failure(&doc_io),
            BookIssue::Environmental(_)
        ));

        let untyped = anyhow::anyhow!("sectionizer produced nothing");
        assert!(matches!(
            classify_epub_derivation_failure(&untyped),
            BookIssue::Environmental(_)
        ));
    }

    /// R4: a matching source SHA alone is NOT a complete staging — an
    /// interrupted attempt (source present, derived artifacts gone) must be
    /// REBUILT, not returned early as "already staged".
    #[test]
    fn same_sha_partial_staging_is_rebuilt_not_short_circuited() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/modest_proposal.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        for s in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator,
                    s.estimated_units, s.sort_order, s.assignable as i64
                ],
            )
            .unwrap();
        }
        write_rolling_backup(&conn).expect("backup");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();

        // Simulate an INTERRUPTED staging: source.txt survives (same SHA),
        // but the derived reader text is TRUNCATED — the exact damage the old
        // same-SHA early return declared "already staged".
        let dir = paths::book_dir(&book_id).unwrap();
        let reader = dir.join("reader.txt");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&reader, std::fs::Permissions::from_mode(0o644));
        }
        let full = std::fs::read_to_string(&reader).unwrap();
        std::fs::write(&reader, &full[..full.len() / 4]).unwrap();
        assert!(
            !restore_preflight(&backup_file).unwrap().is_empty(),
            "the truncated staging is incoherent before the rebuild"
        );

        let staged = stage_book_for_restore(&backup_file, fixture)
            .expect("partial staging is rebuilt, not refused");
        assert_eq!(staged.id, book_id);
        assert_eq!(
            std::fs::read_to_string(dir.join("reader.txt")).unwrap(),
            full,
            "the rebuild regenerated the full derived text"
        );
        assert!(
            restore_preflight(&backup_file).unwrap().is_empty(),
            "the rebuilt staging is fully coherent"
        );

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R5: TYPED backup assessment — environmental failures fail CLOSED ──

    /// A definitively-corrupt backup (garbage bytes) is Invalid — fresh start
    /// stays authorized. An UNREADABLE backup (permissions) is Unassessable —
    /// automatic recovery must fail closed instead of wiping to fresh.
    #[cfg(unix)]
    #[test]
    fn unassessable_candidates_fail_closed_while_invalid_ones_do_not() {
        use std::os::unix::fs::PermissionsExt;
        let (g, conn, data) = isolated_open();
        let dir = paths::backups_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();

        // Only a definitively-invalid candidate → NoneUsable, fresh authorized.
        let garbage = dir.join("reading-20260101-000000.db");
        std::fs::write(&garbage, b"definitely not a sqlite database").unwrap();
        assert_eq!(assess_backup(&garbage), BackupAssessment::Invalid);
        match try_restore_newest_backup().expect("attempt runs") {
            RestoreOutcome::NoneUsable { any_unassessable } => {
                assert!(
                    !any_unassessable,
                    "a definitive verdict does not fail closed"
                )
            }
            other => panic!("expected NoneUsable, got {other:?}"),
        }

        // An UNREADABLE candidate (the probe copy cannot run) → Unassessable,
        // and the attempt reports any_unassessable so the caller fails closed.
        let unreadable = dir.join("reading-20260102-000000.db");
        std::fs::write(&unreadable, b"whatever").unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let perms_enforced = std::fs::read(&unreadable).is_err();
        if perms_enforced {
            assert_eq!(assess_backup(&unreadable), BackupAssessment::Unassessable);
            match try_restore_newest_backup().expect("attempt runs") {
                RestoreOutcome::NoneUsable { any_unassessable } => {
                    assert!(
                        any_unassessable,
                        "an environmental failure must fail closed"
                    )
                }
                other => panic!("expected NoneUsable, got {other:?}"),
            }
        } else {
            eprintln!("skipping unassessable assertions: permissions not enforced (root?)");
        }
        let _ = std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o644));

        // With a COHERENT candidate present, restore proceeds (order-literal:
        // fail-closed applies only when no good candidate exists).
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        write_rolling_backup(&conn).expect("coherent backup");
        drop(conn);
        let outcome = try_restore_newest_backup().expect("attempt runs");
        let _ = std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o644));
        if perms_enforced {
            assert!(
                outcome.restored().is_some(),
                "a coherent candidate restores even past unassessable ones: {outcome:?}"
            );
        }
        cleanup(&data);
        drop(g);
    }

    // ── R6-2: classification is CODE-TYPED, never "any error = bad backup" ──

    /// The integrity/query error classifiers key on SQLite result codes:
    /// only corruption-class codes are definitive; io/busy/permission/
    /// resource codes are environmental and must fail closed upstream.
    #[test]
    fn error_classifiers_split_corruption_from_environment_by_code() {
        use rusqlite::ffi;
        let mk =
            |code: std::os::raw::c_int| rusqlite::Error::SqliteFailure(ffi::Error::new(code), None);
        assert!(integrity_error_is_definitive(&mk(ffi::SQLITE_CORRUPT)));
        assert!(integrity_error_is_definitive(&mk(ffi::SQLITE_NOTADB)));
        for code in [
            ffi::SQLITE_IOERR,
            ffi::SQLITE_BUSY,
            ffi::SQLITE_LOCKED,
            ffi::SQLITE_PERM,
            ffi::SQLITE_CANTOPEN,
            ffi::SQLITE_NOMEM,
            ffi::SQLITE_FULL,
        ] {
            assert!(
                !integrity_error_is_definitive(&mk(code)),
                "code {code} is environmental, not a verdict about the bytes"
            );
        }

        // Query failures: a row that cannot DECODE is definitive…
        let decode = anyhow::Error::new(rusqlite::Error::InvalidColumnType(
            0,
            "title".to_string(),
            rusqlite::types::Type::Null,
        ))
        .context("decode a books row in the backup");
        assert!(query_failure_is_definitive(&decode));
        let corrupt = anyhow::Error::new(mk(ffi::SQLITE_CORRUPT));
        assert!(query_failure_is_definitive(&corrupt));
        // …while the query failing to RUN is not.
        let io = anyhow::Error::new(mk(ffi::SQLITE_IOERR)).context("open backup for check");
        assert!(!query_failure_is_definitive(&io));
        let busy = anyhow::Error::new(mk(ffi::SQLITE_BUSY));
        assert!(!query_failure_is_definitive(&busy));
        let plain_io = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));
        assert!(!query_failure_is_definitive(&plain_io));
    }

    /// R6-2 injections at the per-book classification seams: an environmental
    /// failure (unreadable source, unreadable structure.json) makes the
    /// candidate UNASSESSABLE — automatic recovery fails closed, the candidate
    /// bytes stay untouched, and no fresh-start marker appears. A definitive
    /// on-disk contradiction (source path is a directory) stays Invalid.
    #[cfg(unix)]
    #[test]
    fn environmental_book_failures_are_unassessable_and_change_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let (g, conn, data) = isolated_open();
        let body = "Great art Thou, O Lord, and greatly to be praised.";
        seed_book_with_sections(&conn, "b1", body, &[("A", 0)]);
        let candidate = write_rolling_backup(&conn).expect("backup");
        assert_eq!(assess_backup(&candidate), BackupAssessment::Coherent);
        let candidate_bytes = std::fs::read(&candidate).unwrap();
        let book_dir = paths::book_dir("b1").unwrap();
        let source = book_dir.join("source.txt");

        // Seam 1: the source HASH read fails (permissions) — the file may be
        // fine; nothing definitive is known. Unassessable, not Invalid.
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o000)).unwrap();
        let perms_enforced = std::fs::read(&source).is_err();
        if perms_enforced {
            assert_eq!(assess_backup(&candidate), BackupAssessment::Unassessable);
            match try_restore_newest_backup().expect("attempt runs") {
                RestoreOutcome::NoneUsable { any_unassessable } => assert!(any_unassessable),
                other => panic!("expected fail-closed NoneUsable, got {other:?}"),
            }
            // Nothing was cleared, replaced, or marked: the candidate is
            // byte-identical and no fresh-start marker exists anywhere.
            assert_eq!(std::fs::read(&candidate).unwrap(), candidate_bytes);
            let live = paths::db_path().unwrap();
            assert!(
                !fresh_start_marker_path(&live).exists(),
                "an unassessable walk must never arm a fresh start"
            );
        } else {
            eprintln!("skipping seam 1: permissions not enforced (root?)");
        }
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).unwrap();

        // Seam 2: structure.json exists but its STATE can't be read. Before
        // R6-2 this fell through `is_file() == false` and silently SKIPPED
        // the typography check — an environmental error passing as Coherent.
        let structure = book_dir.join("structure.json");
        std::fs::write(&structure, r#"{"sec_b1_0": {}}"#).unwrap();
        assert_eq!(assess_backup(&candidate), BackupAssessment::Coherent);
        std::fs::set_permissions(&structure, std::fs::Permissions::from_mode(0o000)).unwrap();
        if perms_enforced {
            assert_eq!(
                assess_backup(&candidate),
                BackupAssessment::Unassessable,
                "an unreadable structure.json must not be skipped as absent"
            );
        }
        std::fs::set_permissions(&structure, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::remove_file(&structure).unwrap();

        // Seam 3: the source path exists but is a DIRECTORY — an affirmative
        // on-disk contradiction of the row. Definitive → Invalid.
        std::fs::remove_file(&source).unwrap();
        std::fs::create_dir(&source).unwrap();
        assert_eq!(assess_backup(&candidate), BackupAssessment::Invalid);
        std::fs::remove_dir(&source).unwrap();

        // Seam 4: affirmative NotFound stays definitive (missing file).
        assert_eq!(assess_backup(&candidate), BackupAssessment::Invalid);

        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R8-1: sidecar-safe, durable promotion ──

    /// Build a real MIGRATED app db at `path` with one `kv` marker row (the
    /// promotion's prepare step runs the app migrations on the candidate).
    fn plant_db(path: &Path, marker: &str) {
        let conn = Connection::open(path).unwrap();
        // Mirrors db.rs: WAL is set OUTSIDE the migration transaction, so
        // v001's own journal_mode statement is a no-op.
        conn.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS kv (v TEXT)")
            .unwrap();
        conn.execute("INSERT INTO kv (v) VALUES (?1)", [marker])
            .unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(conn);
        let s = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(format!("{s}-wal"));
        let _ = std::fs::remove_file(format!("{s}-shm"));
    }

    /// Leave a REAL, replayable WAL beside `path` containing `marker`, with
    /// the main file NOT containing it (frames un-checkpointed).
    fn plant_stale_wal(path: &Path, marker: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS kv (v TEXT)",
        )
        .unwrap();
        conn.execute("INSERT INTO kv (v) VALUES (?1)", [marker])
            .unwrap();
        // Save the live WAL bytes, then let close checkpoint+remove it —
        // and put the saved WAL back: a stale sidecar with real frames.
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        let saved = std::fs::read(&wal).expect("wal exists while open");
        drop(conn);
        std::fs::write(&wal, saved).unwrap();
    }

    fn kv_values(path: &Path) -> Vec<String> {
        let conn = Connection::open(path).unwrap();
        let has_kv: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='kv'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if has_kv == 0 {
            return Vec::new();
        }
        let mut stmt = conn.prepare("SELECT v FROM kv ORDER BY v").unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    /// R8-1: a STALE TEMP WAL planted at the exact temp path (with real,
    /// replayable frames carrying a recognizable value) can NOT alter the
    /// next candidate — the guard proves the sidecars absent before SQLite
    /// ever opens the path.
    #[test]
    fn stale_temp_wal_cannot_alter_the_promoted_candidate() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        let candidate = data.join("candidate.db");
        plant_db(&candidate, "CANDIDATE");

        // The attack: a fixed temp path already carries a WAL whose frames
        // insert 'WAL-INJECTED'. Without the guard, copy(candidate→tmp) then
        // Connection::open(tmp) REPLAYS those frames into the candidate.
        let tmp = data.join("fixed-promotion-tmp.db");
        plant_stale_wal(&tmp, "WAL-INJECTED");
        assert!(
            std::fs::metadata(format!("{}-wal", tmp.to_string_lossy())).is_ok(),
            "precondition: the stale WAL is really there"
        );

        restore_into_place_prepared_at(
            &candidate,
            &live,
            &tmp,
            Some(&mut |c| settings::rotate_library_generation(c)),
            &mut RealPreserveFs,
        )
        .expect("promotion succeeds despite the planted sidecar");

        let values = kv_values(&live);
        assert!(
            values.contains(&"CANDIDATE".to_string()),
            "the candidate's own content survived: {values:?}"
        );
        assert!(
            !values.contains(&"WAL-INJECTED".to_string()),
            "the planted WAL must not reach the promoted database: {values:?}"
        );
        cleanup(&data);
        drop(g);
    }

    /// R8-1: the LIVE database's un-checkpointed WAL is cleared BEFORE the
    /// rename — a crash after promotion can never leave the replaced
    /// database's WAL beside the candidate for SQLite to replay.
    #[test]
    fn replaced_databases_wal_never_replays_into_the_promoted_candidate() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        // The OLD live db carries un-checkpointed WAL frames ('LIVE-WAL').
        let _ = std::fs::remove_file(&live);
        plant_stale_wal(&live, "LIVE-WAL");
        let candidate = data.join("candidate.db");
        plant_db(&candidate, "CANDIDATE");

        restore_into_place_prepared(
            &candidate,
            &live,
            Some(&mut |c| settings::rotate_library_generation(c)),
        )
        .expect("promotion");

        // No sidecar survived the promotion, and no old frame reached the
        // candidate.
        for side in db_sidecars(&live) {
            assert!(!side.exists(), "{side:?} must be gone after promotion");
        }
        let values = kv_values(&live);
        assert!(values.contains(&"CANDIDATE".to_string()));
        assert!(
            !values.contains(&"LIVE-WAL".to_string()),
            "the replaced database's WAL must never replay: {values:?}"
        );
        cleanup(&data);
        drop(g);
    }

    /// R8-1/R9-1: failure injected at EVERY injectable file operation of the
    /// promotion, with LIVE SIDECARS PLANTED so the three outcome classes are
    /// observable. `Untouched` leaves the live MAIN byte-identical AND both
    /// planted sidecars byte-identical; `AuxMutated` leaves the live MAIN
    /// byte-identical (sidecars possibly cleared); the post-rename fsync
    /// failure is typed `After` with the candidate coherently live.
    #[test]
    fn promotion_failures_are_typed_untouched_aux_mutated_or_after() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        let candidate = data.join("candidate.db");
        plant_db(&candidate, "CANDIDATE");

        // ops order in restore_into_place_prepared_at: copy, tmp sidecar
        // removes, tmp sidecar removes again, fsync tmp, live sidecar
        // removes, pre-rename dir fsync (R9-1), rename, post-rename dir
        // fsync. FailAtOp counts every call — enumerate generously and
        // assert on the TYPED outcome instead of indices.
        let mut saw_untouched = false;
        let mut saw_aux = false;
        let mut saw_after = false;
        for fail_at in 0..14 {
            let _ = std::fs::remove_file(&live);
            plant_db(&live, "OLD");
            let original = std::fs::read(&live).unwrap();
            // Planted live sidecars: observable evidence for the
            // Untouched-vs-AuxMutated distinction (step 4 removes them).
            let [wal, shm] = db_sidecars(&live);
            std::fs::write(&wal, b"planted live wal").unwrap();
            std::fs::write(&shm, b"planted live shm").unwrap();
            let tmp = data.join(format!("boundary-tmp-{fail_at}.db"));
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at,
                count: 0,
            };
            let outcome = restore_into_place_prepared_at(
                &candidate,
                &live,
                &tmp,
                Some(&mut |c| settings::rotate_library_generation(c)),
                &mut ops,
            );
            match outcome {
                Ok(()) => {
                    // fail_at beyond the op count — the promotion completed.
                    assert!(kv_values(&live).contains(&"CANDIDATE".to_string()));
                }
                Err(PromotionError::Untouched(_)) => {
                    saw_untouched = true;
                    assert_eq!(
                        std::fs::read(&live).unwrap(),
                        original,
                        "op {fail_at}: Untouched leaves the live MAIN byte-identical"
                    );
                    assert_eq!(
                        std::fs::read(&wal).ok().as_deref(),
                        Some(b"planted live wal".as_slice()),
                        "op {fail_at}: Untouched means the live WAL was NOT touched"
                    );
                    assert_eq!(
                        std::fs::read(&shm).ok().as_deref(),
                        Some(b"planted live shm".as_slice()),
                        "op {fail_at}: Untouched means the live SHM was NOT touched"
                    );
                }
                Err(PromotionError::AuxMutated(_)) => {
                    saw_aux = true;
                    assert_eq!(
                        std::fs::read(&live).unwrap(),
                        original,
                        "op {fail_at}: AuxMutated still leaves the live MAIN byte-identical"
                    );
                }
                Err(PromotionError::After(_)) => {
                    saw_after = true;
                    assert!(
                        kv_values(&live).contains(&"CANDIDATE".to_string()),
                        "op {fail_at}: After ⇒ the candidate is coherently live"
                    );
                }
            }
            // The planted sidecars must never survive into a PROMOTED state.
            if matches!(outcome, Ok(()) | Err(PromotionError::After(_))) {
                assert!(!wal.exists() && !shm.exists());
            }
            let _ = std::fs::remove_file(&wal);
            let _ = std::fs::remove_file(&shm);
        }
        assert!(
            saw_untouched && saw_aux && saw_after,
            "all three outcome classes must be exercised \
             (untouched: {saw_untouched}, aux: {saw_aux}, after: {saw_after})"
        );
        cleanup(&data);
        drop(g);
    }

    /// R9-1 crash boundary: the process dies after the pre-rename directory
    /// fsync (sidecar unlinks durable) but BEFORE the rename. The old library
    /// must still open with its own content, and a relaunch-time retry of the
    /// same promotion completes.
    #[test]
    fn crash_after_sidecar_clearing_fsync_but_before_rename_leaves_the_old_library_openable() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        let candidate = data.join("candidate.db");
        plant_db(&candidate, "CANDIDATE");
        let _ = std::fs::remove_file(&live);
        plant_db(&live, "OLD");

        promotion_test_seam::arm(promotion_test_seam::FailPoint::Rename);
        let outcome = restore_into_place_prepared(
            &candidate,
            &live,
            Some(&mut |c| settings::rotate_library_generation(c)),
        );
        promotion_test_seam::disarm();
        assert!(
            matches!(outcome, Err(PromotionError::AuxMutated(_))),
            "dying at the rename is a sidecar-mutating (never 'unchanged') outcome: {outcome:?}"
        );
        // The crash-state library opens and is the OLD one.
        let values = kv_values(&live);
        assert!(
            values.contains(&"OLD".to_string()),
            "the old library is intact at the live path: {values:?}"
        );
        // The relaunch retry (same promotion, seam disarmed) completes.
        restore_into_place_prepared(
            &candidate,
            &live,
            Some(&mut |c| settings::rotate_library_generation(c)),
        )
        .expect("the retry after the simulated crash succeeds");
        assert!(kv_values(&live).contains(&"CANDIDATE".to_string()));
        cleanup(&data);
        drop(g);
    }

    /// R9-1 crash boundary: the process dies after the rename but before the
    /// final directory fsync. The outcome is typed `After` — the candidate is
    /// coherently live and MUST NOT be reported as "nothing was changed".
    #[test]
    fn crash_after_rename_but_before_final_fsync_is_typed_after_with_the_candidate_live() {
        let (g, conn, data) = isolated_open();
        drop(conn);
        let live = paths::db_path().unwrap();
        let candidate = data.join("candidate.db");
        plant_db(&candidate, "CANDIDATE");
        let _ = std::fs::remove_file(&live);
        plant_db(&live, "OLD");

        promotion_test_seam::arm(promotion_test_seam::FailPoint::PostRenameDirFsync);
        let outcome = restore_into_place_prepared(
            &candidate,
            &live,
            Some(&mut |c| settings::rotate_library_generation(c)),
        );
        promotion_test_seam::disarm();
        assert!(
            matches!(outcome, Err(PromotionError::After(_))),
            "a post-rename failure must be typed After: {outcome:?}"
        );
        let values = kv_values(&live);
        assert!(
            values.contains(&"CANDIDATE".to_string()),
            "After ⇒ the candidate is coherently live: {values:?}"
        );
        for side in db_sidecars(&live) {
            assert!(!side.exists(), "no sidecar beside the promoted candidate");
        }
        cleanup(&data);
        drop(g);
    }

    /// R9-1: the AUTOMATIC restore preserves the promotion classification —
    /// an `After` failure surfaces as `RestoreError::Promotion(After)` with
    /// the restored candidate already at the live path, so the launch path
    /// can hard-stop TRUTHFULLY instead of claiming "nothing was changed".
    #[test]
    fn automatic_restore_preserves_the_applied_but_unproven_classification() {
        let (g, conn, data) = isolated_open();
        settings::set_string(&conn, "library_marker", "GOOD BACKUP").unwrap();
        write_rolling_backup(&conn).expect("backup");
        drop(conn);
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"CORRUPT LIVE BYTES").unwrap();

        promotion_test_seam::arm(promotion_test_seam::FailPoint::PostRenameDirFsync);
        let err = try_restore_newest_backup()
            .expect_err("the unproven promotion must surface as an error");
        promotion_test_seam::disarm();
        match &err {
            RestoreError::Promotion(PromotionError::After(_)) => {}
            other => panic!("classification lost through automatic recovery: {other:?}"),
        }
        // TRUTH of the type: the restored library IS at the live path.
        let conn = Connection::open(&live).expect("the restored library opens");
        assert_eq!(
            settings::get_string(&conn, "library_marker").as_deref(),
            Some("GOOD BACKUP")
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R7-1: generation-safe promotion in AUTOMATIC recovery ──

    /// The rotation happens on the PREPARED candidate copy BEFORE promotion:
    /// a rotation failure aborts with the live path byte-untouched (no
    /// replaced library ever runs under the previous token), and a successful
    /// automatic restore arrives already carrying a fresh token.
    #[test]
    fn automatic_restore_rotates_before_promotion_or_touches_nothing() {
        let (g, conn, data) = isolated_open();
        settings::set_string(&conn, "library_marker", "GOOD BACKUP").unwrap();
        let backup_gen = settings::rotate_library_generation(&conn).unwrap();
        write_rolling_backup(&conn).expect("backup");
        drop(conn);

        // A corrupt live file (as open_db_resilient would see it, post-
        // preservation).
        let live = paths::db_path().unwrap();
        std::fs::write(&live, b"CORRUPT LIVE BYTES").unwrap();
        let corrupt_bytes = std::fs::read(&live).unwrap();

        // Injection: the rotation fails during PREPARATION → the attempt
        // errors and the live path is byte-untouched (the caller panics —
        // no session runs).
        let err = try_restore_newest_backup_with(&mut |_c| anyhow::bail!("injected"))
            .expect_err("a failed pre-promotion rotation must abort the restore");
        assert!(
            format!("{err:#}").contains("before promotion"),
            "the abort names the pre-promotion rotation: {err:#}"
        );
        assert_eq!(
            std::fs::read(&live).unwrap(),
            corrupt_bytes,
            "nothing replaced the live path on a failed preparation"
        );
        assert!(
            !fresh_start_marker_present(&live).unwrap(),
            "no fresh start was armed either"
        );

        // The real rotation: the promoted library ALREADY carries a fresh
        // token the moment it exists at the live path.
        let outcome = try_restore_newest_backup().expect("restore");
        assert!(outcome.restored().is_some());
        let conn = Connection::open(&live).unwrap();
        let live_gen = settings::get_library_generation(&conn);
        assert_ne!(
            live_gen, backup_gen,
            "the restored library's token differs from the backup's — no draft typed against \
             the replaced library can mount on it"
        );
        assert!(!live_gen.is_empty());
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    // ── R5: the CRASH-SAFE fresh-start transition ──

    /// Inject failure after EVERY clear/replacement/fsync boundary of the
    /// fresh-start transition, then "relaunch". At every boundary the durable
    /// marker or the live DB exists (an interrupted run is NEVER mistaken for
    /// an ordinary missing DB), and the resume completes the transition —
    /// without re-clearing an already-healthy fresh DB.
    #[test]
    fn fresh_start_transition_survives_failure_at_every_boundary_and_resumes() {
        let root = std::env::temp_dir().join(format!(
            "tl-freshstart-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let live = root.join("reading.db");
        let marker = fresh_start_marker_path(&live);
        let setup = || {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(&live, b"CORRUPT").unwrap();
            std::fs::write(root.join("reading.db-wal"), b"CORRUPT WAL").unwrap();
        };
        // The full transition; `fail_create` injects a crash at the
        // fresh-DB-creation boundary itself.
        let run = |ops: &mut dyn PreserveFs, fail_create: bool| -> Result<()> {
            begin_fresh_start_with(&live, ops)?;
            clear_live_db_after_preservation_with(&live, ops)?;
            if fail_create {
                anyhow::bail!("injected crash at fresh-DB creation");
            }
            std::fs::write(&live, b"FRESH").unwrap();
            finish_fresh_start_with(&live, ops)?;
            Ok(())
        };
        // The relaunch logic (mirrors open_db_resilient's resume): a healthy
        // live DB only lifts the marker; otherwise clear + create + lift.
        // Resume-created DBs write DIFFERENT bytes so the no-re-clear property
        // is observable.
        let resume = || {
            if !marker.exists() {
                return;
            }
            let healthy = std::fs::read(&live)
                .map(|b| b == b"FRESH" || b == b"FRESH2")
                .unwrap_or(false);
            if !healthy {
                clear_live_db_after_preservation(&live).unwrap();
                std::fs::write(&live, b"FRESH2").unwrap();
            }
            finish_fresh_start(&live).unwrap();
        };

        // Count the ops of a clean run.
        setup();
        let mut counter = FailAtOp {
            real: RealPreserveFs,
            fail_at: usize::MAX,
            count: 0,
        };
        run(&mut counter, false).expect("clean transition");
        let total = counter.count;
        assert!(
            total >= 7,
            "marker write+fsyncs, removes, dir fsyncs: got {total}"
        );
        assert_eq!(std::fs::read(&live).unwrap(), b"FRESH");
        assert!(!marker.exists());

        // Failure at every ops boundary, plus the create boundary.
        for fail_at in 0..=total {
            setup();
            let fail_create = fail_at == total;
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: if fail_create { usize::MAX } else { fail_at },
                count: 0,
            };
            run(&mut ops, fail_create).expect_err("injected boundary failure");

            // THE invariant: never marker-absent AND db-absent — that state
            // is indistinguishable from a first run and would silently mint
            // an empty library.
            assert!(
                marker.exists() || live.exists(),
                "boundary {fail_at}: interrupted transition looks like an ordinary missing DB"
            );

            // Relaunch: the transition resumes (or, if the failure preceded
            // the marker, the original corrupt DB is fully intact for normal
            // recovery — rerun the transition as recovery would).
            if !marker.exists() {
                // Marker absent is legitimate at exactly two boundaries: a
                // failure BEFORE the marker was written (live still the
                // original — normal corruption recovery reruns the
                // transition), or a failure AFTER the marker was removed
                // (the transition is complete; only a trailing fsync failed).
                let content = std::fs::read(&live).unwrap();
                if content == b"CORRUPT" {
                    run(&mut RealPreserveFs, false).expect("recovery reruns the transition");
                } else {
                    assert_eq!(
                        content, b"FRESH",
                        "boundary {fail_at}: marker-absent must mean untouched or complete"
                    );
                }
            } else {
                resume();
            }
            assert!(!marker.exists(), "boundary {fail_at}: marker lifted");
            let content = std::fs::read(&live).unwrap();
            assert!(
                content == b"FRESH" || content == b"FRESH2",
                "boundary {fail_at}: transition completed to a fresh DB"
            );
            if fail_create {
                // The create-boundary failure resumes via the marker path and
                // must NOT have found a healthy DB to keep.
                assert_eq!(content, b"FRESH2");
            }
        }

        // No-re-clear property: a crash between create and finish leaves a
        // HEALTHY fresh DB + marker; the resume must keep it (content stays
        // "FRESH", never re-created as "FRESH2").
        setup();
        // Fail the marker-REMOVAL op itself (total-2; total-1 is the trailing
        // dir fsync after removal): the crash window between fresh-create and
        // marker-lift.
        let mut ops = FailAtOp {
            real: RealPreserveFs,
            fail_at: total - 2,
            count: 0,
        };
        run(&mut ops, false).expect_err("finish boundary fails");
        assert!(marker.exists());
        assert_eq!(std::fs::read(&live).unwrap(), b"FRESH");
        resume();
        assert_eq!(
            std::fs::read(&live).unwrap(),
            b"FRESH",
            "a healthy fresh DB is kept — resume only lifts the marker"
        );
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── R5: snapshots are CREATION-ordered; cleanup failures propagate ──

    /// "Newest" is the creation order, not the lexical order of stamps/pids:
    /// a snapshot created LATER with a lexically-smaller stamp still wins.
    #[test]
    fn newest_snapshot_is_creation_ordered_not_lexical() {
        let (g, conn, data) = isolated_open();
        let a = write_pre_restore_snapshot_stamped(&conn, "20260710-101011").unwrap();
        let b = write_pre_restore_snapshot_stamped(&conn, "20260710-101010").unwrap();
        assert_ne!(a, b);
        assert_eq!(
            newest_pre_restore_snapshot().unwrap().as_deref(),
            Some(b.as_path()),
            "the later-created snapshot wins despite its lexically-smaller stamp"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// A swap that succeeds while cleanup fails leaves MULTIPLE snapshots on
    /// disk: the prune failure PROPAGATES, and newest selection still returns
    /// the creation-newest one.
    #[cfg(unix)]
    #[test]
    fn multiple_leftovers_after_swap_before_cleanup_failure() {
        use std::os::unix::fs::PermissionsExt;
        let (g, conn, data) = isolated_open();
        let s1 = write_pre_restore_snapshot_stamped(&conn, "20260710-101010").unwrap();
        let s2 = write_pre_restore_snapshot_stamped(&conn, "20260710-101010").unwrap();
        let s3 = write_pre_restore_snapshot_stamped(&conn, "20260709-090909").unwrap();
        assert!(s1.exists() && s2.exists() && s3.exists());

        // Cleanup fails (read-only dir): the failure PROPAGATES.
        let dir = paths::backups_dir().unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let perms_enforced = std::fs::write(dir.join(".probe"), b"x").is_err();
        let prune = prune_pre_restore_snapshots_except(&[&s3]);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        if perms_enforced {
            prune.expect_err("cleanup failures must propagate, never vanish");
            assert!(s1.exists() && s2.exists(), "the leftovers are real");
        } else {
            eprintln!("skipping prune-failure assertion: permissions not enforced (root?)");
        }
        // With MULTIPLE leftovers, newest is still the CREATION-newest (s3,
        // despite its lexically-smallest stamp).
        assert_eq!(
            newest_pre_restore_snapshot().unwrap().as_deref(),
            Some(s3.as_path())
        );
        // And once cleanup CAN run, it removes exactly the non-keepers.
        prune_pre_restore_snapshots_except(&[&s3]).expect("cleanup succeeds now");
        assert!(!s1.exists() && !s2.exists() && s3.exists());
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R5: the picked file may BE the managed source itself — the rebuild
    /// derives from it in a sibling temp dir before anything moves, so the
    /// source is never deleted out from under its own re-import.
    #[test]
    fn rebuild_accepts_the_managed_source_path_itself_as_src() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/modest_proposal.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        for sec in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    sec.id, sec.book_id, sec.label, sec.href, sec.start_locator, sec.end_locator,
                    sec.estimated_units, sec.sort_order, sec.assignable as i64
                ],
            )
            .unwrap();
        }
        write_rolling_backup(&conn).expect("backup");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();

        // Truncate the derived text (incoherent staging), then hand the
        // MANAGED source path itself as src.
        let dir = paths::book_dir(&book_id).unwrap();
        let reader = dir.join("reader.txt");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&reader, std::fs::Permissions::from_mode(0o644));
        }
        let full = std::fs::read_to_string(&reader).unwrap();
        std::fs::write(&reader, &full[..full.len() / 4]).unwrap();
        let managed_source = dir.join("source.txt");
        assert!(managed_source.is_file());

        let staged = stage_book_for_restore(&backup_file, &managed_source)
            .expect("rebuild from the managed source itself");
        assert_eq!(staged.id, book_id);
        assert!(
            managed_source.is_file(),
            "the managed source survived its own rebuild"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("reader.txt")).unwrap(),
            full
        );
        assert!(restore_preflight(&backup_file).unwrap().is_empty());

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R7-3(a): the picked file is the MANAGED source, currently parked in a
    /// recorded transaction's aside while the book dir is absent (death
    /// between the renames). The resume runs BEFORE hashing, restores the
    /// recorded staging, and the stage then proceeds normally — the old order
    /// (hash first) failed on the missing path before any recovery could run.
    #[test]
    fn managed_source_parked_in_a_recorded_aside_is_recovered_before_hashing() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/modest_proposal.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        for sec in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    sec.id, sec.book_id, sec.label, sec.href, sec.start_locator, sec.end_locator,
                    sec.estimated_units, sec.sort_order, sec.assignable as i64
                ],
            )
            .unwrap();
        }
        write_rolling_backup(&conn).expect("backup");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();

        // Simulate the mid-swap death: the whole staging (managed source
        // included) sits in the RECORDED aside; the book dir is gone.
        let dir = paths::book_dir(&book_id).unwrap();
        let parent = dir.parent().unwrap().to_path_buf();
        let aside = parent.join(format!(".pre-rebuild-{book_id}-parked"));
        std::fs::rename(&dir, &aside).unwrap();
        let txn = StagingTxn {
            book_id: book_id.clone(),
            tmp: parent.join(format!(".rebuild-{book_id}-lost")),
            aside: aside.clone(),
            source_file: "source.txt".to_string(),
            derived_file: "reader.txt".to_string(),
            phase: "swapping".to_string(),
            had_previous: true,
        };
        std::fs::write(
            staging_txn_path(&parent, &book_id),
            serde_json::to_vec_pretty(&txn).unwrap(),
        )
        .unwrap();
        let managed_source = dir.join("source.txt");
        assert!(
            !managed_source.exists(),
            "precondition: the picked path is inside the ABSENT dir"
        );

        let staged = stage_book_for_restore(&backup_file, &managed_source)
            .expect("resume-before-hash recovers the parked staging, then stages");
        assert_eq!(staged.id, book_id);
        assert!(
            managed_source.is_file(),
            "the managed source is back in place"
        );
        assert!(restore_preflight(&backup_file).unwrap().is_empty());
        assert!(
            !staging_txn_path(&parent, &book_id).exists(),
            "the transaction record was consumed by the resume"
        );

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R5: a rebuild whose validation FAILS (remap mismatch) must leave the
    /// previous staging byte-for-byte untouched — never destroy-then-fail.
    #[test]
    fn failed_rebuild_never_destroys_the_previous_staging() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/modest_proposal.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        for sec in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    sec.id, sec.book_id, sec.label, sec.href, sec.start_locator, sec.end_locator,
                    sec.estimated_units, sec.sort_order, sec.assignable as i64
                ],
            )
            .unwrap();
        }
        // TAMPER the recorded history so the remap validation must refuse.
        conn.execute(
            "UPDATE book_sections SET end_locator = '17' WHERE book_id = ?1 AND sort_order = 0",
            [&book_id],
        )
        .unwrap();
        write_rolling_backup(&conn).expect("backup");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();

        // Break the staging so a rebuild is attempted, and capture the FULL
        // pre-call state of the directory.
        let dir = paths::book_dir(&book_id).unwrap();
        let reader = dir.join("reader.txt");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&reader, std::fs::Permissions::from_mode(0o644));
        }
        let full = std::fs::read_to_string(&reader).unwrap();
        std::fs::write(&reader, &full[..full.len() / 4]).unwrap();
        let before: std::collections::BTreeMap<String, Vec<u8>> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| {
                (
                    e.file_name().to_string_lossy().to_string(),
                    std::fs::read(e.path()).unwrap(),
                )
            })
            .collect();

        let err = stage_book_for_restore(&backup_file, fixture)
            .expect_err("the tampered history must refuse the rebuild");
        assert!(
            format!("{err:#}").contains("previous staging is untouched"),
            "the refusal names the preservation: {err:#}"
        );
        let after: std::collections::BTreeMap<String, Vec<u8>> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| {
                (
                    e.file_name().to_string_lossy().to_string(),
                    std::fs::read(e.path()).unwrap(),
                )
            })
            .collect();
        assert_eq!(
            before, after,
            "the previous staging is byte-for-byte untouched"
        );
        // No stray temp/aside dirs left beside it.
        let strays: Vec<String> = std::fs::read_dir(dir.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".rebuild-") || n.starts_with(".pre-rebuild-"))
            .collect();
        assert!(strays.is_empty(), "no temp leftovers: {strays:?}");

        crate::import::remove_book_dir_for_tests(&dir);
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// R7-3(d): generated-file / staged-dir fsync failures PROPAGATE — a
    /// staging that cannot be made durable never replaces anything.
    #[test]
    fn staged_tree_fsync_failures_propagate() {
        let root = std::env::temp_dir().join(format!(
            "tl-fsynctree-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("source.txt"), b"S").unwrap();
        std::fs::write(root.join("reader.txt"), b"R").unwrap();

        // ops: fsync_file(0), fsync_file(1), fsync_dir(2) — fail each.
        for fail_at in 0..3 {
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at,
                count: 0,
            };
            let err = fsync_staging_tree(&root, &mut ops).expect_err("injected fsync failure");
            assert!(
                format!("{err:#}").contains("fsync staged"),
                "op {fail_at}: the failure names the durability step: {err:#}"
            );
        }
        let mut ops = FailAtOp {
            real: RealPreserveFs,
            fail_at: usize::MAX,
            count: 0,
        };
        fsync_staging_tree(&root, &mut ops).expect("all fsyncs pass");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// R7-3: the swap is a RECORDED transaction. Boundary sweep: inject a
    /// failure at EVERY injectable operation (txn writes/fsyncs, both
    /// renames, the parent fsync) plus the final readback — after every
    /// single failure the book dir holds the complete PREVIOUS staging and
    /// no transaction record or leftover remains. Then every process-death
    /// state (each recorded phase x each fs combination) resumes to a
    /// complete staging chosen from the RECORDED paths — a stray
    /// prefix-matching directory is never selected.
    #[test]
    fn staging_swap_txn_reverts_every_boundary_and_resumes_every_recorded_phase() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-swaptxn-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("bk_txn");
            let make = |p: &Path, tag: &str| {
                std::fs::create_dir_all(p).unwrap();
                std::fs::write(p.join("source.txt"), tag).unwrap();
            };
            let content = |p: &Path| std::fs::read_to_string(p.join("source.txt")).unwrap();
            let strays = || -> Vec<String> {
                std::fs::read_dir(&parent)
                    .unwrap()
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| {
                        n.starts_with(".rebuild-")
                            || n.starts_with(".pre-rebuild-")
                            || n.starts_with(".staging-txn-")
                            || n.starts_with(".staging-failed-")
                    })
                    .collect()
            };
            let clear = || {
                for e in std::fs::read_dir(&parent).unwrap().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        let _ = std::fs::remove_dir_all(&p);
                    } else {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            };
            let tmp = parent.join(format!(".rebuild-bk_txn-{}", std::process::id()));
            let reset = || {
                clear();
                make(&dir, "OLD");
                make(&tmp, "NEW");
            };

            // ── boundary sweep: every injectable op of the recorded swap —
            // journal writes (exclusive create+fsync / rename / dir-fsync,
            // R11-3), both staging renames, and the parent fsync. Ops 0..12
            // are all PRE-RELEASE boundaries: every failure must revert to
            // the previous staging with nothing left behind. ──
            for fail_at in 0..12 {
                reset();
                let mut ops = FailAtOp {
                    real: RealPreserveFs,
                    fail_at,
                    count: 0,
                };
                swap_rebuilt_staging(
                    &dir,
                    &tmp,
                    "bk_txn",
                    "source.txt",
                    "source.txt",
                    &mut ops,
                    &mut || true,
                )
                .expect_err("injected failure must error");
                assert_eq!(
                    content(&dir),
                    "OLD",
                    "op {fail_at}: the previous staging is live again"
                );
                assert_eq!(
                    strays(),
                    Vec::<String>::new(),
                    "op {fail_at}: no leftover or unresolved record"
                );
            }
            // ── the POST-VERIFIED tail (ops 12..17): the aside release and
            // its fsync are tolerated (inert leftovers a later resume
            // resolves); journal-removal failures PROPAGATE with the swap
            // APPLIED. Every state is coherent and converges via resume. ──
            for fail_at in 12..17 {
                reset();
                let mut ops = FailAtOp {
                    real: RealPreserveFs,
                    fail_at,
                    count: 0,
                };
                let outcome = swap_rebuilt_staging(
                    &dir,
                    &tmp,
                    "bk_txn",
                    "source.txt",
                    "source.txt",
                    &mut ops,
                    &mut || true,
                );
                assert_eq!(
                    content(&dir),
                    "NEW",
                    "op {fail_at}: past verification the swap is APPLIED"
                );
                if outcome.is_err() {
                    // A retained journal is a pending decision — the next
                    // resume resolves it (verified phase ⇒ cleanup).
                    resume_all_interrupted_rebuilds().expect("resume converges");
                }
                assert!(
                    !staging_txn_path(&parent, "bk_txn").exists(),
                    "op {fail_at}: the journal is resolved after (at most) one resume"
                );
                assert_eq!(content(&dir), "NEW");
            }

            // …and the final readback failure.
            reset();
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: usize::MAX,
                count: 0,
            };
            swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_txn",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || false,
            )
            .expect_err("readback failure must error");
            assert_eq!(content(&dir), "OLD");
            assert_eq!(strays(), Vec::<String>::new());

            // ── success path ──
            reset();
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: usize::MAX,
                count: 0,
            };
            swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_txn",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || true,
            )
            .expect("swap succeeds");
            assert_eq!(content(&dir), "NEW");
            assert_eq!(strays(), Vec::<String>::new());

            // ── process-death states: resume acts ONLY on the recorded paths ──
            let aside = parent.join(".pre-rebuild-bk_txn-slot");
            let txn = |phase: &str| StagingTxn {
                book_id: "bk_txn".to_string(),
                tmp: tmp.clone(),
                aside: aside.clone(),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: phase.to_string(),
                had_previous: true,
            };
            let plant = |t: &StagingTxn| {
                std::fs::write(
                    staging_txn_path(&parent, "bk_txn"),
                    serde_json::to_vec_pretty(t).unwrap(),
                )
                .unwrap();
            };

            // e1: died after recording, before any rename (phase "prepared"):
            // dir complete, tmp parked → cleanup, dir untouched.
            clear();
            make(&dir, "OLD");
            make(&tmp, "NEW");
            plant(&txn("prepared"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(content(&dir), "OLD");
            assert_eq!(strays(), Vec::<String>::new());

            // e2: died between the renames (phase "swapping", dir absent,
            // BOTH recorded paths present) → the VALIDATED recorded tmp is
            // promoted; the recorded aside is released.
            clear();
            make(&tmp, "NEW");
            make(&aside, "OLD");
            plant(&txn("swapping"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(content(&dir), "NEW", "validated recorded tmp promoted");
            // R8-2: the promoted staging is complete but not production-
            // verified — the known-good previous is RETAINED, never deleted.
            assert_eq!(content(&aside), "OLD", "the aside survives the promotion");
            assert!(!staging_txn_path(&parent, "bk_txn").exists());

            // e3: dir absent, recorded tmp INCOMPLETE (empty source) → the
            // recorded aside is restored instead.
            clear();
            std::fs::create_dir_all(&tmp).unwrap();
            std::fs::write(tmp.join("source.txt"), b"").unwrap(); // incomplete
            make(&aside, "OLD");
            plant(&txn("swapping"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(content(&dir), "OLD", "an incomplete tmp is never promoted");

            // e4: dir absent, only the recorded aside → restored.
            clear();
            make(&aside, "OLD");
            plant(&txn("swapping"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(content(&dir), "OLD");

            // e5: dir present but INCOMPLETE, recorded aside complete → the
            // aside replaces it.
            clear();
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("source.txt"), b"").unwrap(); // incomplete
            make(&aside, "OLD");
            plant(&txn("swapping"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(content(&dir), "OLD");
            assert_eq!(strays(), Vec::<String>::new());

            // e6: a record with nothing behind it resolves to a no-op.
            clear();
            plant(&txn("prepared"));
            resume_all_interrupted_rebuilds().expect("resume");
            assert!(!dir.exists());
            assert_eq!(strays(), Vec::<String>::new());

            // ── (b) a stray PREFIX-MATCHING partial tmp is never selected:
            // only the RECORDED tmp path is promotable ──
            clear();
            let stray = parent.join(".rebuild-bk_txn-99999");
            make(&stray, "STRAY PARTIAL"); // looks plausible, is NOT recorded
            let recorded = parent.join(".rebuild-bk_txn-recorded");
            make(&recorded, "NEW");
            let mut t = txn("swapping");
            t.tmp = recorded.clone();
            plant(&t);
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(
                content(&dir),
                "NEW",
                "the RECORDED tmp is promoted, never the first prefix match"
            );
            assert!(
                stray.exists() && content(&stray) == "STRAY PARTIAL",
                "the stray was neither selected nor destroyed"
            );

            // ── an unparseable record is a refusal, not a guess ──
            clear();
            make(&dir, "OLD");
            std::fs::write(staging_txn_path(&parent, "bk_txn"), b"{not json").unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("unparseable txn refuses");
            assert!(format!("{err:#}").contains("refusing to guess"));
            let _ = std::fs::remove_file(staging_txn_path(&parent, "bk_txn"));

            // ── R8-2: an UNCONFINED record never directs a rename/delete —
            // escaping paths, foreign names, and unknown phases all refuse ──
            clear();
            make(&dir, "OLD");
            let escape = std::env::temp_dir().join("outside-books-dir");
            for (label, bad) in [
                ("escaping tmp", {
                    let mut t = txn("swapping");
                    t.tmp = escape.clone();
                    t
                }),
                ("foreign aside name", {
                    let mut t = txn("swapping");
                    t.aside = parent.join(".pre-rebuild-OTHERBOOK-slot");
                    t
                }),
                ("path-bearing derived file", {
                    let mut t = txn("swapping");
                    t.derived_file = "../reader.txt".to_string();
                    t
                }),
                ("unknown phase", txn("mystery")),
            ] {
                plant(&bad);
                let err = resume_all_interrupted_rebuilds()
                    .expect_err(&format!("{label}: an unconfined record must refuse"));
                assert!(
                    format!("{err:#}").contains("journal"),
                    "{label}: the refusal names the journal: {err:#}"
                );
                assert_eq!(
                    content(&dir),
                    "OLD",
                    "{label}: nothing was renamed or deleted"
                );
                let _ = std::fs::remove_file(staging_txn_path(&parent, "bk_txn"));
            }
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R8-2 REPRO: verify_live fails, the revert's rename of the invalid
    /// live dir back to tmp ALSO fails (REVERT BLOCKED — journal retained),
    /// the process "restarts". The recovery must RESTORE the known-good
    /// aside — never delete it merely because the live dir holds two
    /// nonempty files.
    #[test]
    fn blocked_revert_after_failed_verification_restores_the_aside_on_restart() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r82repro-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("bk_repro");
            let make = |p: &Path, tag: &str| {
                std::fs::create_dir_all(p).unwrap();
                std::fs::write(p.join("source.txt"), tag).unwrap();
            };
            let content = |p: &Path| std::fs::read_to_string(p.join("source.txt")).unwrap();
            let tmp = parent.join(format!(".rebuild-bk_repro-{}", std::process::id()));
            make(&dir, "OLD");
            make(&tmp, "NEW");

            // ops (R11-3: a journal write is 3 ops — exclusive create+fsync,
            // rename, dir fsync): 0..=2 txn1, 3 rename-out, 4..=6 txn2,
            // 7 rename-in, 8 parent fsync, [verify → FALSE], revert:
            // 9 rename dir→tmp ← INJECTED FAILURE (the "moving invalid live
            // back to tmp also fails" leg of the repro).
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: 9,
                count: 0,
            };
            let err = swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_repro",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || false, // verification fails
            )
            .expect_err("blocked revert");
            let msg = format!("{err:#}");
            assert!(msg.contains("REVERT BLOCKED"), "{msg}");
            // The blocked state: the UNVERIFIED product occupies the dir, the
            // known-good previous sits in the recorded aside, journal kept.
            assert_eq!(content(&dir), "NEW", "unverified product at the dir");
            let aside = parent.join(format!(".pre-rebuild-bk_repro-{}", std::process::id()));
            assert_eq!(content(&aside), "OLD", "known-good previous preserved");
            assert!(
                staging_txn_path(&parent, "bk_repro").exists(),
                "journal retained"
            );

            // "Process restarts": the recovery restores the aside — the two
            // nonempty files at the dir do NOT outrank the recorded truth.
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(
                content(&dir),
                "OLD",
                "the known-good aside was RESTORED over the unverified product"
            );
            assert!(!staging_txn_path(&parent, "bk_repro").exists());
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R9-2: a revert that succeeds LOGICALLY (both renames back in place)
    /// but cannot prove durability or remove its recovery sources DELETES
    /// NOTHING it hasn't proven safe to delete, reports the COMPOUND failure,
    /// and leaves a record the next resume converges from.
    #[test]
    fn revert_deletes_nothing_until_durable_and_propagates_compound_failures() {
        /// Delegates to the real fs but fails chosen fsync_dir calls (by
        /// 0-indexed call number) and, optionally, the journal remove.
        struct FailChosen {
            real: RealPreserveFs,
            fsync_dir_fails: Vec<usize>,
            fsync_dir_count: usize,
            fail_journal_remove: bool,
        }
        impl PreserveFs for FailChosen {
            fn copy(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
                self.real.copy(from, to)
            }
            fn fsync_file(&mut self, p: &Path) -> std::io::Result<()> {
                self.real.fsync_file(p)
            }
            fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
                self.real.rename(from, to)
            }
            fn fsync_dir(&mut self, p: &Path) -> std::io::Result<()> {
                let n = self.fsync_dir_count;
                self.fsync_dir_count += 1;
                if self.fsync_dir_fails.contains(&n) {
                    return Err(std::io::Error::other("injected fsync_dir failure"));
                }
                self.real.fsync_dir(p)
            }
            fn write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<()> {
                self.real.write(p, bytes)
            }
            fn remove_file(&mut self, p: &Path) -> std::io::Result<()> {
                if self.fail_journal_remove && p.to_string_lossy().contains(".staging-txn-") {
                    return Err(std::io::Error::other("injected journal-remove failure"));
                }
                self.real.remove_file(p)
            }
            fn remove_dir_all(&mut self, p: &Path) -> std::io::Result<()> {
                self.real.remove_dir_all(p)
            }
            fn create_new_write(&mut self, p: &Path, bytes: &[u8]) -> std::io::Result<(u64, u64)> {
                self.real.create_new_write(p, bytes)
            }
        }

        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r92revert-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("bk_rev");
            let make = |p: &Path, tag: &str| {
                std::fs::create_dir_all(p).unwrap();
                std::fs::write(p.join("source.txt"), tag).unwrap();
            };
            let content = |p: &Path| std::fs::read_to_string(p.join("source.txt")).unwrap();
            let tmp = parent.join(format!(".rebuild-bk_rev-{}", std::process::id()));

            // fsync_dir call order (had_previous, verify unreached):
            //   #0 prepared-journal write · #1 swapping-journal write ·
            //   #2 post-swap parent fsync (FAIL → revert) · #3 the revert's
            //   own parent fsync.

            // ── Scenario A: the revert's parent fsync ALSO fails — nothing
            // may be deleted (the restored namespace is not proven durable).
            make(&dir, "OLD");
            make(&tmp, "NEW");
            let mut ops = FailChosen {
                real: RealPreserveFs,
                fsync_dir_fails: vec![2, 3],
                fsync_dir_count: 0,
                fail_journal_remove: false,
            };
            let err = swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_rev",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || true,
            )
            .expect_err("compound revert failure must error");
            let msg = format!("{err:#}");
            assert!(
                msg.contains("make the staging swap durable"),
                "the original cause is reported: {msg}"
            );
            assert!(
                msg.contains("durability could not be proven"),
                "the revert-fsync failure is reported as compound context: {msg}"
            );
            assert_eq!(content(&dir), "OLD", "the previous staging is back");
            assert_eq!(
                content(&tmp),
                "NEW",
                "tmp survives — nothing deleted before the namespace is durable"
            );
            assert!(
                staging_txn_path(&parent, "bk_rev").exists(),
                "the journal survives too"
            );
            // The next resume (real fs) converges: dir kept, leftovers gone.
            resume_all_interrupted_rebuilds().expect("resume converges");
            assert_eq!(content(&dir), "OLD");
            assert!(!tmp.exists() && !staging_txn_path(&parent, "bk_rev").exists());

            // ── Scenario B: the revert IS durable but the journal removal
            // fails — the compound failure propagates and the record stays
            // for the next resume.
            make(&dir, "OLD");
            make(&tmp, "NEW");
            let mut ops = FailChosen {
                real: RealPreserveFs,
                fsync_dir_fails: vec![2],
                fsync_dir_count: 0,
                fail_journal_remove: true,
            };
            let err = swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_rev",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || true,
            )
            .expect_err("journal-removal failure must propagate");
            let msg = format!("{err:#}");
            assert!(
                msg.contains("transaction record could not be removed"),
                "the journal-removal failure is reported: {msg}"
            );
            assert_eq!(content(&dir), "OLD");
            assert!(
                !tmp.exists(),
                "with the namespace durably fsynced, the tmp cleanup ran"
            );
            assert!(
                staging_txn_path(&parent, "bk_rev").exists(),
                "the unremovable journal stays as the pending decision"
            );
            resume_all_interrupted_rebuilds().expect("resume converges");
            assert_eq!(content(&dir), "OLD");
            assert!(!staging_txn_path(&parent, "bk_rev").exists());
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R9-2: confined-LOOKING journal/tmp/aside/live names that are actually
    /// SYMLINKS targeting outside the books directory are refused before any
    /// read, chmod, rename, or delete — and the outside targets' bytes AND
    /// permissions stay untouched.
    #[cfg(unix)]
    #[test]
    fn staging_symlinks_are_refused_and_outside_targets_stay_untouched() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r92symlink-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            // The OUTSIDE world an attacker wants touched: a complete-looking
            // staging dir and a read-only victim file.
            let outside = data.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("source.txt"), "OUTSIDE STAGING").unwrap();
            let victim = data.join("victim.txt");
            std::fs::write(&victim, "VICTIM BYTES").unwrap();
            std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o444)).unwrap();
            let outside_snapshot = || {
                (
                    std::fs::read(outside.join("source.txt")).unwrap(),
                    std::fs::read(&victim).unwrap(),
                    std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
                )
            };
            let before = outside_snapshot();

            let tmp = parent.join(".rebuild-bk_sym-1");
            let aside = parent.join(".pre-rebuild-bk_sym-1");
            let dir = parent.join("bk_sym");
            let txn = StagingTxn {
                book_id: "bk_sym".to_string(),
                tmp: tmp.clone(),
                aside: aside.clone(),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: "swapping".to_string(),
                had_previous: true,
            };
            let plant = |t: &StagingTxn| {
                std::fs::write(
                    staging_txn_path(&parent, "bk_sym"),
                    serde_json::to_vec_pretty(t).unwrap(),
                )
                .unwrap();
            };
            let clear = || {
                for e in std::fs::read_dir(&parent).unwrap().flatten() {
                    let p = e.path();
                    let is_link = std::fs::symlink_metadata(&p)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);
                    if is_link || p.is_file() {
                        let _ = std::fs::remove_file(&p);
                    } else {
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            };

            // (a) the JOURNAL itself is a symlink (to a valid-looking record
            // outside) → refused BEFORE any read.
            let outside_journal = data.join("outside-journal.json");
            std::fs::write(&outside_journal, serde_json::to_vec_pretty(&txn).unwrap()).unwrap();
            symlink(&outside_journal, staging_txn_path(&parent, "bk_sym")).unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("symlinked journal refused");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert_eq!(outside_snapshot(), before);
            clear();

            // (b) the recorded TMP is a symlink to a complete-looking outside
            // staging; the book dir is absent → a naive resume would promote
            // the link into place as the live book dir. Refused.
            plant(&txn);
            symlink(&outside, &tmp).unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("symlinked tmp refused");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert!(!dir.exists(), "no live dir was minted through the link");
            assert_eq!(outside_snapshot(), before);
            clear();

            // (c) the recorded ASIDE is a symlink → refused.
            plant(&txn);
            symlink(&outside, &aside).unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("symlinked aside refused");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert!(!dir.exists());
            assert_eq!(outside_snapshot(), before);
            clear();

            // (d) the LIVE BOOK DIR is a symlink → refused (resume and swap).
            plant(&txn);
            symlink(&outside, &dir).unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("symlinked live dir refused");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert_eq!(outside_snapshot(), before);
            clear();

            // (e) the SWAP refuses a symlinked tmp before anything moves.
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("source.txt"), "OLD").unwrap();
            symlink(&outside, &tmp).unwrap();
            let err = swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_sym",
                "source.txt",
                "source.txt",
                &mut RealPreserveFs,
                &mut || true,
            )
            .expect_err("symlinked tmp refused by the swap");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert_eq!(outside_snapshot(), before);
            clear();

            // (f) cleanup never CHMODs through a link: a doomed dir holding a
            // symlink to the read-only victim is removed without touching the
            // victim's permissions or bytes.
            let doomed = parent.join(".rebuild-bk_sym-doomed");
            std::fs::create_dir_all(&doomed).unwrap();
            symlink(&victim, doomed.join("source.txt")).unwrap();
            crate::import::remove_book_dir_quiet(&doomed);
            assert!(!doomed.exists(), "the doomed dir is gone");
            assert_eq!(
                outside_snapshot(),
                before,
                "the victim's bytes and permissions survived the cleanup"
            );

            // (g) a doomed path that IS a symlink: only the link goes.
            let linkdir = parent.join(".rebuild-bk_sym-linkdir");
            symlink(&outside, &linkdir).unwrap();
            crate::import::remove_book_dir_quiet(&linkdir);
            assert!(std::fs::symlink_metadata(&linkdir).is_err(), "link removed");
            assert_eq!(outside_snapshot(), before, "the target dir survived");
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R10-2: a REGULAR tmp directory whose recorded staging files are
    /// SYMLINKS to targets outside books/ is refused — the resume errors,
    /// the journal is RETAINED as the pending decision, and the outside
    /// target's bytes and permissions stay untouched. (The R9 no-follow
    /// checks covered the tmp/aside dirs themselves; this covers their
    /// CHILDREN.)
    #[cfg(unix)]
    #[test]
    fn symlinked_staging_children_are_refused_and_the_journal_is_retained() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r102child-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let victim = data.join("victim.txt");
            std::fs::write(&victim, "VICTIM BYTES").unwrap();
            std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o444)).unwrap();
            let victim_state = || {
                (
                    std::fs::read(&victim).unwrap(),
                    std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
                )
            };
            let before = victim_state();

            let tmp = parent.join(".rebuild-bk_child-1");
            std::fs::create_dir_all(&tmp).unwrap(); // a REGULAR directory…
            symlink(&victim, tmp.join("source.txt")).unwrap(); // …with a symlink child
            let txn = StagingTxn {
                book_id: "bk_child".to_string(),
                tmp: tmp.clone(),
                aside: parent.join(".pre-rebuild-bk_child-1"),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: "swapping".to_string(),
                had_previous: false,
            };
            std::fs::write(
                staging_txn_path(&parent, "bk_child"),
                serde_json::to_vec_pretty(&txn).unwrap(),
            )
            .unwrap();

            let err = resume_all_interrupted_rebuilds()
                .expect_err("a symlinked staging child must refuse the resume");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            assert!(
                staging_txn_path(&parent, "bk_child").exists(),
                "the journal is RETAINED as the pending decision"
            );
            assert!(
                !parent.join("bk_child").exists(),
                "no live book dir was minted through the link"
            );
            assert_eq!(victim_state(), before, "the outside target is untouched");
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R10-2: the INJECTED SYMLINK-SWAP races. The journal read is
    /// descriptor-validated (open first, then the fd's identity must equal
    /// the path's no-follow identity), so a swap landing INSIDE the old
    /// check-then-read window is refused with the outside target's bytes and
    /// permissions untouched; and the journal temp is created exclusively
    /// (create_new), so a planted entry at the temp name fails the write.
    #[cfg(unix)]
    #[test]
    fn journal_io_survives_injected_symlink_swaps() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r102swap-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let victim = data.join("victim.txt");
            std::fs::write(&victim, "VICTIM BYTES").unwrap();
            std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o444)).unwrap();
            let victim_state = || {
                (
                    std::fs::read(&victim).unwrap(),
                    std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
                )
            };
            let before = victim_state();
            let txn = StagingTxn {
                book_id: "bk_swap".to_string(),
                tmp: parent.join(".rebuild-bk_swap-1"),
                aside: parent.join(".pre-rebuild-bk_swap-1"),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: "prepared".to_string(),
                had_previous: false,
            };
            let journal = staging_txn_path(&parent, "bk_swap");

            // (a) regular journal SWAPPED to a symlink between open and
            // validation → refused, victim untouched.
            std::fs::write(&journal, serde_json::to_vec_pretty(&txn).unwrap()).unwrap();
            {
                let victim = victim.clone();
                let journal_c = journal.clone();
                nofollow_test_seam::arm(Box::new(move |p: &Path| {
                    if p == journal_c {
                        let _ = std::fs::remove_file(&journal_c);
                        symlink(&victim, &journal_c).unwrap();
                    }
                }));
            }
            let err = resume_all_interrupted_rebuilds().expect_err("swapped journal refused");
            nofollow_test_seam::disarm();
            assert!(
                format!("{err:#}").contains("symlink")
                    || format!("{err:#}").contains("changed identity"),
                "{err:#}"
            );
            assert_eq!(victim_state(), before);
            let _ = std::fs::remove_file(&journal);

            // (b) a REGULAR journal swapped for a DIFFERENT regular file
            // between open and validation: the open descriptor no longer
            // matches the path's identity → refused, nothing trusted. (A
            // pre-planted SYMLINK can no longer even reach this window —
            // R11-3's O_NOFOLLOW open refuses it at the kernel, tested in
            // (a) above.)
            std::fs::write(&journal, serde_json::to_vec_pretty(&txn).unwrap()).unwrap();
            {
                let journal_c = journal.clone();
                let decoy = serde_json::to_vec_pretty(&txn).unwrap();
                nofollow_test_seam::arm(Box::new(move |p: &Path| {
                    if p == journal_c {
                        let _ = std::fs::remove_file(&journal_c);
                        std::fs::write(&journal_c, &decoy).unwrap();
                    }
                }));
            }
            let err = resume_all_interrupted_rebuilds().expect_err("swapped descriptor refused");
            nofollow_test_seam::disarm();
            assert!(
                format!("{err:#}").contains("changed identity"),
                "the fd/path identity mismatch is named: {err:#}"
            );
            assert_eq!(victim_state(), before);
            let _ = std::fs::remove_file(&journal);

            // (c) the journal temp is created EXCLUSIVELY: a planted symlink
            // (or file) at the temp name fails the create — never a write
            // through the link.
            let planted = parent.join("planted-temp");
            symlink(&victim, &planted).unwrap();
            let err = RealPreserveFs
                .create_new_write(&planted, b"attacker-visible bytes")
                .expect_err("create_new must refuse an existing symlink");
            assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
            assert_eq!(
                victim_state(),
                before,
                "nothing was written through the link"
            );
            let plain = parent.join("planted-file");
            std::fs::write(&plain, b"existing").unwrap();
            RealPreserveFs
                .create_new_write(&plain, b"x")
                .expect_err("create_new must refuse an existing file");
            assert_eq!(std::fs::read(&plain).unwrap(), b"existing");
        });
        nofollow_test_seam::disarm();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-3 race (a): a required child swapped to a SYMLINK after
    /// validation but before promotion — the post-promotion revalidation
    /// refuses before the journal is consumed; the journal survives as the
    /// pending decision and the outside target stays untouched.
    #[cfg(unix)]
    #[test]
    fn child_swapped_to_symlink_after_validation_is_refused_with_journal_retained() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r113a-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let victim = data.join("victim.txt");
            std::fs::write(&victim, "VICTIM BYTES").unwrap();
            std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o444)).unwrap();
            let victim_state = || {
                (
                    std::fs::read(&victim).unwrap(),
                    std::fs::metadata(&victim).unwrap().permissions().mode() & 0o777,
                )
            };
            let before = victim_state();

            let tmp = parent.join(".rebuild-bk_race_a-1");
            std::fs::create_dir_all(&tmp).unwrap();
            std::fs::write(tmp.join("source.txt"), "REAL STAGED BYTES").unwrap();
            let txn = StagingTxn {
                book_id: "bk_race_a".to_string(),
                tmp: tmp.clone(),
                aside: parent.join(".pre-rebuild-bk_race_a-1"),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: "swapping".to_string(),
                had_previous: false,
            };
            std::fs::write(
                staging_txn_path(&parent, "bk_race_a"),
                serde_json::to_vec_pretty(&txn).unwrap(),
            )
            .unwrap();

            // The race: after validation captured the child's identity, the
            // child is replaced with a symlink to the outside victim.
            {
                let victim = victim.clone();
                staging_race_seam::arm(Box::new(move |point: &str, dir: &Path| {
                    if point == "resume-validated" {
                        let child = dir.join("source.txt");
                        let _ = std::fs::remove_file(&child);
                        symlink(&victim, &child).unwrap();
                    }
                }));
            }
            let err = resume_all_interrupted_rebuilds()
                .expect_err("the swapped child must refuse the resume");
            staging_race_seam::disarm();
            let msg = format!("{err:#}");
            assert!(
                msg.contains("no longer a regular file") || msg.contains("changed identity"),
                "{msg}"
            );
            assert!(
                staging_txn_path(&parent, "bk_race_a").exists(),
                "the journal is RETAINED as the pending decision"
            );
            assert_eq!(victim_state(), before, "the outside target is untouched");
        });
        staging_race_seam::disarm();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-3 race (b): the journal TEMP replaced after exclusive creation
    /// but before rename — the post-rename identity check refuses (the entry
    /// at the journal name is not the exclusively-written record), the swap
    /// aborts with the previous staging preserved, and outside state is
    /// untouched.
    #[cfg(unix)]
    #[test]
    fn journal_temp_replaced_after_exclusive_creation_is_refused() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r113b-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("bk_race_b");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("source.txt"), "OLD").unwrap();
            let tmp = parent.join(format!(".rebuild-bk_race_b-{}", std::process::id()));
            std::fs::create_dir_all(&tmp).unwrap();
            std::fs::write(tmp.join("source.txt"), "NEW").unwrap();

            // The race: between the exclusive temp write and its rename, the
            // temp is replaced with attacker bytes.
            staging_race_seam::arm(Box::new(move |point: &str, temp: &Path| {
                if point == "journal-temp-durable" {
                    let _ = std::fs::remove_file(temp);
                    std::fs::write(temp, b"{\"attacker\": true}").unwrap();
                }
            }));
            let err = swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_race_b",
                "source.txt",
                "source.txt",
                &mut RealPreserveFs,
                &mut || true,
            )
            .expect_err("the replaced temp must refuse the swap");
            staging_race_seam::disarm();
            let msg = format!("{err:#}");
            assert!(
                msg.contains("not the exclusively-written record"),
                "the identity check names the refusal: {msg}"
            );
            // The previous staging is preserved (the swap aborted before any
            // replacement).
            assert_eq!(
                std::fs::read_to_string(dir.join("source.txt")).unwrap(),
                "OLD",
                "the previous staging is intact"
            );
        });
        staging_race_seam::disarm();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-3 race (c): a journal that is a SYMLINK TO A FIFO is rejected
    /// PROMPTLY by the O_NOFOLLOW open — the FIFO is never opened, so
    /// nothing can block on it; a DIRECT FIFO at the journal name is opened
    /// non-blocking and refused as a non-regular file.
    #[cfg(unix)]
    #[test]
    fn journal_symlink_to_a_fifo_is_rejected_promptly() {
        use std::os::unix::fs::symlink;
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r113c-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let fifo = data.join("trap.fifo");
            let status = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("mkfifo runs");
            assert!(status.success(), "mkfifo created the FIFO");

            // (i) journal = symlink → FIFO: refused at open (ELOOP), the
            // FIFO's other end is NEVER opened — no writer exists, so a
            // blocking open would hang this very test.
            let journal = staging_txn_path(&parent, "bk_fifo");
            symlink(&fifo, &journal).unwrap();
            let err = resume_all_interrupted_rebuilds().expect_err("symlink-to-FIFO refused");
            assert!(format!("{err:#}").contains("symlink"), "{err:#}");
            std::fs::remove_file(&journal).unwrap();

            // (ii) a DIRECT FIFO at the journal name: the non-blocking open
            // returns immediately and the fstat refuses the non-regular type.
            let status = std::process::Command::new("mkfifo")
                .arg(&journal)
                .status()
                .expect("mkfifo runs");
            assert!(status.success());
            let err = resume_all_interrupted_rebuilds().expect_err("direct FIFO refused");
            assert!(format!("{err:#}").contains("not a regular file"), "{err:#}");
            std::fs::remove_file(&journal).unwrap();
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R8-2: FIRST-TIME staging runs the same recorded transaction with no
    /// aside step — success promotes cleanly; failure reverts to ABSENCE;
    /// a mid-swap death resumes from the recorded tmp.
    #[test]
    fn first_time_staging_uses_the_recorded_transaction() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-r82first-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            let dir = parent.join("bk_first");
            let make = |p: &Path, tag: &str| {
                std::fs::create_dir_all(p).unwrap();
                std::fs::write(p.join("source.txt"), tag).unwrap();
            };
            let content = |p: &Path| std::fs::read_to_string(p.join("source.txt")).unwrap();
            let tmp = parent.join(format!(".rebuild-bk_first-{}", std::process::id()));

            // Success: dir ABSENT → promoted, no aside, journal consumed.
            make(&tmp, "NEW");
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: usize::MAX,
                count: 0,
            };
            swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_first",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || true,
            )
            .expect("first-time swap");
            assert_eq!(content(&dir), "NEW");
            assert!(!staging_txn_path(&parent, "bk_first").exists());

            // Failure mid-swap (rename-in, op 5 for the no-aside sequence:
            // 0..=3 txn1, 4 = rename tmp→dir... enumerate: with dir absent
            // there is no rename-out, so txn2 write is ops 4..=7 and the
            // rename-in is op 8): revert back to ABSENCE, tmp cleaned.
            let _ = std::fs::remove_dir_all(&dir);
            make(&tmp, "NEW2");
            let mut ops = FailAtOp {
                real: RealPreserveFs,
                fail_at: 8,
                count: 0,
            };
            swap_rebuilt_staging(
                &dir,
                &tmp,
                "bk_first",
                "source.txt",
                "source.txt",
                &mut ops,
                &mut || true,
            )
            .expect_err("injected rename-in failure");
            assert!(!dir.exists(), "first-time failure reverts to absence");
            assert!(!staging_txn_path(&parent, "bk_first").exists());

            // Mid-swap death (journal phase "swapping", dir absent, tmp
            // valid, NO aside recorded as existing): the resume promotes.
            make(&tmp, "NEW3");
            let txn = StagingTxn {
                book_id: "bk_first".to_string(),
                tmp: tmp.clone(),
                aside: parent.join(".pre-rebuild-bk_first-slot"),
                source_file: "source.txt".to_string(),
                derived_file: "source.txt".to_string(),
                phase: "swapping".to_string(),
                had_previous: false,
            };
            std::fs::write(
                staging_txn_path(&parent, "bk_first"),
                serde_json::to_vec_pretty(&txn).unwrap(),
            )
            .unwrap();
            resume_all_interrupted_rebuilds().expect("resume");
            assert_eq!(
                content(&dir),
                "NEW3",
                "first-time death resumes to the recorded tmp"
            );
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R7-3(c): a books-dir that cannot be ENUMERATED is unknown state — the
    /// resume propagates the error instead of treating it as nothing-to-do.
    #[cfg(unix)]
    #[test]
    fn unreadable_books_dir_fails_the_resume_loudly() {
        use std::os::unix::fs::PermissionsExt;
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-resumedenied-{}-{}",
            std::process::id(),
            super::timestamp_slug()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };
        let result = std::panic::catch_unwind(|| {
            let parent = paths::books_dir().unwrap();
            std::fs::create_dir_all(&parent).unwrap();
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o000)).unwrap();
            let perms_enforced = std::fs::read_dir(&parent).is_err();
            let outcome = resume_all_interrupted_rebuilds();
            std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
            if perms_enforced {
                let err = outcome.expect_err("enumeration failure must propagate");
                assert!(format!("{err:#}").contains("enumerate books dir"));
            } else {
                eprintln!("skipping: permissions not enforced (root?)");
            }
        });
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    // ── REC-011 R3: the DEEP preflight ──

    /// A truncated derived text whose FIRST page still reads must be caught:
    /// the source SHA is intact and `book_row_readable` (first 256 chars)
    /// passes, but a later section points past the truncation.
    #[test]
    fn preflight_catches_truncated_reader_text_whose_first_page_still_reads() {
        let (g, conn, data) = isolated_open();
        let body = format!(
            "{}\n\n{}",
            "Opening section words that read perfectly well. ".repeat(8),
            "Closing section words that will be truncated away. ".repeat(8),
        );
        let cut = body.len() / 2;
        seed_book_with_sections(&conn, "bk_trunc", &body, &[("One", 0), ("Two", cut)]);
        let candidate = data.join("candidate.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        assert!(
            books_missing_files(&candidate).unwrap().is_empty(),
            "intact → coherent"
        );

        // Truncate the DERIVED text only — the immutable source (and its SHA)
        // stay intact, and the first 256 chars still read fine.
        let reader = paths::book_dir("bk_trunc").unwrap().join("reader.txt");
        std::fs::write(&reader, &body[..cut / 2]).unwrap();
        assert!(
            crate::commands::books::read_txt_section("bk_trunc", 0, Some(256))
                .is_ok_and(|s| !s.trim().is_empty()),
            "the shallow first-page read still passes — that was the hole"
        );
        assert_eq!(
            books_missing_files(&candidate).unwrap(),
            vec!["T".to_string()],
            "the deep preflight must flag the truncated book"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// A same-named but different source file (SHA mismatch) must be flagged —
    /// every locator in the backup would silently misalign.
    #[test]
    fn preflight_catches_source_content_mismatch() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "bk_swap");
        let candidate = data.join("candidate.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        assert!(books_missing_files(&candidate).unwrap().is_empty());

        let dir = paths::book_dir("bk_swap").unwrap();
        std::fs::write(
            dir.join("source.txt"),
            "entirely different words, same name",
        )
        .unwrap();
        std::fs::write(
            dir.join("reader.txt"),
            "entirely different words, same name",
        )
        .unwrap();
        assert_eq!(
            books_missing_files(&candidate).unwrap(),
            vec!["T".to_string()],
            "content mismatch must be flagged even though the file reads"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// A structure.json keyed to section ids the candidate's rows don't know
    /// (an un-remapped re-import) must be flagged: typography would silently
    /// vanish for every section after the restore.
    #[test]
    fn preflight_catches_structure_keyed_to_foreign_section_ids() {
        let (g, conn, data) = isolated_open();
        seed_book(&conn, "bk_struct");
        let candidate = data.join("candidate.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        assert!(books_missing_files(&candidate).unwrap().is_empty());

        let dir = paths::book_dir("bk_struct").unwrap();
        std::fs::write(
            dir.join("structure.json"),
            r#"{"sec_from_some_other_import":[{"kind":"em","start":0,"end":4}]}"#,
        )
        .unwrap();
        assert_eq!(
            books_missing_files(&candidate).unwrap(),
            vec!["T".to_string()],
            "foreign-keyed structure.json must be flagged"
        );
        // Keyed to the candidate's own ids → coherent again.
        std::fs::write(
            dir.join("structure.json"),
            r#"{"sec_bk_struct_0":[{"kind":"em","start":0,"end":4}]}"#,
        )
        .unwrap();
        assert!(books_missing_files(&candidate).unwrap().is_empty());
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// A row the coherence check cannot even DECODE must fail the preflight —
    /// never be `filter_map`-dropped into a silent pass.
    #[test]
    fn preflight_propagates_row_decode_failures_instead_of_dropping_the_row() {
        let (g, conn, data) = isolated_open();
        // A non-UTF-8 BLOB where a TEXT title belongs (SQLite's dynamic typing
        // permits it; a corrupted page produces the same shape) fails
        // `r.get::<_, String>` — exactly what the old filter_map silently
        // discarded.
        conn.execute_batch(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('bk_blob', x'fffe', 'txt','/x','s','2026-01-01');",
        )
        .unwrap();
        let candidate = data.join("candidate.db");
        conn.execute("VACUUM INTO ?1", [candidate.to_string_lossy().as_ref()])
            .unwrap();
        assert!(
            books_missing_files(&candidate).is_err(),
            "an undecodable row must FAIL the preflight, not vanish from it"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }

    /// Staging must REFUSE (and clean up the half-staged directory) when the
    /// re-imported file derives a different sectionization than the backup
    /// recorded — a silently misaligned staging would read, but every note
    /// anchor and typography range would point into the wrong sections.
    #[test]
    fn staging_refuses_and_cleans_up_when_sections_do_not_match_history() {
        let (g, conn, data) = isolated_open();
        let fixture = std::path::Path::new("tests/fixtures/corpus/confessions_augustine.txt");
        let result = crate::import::import_any(fixture).expect("real import");
        let book_id = result.book.id.clone();
        conn.execute(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                result.book.id, result.book.title, result.book.author, result.book.source_type,
                result.book.source_path, result.book.source_sha256, result.book.created_at,
                result.book.last_opened_at
            ],
        )
        .unwrap();
        for s in &result.sections {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator,
                    s.estimated_units, s.sort_order, s.assignable as i64
                ],
            )
            .unwrap();
        }
        // TAMPER the recorded history: one section's end locator moves, so the
        // deterministic re-derivation can no longer line up with it.
        conn.execute(
            "UPDATE book_sections SET end_locator = '17' WHERE book_id = ?1 AND sort_order = 0",
            [&book_id],
        )
        .unwrap();
        write_rolling_backup(&conn).expect("backup");
        let backup_file = list_backups(&paths::backups_dir().unwrap())
            .unwrap()
            .pop()
            .unwrap();
        crate::import::remove_book_dir_for_tests(&paths::book_dir(&book_id).unwrap());

        let err = stage_book_for_restore(&backup_file, fixture)
            .expect_err("misaligned sectionization must refuse");
        assert!(
            format!("{err:#}").contains("does not line up"),
            "refusal names the misalignment: {err:#}"
        );
        assert!(
            !paths::book_dir(&book_id).unwrap().exists(),
            "the half-staged directory was cleaned up"
        );
        drop(conn);
        cleanup(&data);
        drop(g);
    }
}

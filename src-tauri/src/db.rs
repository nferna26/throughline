use anyhow::{Context, Result};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::error::AppError;
use crate::{migrations, paths};

pub struct DbState(Mutex<Connection>);

/// R10-2/R11-2: INTERPROCESS single-instance exclusion, per data directory.
/// The exclusive advisory lock (`std::fs::File::try_lock`) is taken on the
/// DATA DIRECTORY'S OWN file descriptor — not on a lock file inside it. A
/// plain lock file has a replaceable inode: unlink + recreate mints a fresh
/// inode a second process can lock while the first still "holds" the old
/// one. The directory's inode cannot be swapped out without relocating the
/// entire library (reading.db and all), which is far outside the failure
/// model — so exclusion rides an inode that actually pins the resource.
///
/// The registry is keyed by the locked descriptor's (device, inode), so path
/// ALIASES (symlinked paths, `a/../a`, differing text for the same dir) hit
/// the same entry: an alias neither bypasses exclusion (same inode, same
/// flock) nor produces phantom self-contention (re-entrant within this
/// process). Locks are held for the LIFE of the process; tests use distinct
/// isolated dirs, so they never contend with each other.
static PROCESS_LOCKS: Mutex<Option<HashMap<(u64, u64), std::fs::File>>> = Mutex::new(None);

/// Acquire (or confirm this process already holds) the exclusive
/// interprocess lock for `data_dir`. Fails LOUDLY when another process holds
/// it — proceeding would let two processes race the same reading.db.
pub fn acquire_process_lock_for(data_dir: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir for the process lock: {data_dir:?}"))?;
    // Canonicalize BEFORE opening so alias texts resolve to one path, then
    // key by the OPEN DESCRIPTOR's identity (the authority the flock is
    // actually held on).
    let canonical = data_dir
        .canonicalize()
        .with_context(|| format!("canonicalize data dir {data_dir:?}"))?;
    let dir_file = std::fs::File::open(&canonical)
        .with_context(|| format!("open data dir for locking: {canonical:?}"))?;
    let meta = dir_file
        .metadata()
        .with_context(|| format!("stat data dir descriptor: {canonical:?}"))?;
    let key = (meta.dev(), meta.ino());

    let mut registry = PROCESS_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let held = registry.get_or_insert_with(HashMap::new);
    if held.contains_key(&key) {
        return Ok(()); // re-entrant within this process (any alias)
    }
    dir_file.try_lock().map_err(|e| {
        anyhow::anyhow!(
            "another Throughline process is already using this library \
             (exclusive lock on the data directory {canonical:?} is held \
             elsewhere: {e}). Quit the other copy, then relaunch."
        )
    })?;
    held.insert(key, dir_file);
    Ok(())
}

/// The default-data-dir variant — THE gate `open_and_migrate`, the resilient
/// launch open, and the promotion protocol all call first.
pub fn acquire_process_lock() -> Result<()> {
    let dir = paths::db_path()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("db path has no parent"))?;
    acquire_process_lock_for(&dir)
}

/// R9-1: once a library switch has APPLIED but its durability could not be
/// proven, this process must stop serving commands against that database —
/// continuing silently would let the reader keep writing into a library whose
/// on-disk transition is unverified. The latch is one-way for the life of the
/// process; only a relaunch (which re-verifies on open) clears it.
static RELAUNCH_REQUIRED: Mutex<Option<String>> = Mutex::new(None);

pub fn require_relaunch(msg: &str) {
    let mut latch = RELAUNCH_REQUIRED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if latch.is_none() {
        *latch = Some(msg.to_string());
    }
}

pub fn relaunch_required() -> Option<String> {
    RELAUNCH_REQUIRED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Tests share one process; the latch must not leak across them.
#[cfg(test)]
pub fn reset_relaunch_for_tests() {
    *RELAUNCH_REQUIRED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

impl DbState {
    pub fn new(conn: Connection) -> Self {
        DbState(Mutex::new(conn))
    }

    /// THE way commands reach the database. Refuses — with the honest
    /// message — once a relaunch is required (R9-1); the field is private so
    /// no command can bypass this check.
    ///
    /// R10-2: the mutex is acquired FIRST, the latch checked AFTER. A command
    /// already queued on the mutex while a restore was setting the
    /// AppliedUnproven latch would otherwise pass a pre-acquisition check
    /// made before the latch existed and run against the unproven library.
    pub fn lock(&self) -> std::result::Result<MutexGuard<'_, Connection>, AppError> {
        let guard = self.0.lock().map_err(AppError::from)?;
        if let Some(msg) = relaunch_required() {
            drop(guard);
            return Err(AppError::io(msg));
        }
        Ok(guard)
    }
}

/// Open the SQLite database at `paths::db_path()` and run any pending
/// migrations from the `migrations` module. The full schema lives there;
/// this function is now just the connection-opening seam.
pub fn open_and_migrate() -> Result<Connection> {
    // R10-2: interprocess exclusion comes BEFORE the open — a second process
    // must fail here, with no connection created and no sidecars recreated.
    acquire_process_lock()?;
    paths::ensure_dirs()?;
    let conn = Connection::open(paths::db_path()?)?;
    // PRAGMAs that should apply on every open (not just on first migration).
    //
    // `synchronous = NORMAL` pairs with WAL: fsync the WAL on commit but defer
    // the database-file fsync to checkpoint time. Worst case under power loss is
    // "lose the last committed transaction" — never DB corruption — which is
    // acceptable here because the durable artifact is the Markdown export
    // (written atomically before commit), not the DB row. Halves the per-commit
    // fsync cost vs. WAL's FULL default. See cto-kb
    // adr-002-throughline-sqlite-synchronous-normal.
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )?;
    migrations::apply_pending(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh launch must not plant `~/Documents/Throughline/...` in the reader's
    /// home before any export exists — export creates its dirs on demand
    /// (`export::ensure_export_dirs`, exercised by the export tests). Opening
    /// the DB therefore must not create the export root or its subdirs.
    #[test]
    fn open_does_not_create_export_dirs() {
        let _g = paths::lock_env_for_test();
        let unique = format!("tl-db-open-{}-{}", std::process::id(), line!());
        let data = std::env::temp_dir().join(format!("{unique}-data"));
        let export = std::env::temp_dir().join(format!("{unique}-export"));
        let _ = std::fs::remove_dir_all(&export);
        unsafe {
            std::env::set_var("THROUGHLINE_DATA_DIR", &data);
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export);
        }
        let result = open_and_migrate();
        unsafe {
            std::env::remove_var("THROUGHLINE_DATA_DIR");
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        result.expect("open_and_migrate");
        assert!(
            !export.exists(),
            "opening the DB created the export root {export:?} before any export"
        );
        std::fs::remove_dir_all(&data).ok();
    }

    /// **adr-002.** The connection must come up with `synchronous = NORMAL` (==1)
    /// so each commit pays a single fsync, while WAL stays on. Pinned so a future
    /// edit to the PRAGMA line can't silently revert to WAL's FULL (==2) default.
    #[test]
    fn open_sets_synchronous_normal_with_wal() {
        let _g = paths::lock_env_for_test();
        let conn = open_and_migrate().expect("open_and_migrate");
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1, "expected synchronous=NORMAL (1), got {}", sync);
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            journal.to_lowercase(),
            "wal",
            "WAL must stay on alongside NORMAL"
        );
    }

    /// R10-2: a command QUEUED on the DB mutex BEFORE the AppliedUnproven
    /// latch was set must still be REFUSED once it acquires — the latch is
    /// checked after acquisition, never before it.
    #[test]
    fn queued_waiter_is_refused_after_the_latch_sets() {
        let g = paths::lock_env_for_test(); // serialize latch use across tests
        crate::db::reset_relaunch_for_tests();
        let state = std::sync::Arc::new(DbState::new(Connection::open_in_memory().unwrap()));

        // The "restore command" holds the DB mutex…
        let held = state.lock().expect("pre-latch lock succeeds");
        // …while another command starts waiting on it.
        let waiter = {
            let state = std::sync::Arc::clone(&state);
            let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
            let handle = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                state.lock().map(|_guard| ())
            });
            started_rx.recv().unwrap();
            // Give the waiter time to actually enter the mutex queue. (The
            // outcome is deterministic either way: the latch check happens
            // AFTER acquisition, so a waiter that queued before OR after the
            // latch is refused identically.)
            std::thread::sleep(std::time::Duration::from_millis(50));
            handle
        };

        // The restore settles APPLIED-BUT-UNPROVEN while the waiter is queued…
        require_relaunch("Relaunch Throughline before continuing.");
        // …and only then does the restore release the mutex.
        drop(held);

        let refused = waiter.join().expect("waiter thread");
        let err = refused.expect_err("the queued waiter must be refused");
        assert!(
            format!("{err:?}").contains("Relaunch Throughline"),
            "the refusal carries the honest message: {err:?}"
        );
        crate::db::reset_relaunch_for_tests();
        drop(g);
    }

    /// R10-2 (child half): spawned by the barrier test below with
    /// TL_SECOND_LAUNCH_PROBE=1 and THROUGHLINE_DATA_DIR pointing at the
    /// parent test's directory. Under a normal sweep (no env) it is a no-op.
    #[test]
    fn second_launch_probe_child() {
        if std::env::var("TL_SECOND_LAUNCH_PROBE").is_err() {
            return;
        }
        match open_and_migrate() {
            Ok(_) => println!("PROBE-OPENED"),
            Err(e) => println!("PROBE-REFUSED: {e:#}"),
        }
    }

    /// R10-2: the TWO-PROCESS barrier. While this process holds the
    /// interprocess lock (as every launch does before any open/recovery/
    /// promotion), a second real OS process attempting the same library must
    /// be refused BEFORE opening the database — and must not create or
    /// recreate -wal/-shm sidecars beside it (mid-promotion, a foreign
    /// process recreating sidecars is exactly the WAL-replay hazard).
    #[test]
    fn second_launch_cannot_open_or_recreate_sidecars_during_promotion() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-2proc-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            // This process takes the interprocess lock the way a launch does.
            let conn = open_and_migrate().expect("first process opens");
            drop(conn); // close checkpoints + removes sidecars…
            let live = paths::db_path().unwrap();
            let wal = std::path::PathBuf::from(format!("{}-wal", live.to_string_lossy()));
            let shm = std::path::PathBuf::from(format!("{}-shm", live.to_string_lossy()));
            let _ = std::fs::remove_file(&wal);
            let _ = std::fs::remove_file(&shm);
            // …modeling the mid-promotion state: live sidecars cleared, the
            // interprocess lock still held by THIS process.

            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("db::tests::second_launch_probe_child")
                .arg("--exact")
                .arg("--nocapture")
                .env("TL_SECOND_LAUNCH_PROBE", "1")
                .env("THROUGHLINE_DATA_DIR", &data)
                .output()
                .expect("spawn the second process");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(
                stdout.contains("PROBE-REFUSED"),
                "the second process must be refused, got:\n{stdout}"
            );
            assert!(
                stdout.contains("another Throughline process"),
                "the refusal names the cause:\n{stdout}"
            );
            assert!(
                !wal.exists() && !shm.exists(),
                "the refused process must not create or recreate sidecars"
            );
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-2 (structural pin): in `run()`, the single-instance plugin must
    /// register BEFORE any database open, and the open must live INSIDE the
    /// `.setup()` hook — a secondary launch exits during plugin setup, so it
    /// must never be able to reach (and panic on) the interprocess DB lock.
    #[test]
    fn single_instance_forwarding_precedes_any_db_open() {
        let src = include_str!("lib.rs");
        let run_start = src.find("pub fn run()").expect("run() exists");
        let body = &src[run_start..];
        let single = body
            .find("tauri_plugin_single_instance::init")
            .expect("single-instance plugin registered in run()");
        let setup = body.find(".setup(").expect("setup hook exists");
        let open = body
            .find("open_db_resilient()")
            .expect("the resilient open is called from run()");
        assert!(
            single < open,
            "the single-instance plugin must register BEFORE the DB opens"
        );
        assert!(
            setup < open,
            "the DB must open INSIDE .setup() — after every plugin initialized"
        );
        // And nothing opens the DB between run()'s start and the builder.
        let builder = body.find("tauri::Builder::default()").expect("builder");
        assert!(
            open > builder,
            "no DB open may precede the Tauri builder (a secondary instance would panic before forwarding)"
        );
    }

    /// R11-2 (child half of the warm-launch test): performs EXACTLY what a
    /// secondary app instance does under tauri-plugin-single-instance on
    /// macOS — connect to the primary's socket, send `cwd \0\0 argv…`
    /// (the plugin's wire frame), and exit WITHOUT ever touching the
    /// database. No-op under a normal sweep.
    #[test]
    fn warm_launch_probe_child() {
        let Ok(socket) = std::env::var("TL_WARM_SOCKET") else {
            return;
        };
        let url = std::env::var("TL_WARM_URL").unwrap_or_default();
        use std::io::Write;
        let stream = std::os::unix::net::UnixStream::connect(&socket)
            .expect("connect to the primary instance's socket");
        let mut bf = std::io::BufWriter::new(&stream);
        let cwd = std::env::current_dir().unwrap_or_default();
        bf.write_all(cwd.to_string_lossy().as_bytes()).unwrap();
        bf.write_all(b"\0\0").unwrap();
        let args = ["throughline".to_string(), url].join("\0");
        bf.write_all(args.as_bytes()).unwrap();
        bf.flush().unwrap();
        drop(bf);
        drop(stream);
        // The REAL secondary exits(0) here, before any DB work. This probe
        // returns instead (still before any DB work) so the harness reports
        // a clean pass.
        println!("WARM-FORWARDED");
    }

    /// R11-2: warm launch. With the "first instance" holding the
    /// single-instance socket (exactly as the plugin's macOS listener does),
    /// a REAL second process performing the secondary-launch sequence
    /// forwards its `throughline://activate?…` URL over the socket and exits
    /// cleanly — without opening the database, without contending on the DB
    /// lock, without panicking. (The primary-side ordering that guarantees a
    /// real secondary exits before the DB lock is pinned structurally by
    /// `single_instance_forwarding_precedes_any_db_open`.)
    #[test]
    fn warm_launch_forwards_the_activation_url_without_touching_the_db() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-warm-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // Short path: macOS sockets cap at ~104 bytes.
        let socket = format!("/tmp/tl-warm-{}.sock", std::process::id());
        let _ = std::fs::remove_file(&socket);

        let result = std::panic::catch_unwind(|| {
            use std::io::Read;
            let listener =
                std::os::unix::net::UnixListener::bind(&socket).expect("bind primary socket");

            let url = "throughline://activate?token=WARM-TEST-1234";
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("db::tests::warm_launch_probe_child")
                .arg("--exact")
                .arg("--nocapture")
                .env("TL_WARM_SOCKET", &socket)
                .env("TL_WARM_URL", url)
                .env("THROUGHLINE_DATA_DIR", &data)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn the secondary launch");

            // The primary receives the forwarded frame…
            let (mut stream, _) = listener.accept().expect("secondary connected");
            let mut payload = String::new();
            stream.read_to_string(&mut payload).expect("read frame");
            let (_cwd, args) = payload.split_once("\0\0").expect("plugin wire frame");
            let forwarded = args.split('\0').nth(1).expect("the URL argv");
            // …and the deep-link parser extracts the activation token from it,
            // exactly as the warm-start handler would.
            assert_eq!(
                crate::parse_activate_token(forwarded).as_deref(),
                Some("WARM-TEST-1234")
            );

            let out = child.wait_with_output().expect("secondary exits");
            assert!(out.status.success(), "the secondary exits cleanly (code 0)");
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(stdout.contains("WARM-FORWARDED"), "{stdout}");
            assert!(
                !stderr.contains("panicked"),
                "the secondary must not panic: {stderr}"
            );
            // It never touched the database: its data dir was never created.
            assert!(
                !data.join("reading.db").exists() && !data.exists(),
                "the secondary must not open or create the database"
            );
        });

        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-2: the REPLACEABLE-INODE hole is closed. Exclusion rides the data
    /// DIRECTORY's inode — unlinking and recreating the old `.throughline.
    /// process-lock` file (the R10 mechanism's weak point) changes nothing: a
    /// real second process is still refused while the first proceeds as the
    /// genuine owner.
    #[test]
    fn replaced_lock_file_never_yields_exclusion_to_a_second_process() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-inode-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            let conn = open_and_migrate().expect("first process opens");
            drop(conn);
            // The attack: unlink + recreate the legacy lock-file name.
            let legacy = data.join(".throughline.process-lock");
            std::fs::write(&legacy, b"planted").unwrap();
            std::fs::remove_file(&legacy).unwrap();
            std::fs::write(&legacy, b"recreated with a fresh inode").unwrap();

            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("db::tests::second_launch_probe_child")
                .arg("--exact")
                .arg("--nocapture")
                .env("TL_SECOND_LAUNCH_PROBE", "1")
                .env("THROUGHLINE_DATA_DIR", &data)
                .output()
                .expect("spawn the second process");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(
                stdout.contains("PROBE-REFUSED"),
                "the second process must STILL be refused (dir-inode lock): {stdout}"
            );
        });

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// R11-2: alias paths are INODE-KEYED — the same directory reached
    /// through a symlink (or dot-path) is re-entrant within this process
    /// (no phantom self-contention) and still excludes a second process.
    #[cfg(unix)]
    #[test]
    fn alias_paths_share_one_lock_without_phantom_contention() {
        let g = paths::lock_env_for_test();
        let base = std::env::temp_dir().join(format!(
            "tl-alias-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let data = base.join("data");
        let alias = base.join("alias-link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&data, &alias).unwrap();

        let result = std::panic::catch_unwind(|| {
            acquire_process_lock_for(&data).expect("canonical path locks");
            acquire_process_lock_for(&alias)
                .expect("the ALIAS is re-entrant — same inode, no phantom contention");
            acquire_process_lock_for(&data.join("..").join("data")).expect("dot-path alias too");

            // A second PROCESS through the alias is still excluded.
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("db::tests::second_launch_probe_child")
                .arg("--exact")
                .arg("--nocapture")
                .env("TL_SECOND_LAUNCH_PROBE", "1")
                .env("THROUGHLINE_DATA_DIR", &alias)
                .output()
                .expect("spawn the second process");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(
                stdout.contains("PROBE-REFUSED"),
                "an alias must not bypass exclusion: {stdout}"
            );
        });

        let _ = std::fs::remove_dir_all(&base);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }
}

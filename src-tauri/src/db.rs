use anyhow::Result;
use rusqlite::Connection;
use std::sync::Mutex;

use crate::{migrations, paths};

pub struct DbState(pub Mutex<Connection>);

/// Open the SQLite database at `paths::db_path()` and run any pending
/// migrations from the `migrations` module. The full schema lives there;
/// this function is now just the connection-opening seam.
pub fn open_and_migrate() -> Result<Connection> {
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
}

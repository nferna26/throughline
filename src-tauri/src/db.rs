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
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    migrations::apply_pending(&conn)?;
    Ok(conn)
}

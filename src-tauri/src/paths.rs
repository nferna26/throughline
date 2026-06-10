use anyhow::{Context, Result};
use std::path::{Component, PathBuf};

pub fn app_support_dir() -> Result<PathBuf> {
    // Acceptance/test binaries set THROUGHLINE_DATA_DIR via `bin_guardrail::init_isolated_data_dir`
    // so they never touch the user's real Application Support directory. Production
    // (`throughline` main binary) never sets it, so it resolves to the OS path below.
    if let Ok(override_path) = std::env::var("THROUGHLINE_DATA_DIR") {
        if !override_path.trim().is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }

    // **Hard guardrail #2** (Shot 5.5): under `cfg(test)`, NEVER return the
    // production Application Support path. Unit tests that call `db::open_and_migrate()`
    // were polluting the user's real DB because the bin_guardrail only covered
    // examples/*.rs programs, not in-crate tests. Force a per-test-binary temp dir
    // so the same kind of mistake can't recur.
    #[cfg(test)]
    {
        let test_dir = std::env::temp_dir()
            .join("throughline-test")
            .join(std::process::id().to_string());
        std::fs::create_dir_all(&test_dir).context("create cfg(test) data dir")?;
        Ok(test_dir)
    }
    #[cfg(not(test))]
    {
        let home = dirs::home_dir().context("no home dir")?;
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("Throughline"))
    }
}

pub fn db_path() -> Result<PathBuf> {
    Ok(app_support_dir()?.join("reading.db"))
}

pub fn books_dir() -> Result<PathBuf> {
    Ok(app_support_dir()?.join("books"))
}

pub fn book_dir(book_id: &str) -> Result<PathBuf> {
    // Path-traversal guard: a `book_id` flows in from IPC args (read_section_*,
    // body_start_offset, read_txt_section) and is joined onto `books_dir()`. A
    // value like "../etc", "/abs/path", or "" would escape the per-book sandbox,
    // so reject anything that isn't a single Normal path component.
    if book_id.is_empty() {
        return Err(anyhow::anyhow!("invalid book_id: empty"));
    }
    let mut comps = std::path::Path::new(book_id).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(anyhow::anyhow!("invalid book_id: {book_id:?}")),
    }
    Ok(books_dir()?.join(book_id))
}

pub fn default_export_root() -> Result<PathBuf> {
    // Acceptance/test binaries set this via `bin_guardrail::init_isolated_data_dir`
    // to avoid scattering stub Markdown into the user's real GBrain folder.
    if let Ok(override_path) = std::env::var("THROUGHLINE_EXPORT_DIR") {
        if !override_path.trim().is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }
    let home = dirs::home_dir().context("no home dir")?;
    Ok(home.join("GBrain").join("Reading"))
}

/// App-private dirs only. The export tree (`~/GBrain/Reading/...` by default)
/// is deliberately NOT created here: a first launch must not plant an
/// unexplained folder in the reader's home. Export creates its dirs on demand
/// (`export::ensure_export_dirs`); the launch probe (`cmd_check_export_path`)
/// never creates either — a missing root is fine until the first export —
/// and only reader-initiated setup (`cmd_set_export_path`) creates the tree.
pub fn ensure_dirs() -> Result<()> {
    std::fs::create_dir_all(app_support_dir()?)?;
    std::fs::create_dir_all(books_dir()?)?;
    Ok(())
}

/// Atomic file write. Writes to `<dest>.tmp.<pid>.<rand>` in the same directory,
/// fsyncs the file, then renames into place. A crash anywhere before the rename
/// leaves the destination untouched. On failure, the temp file is cleaned up so
/// no `.tmp` litter is left behind.
///
/// This is the durability primitive for Throughline exports — Markdown is the
/// canonical artifact per the PRD, so a half-written export would violate the
/// "the rest of the app can die and the notes are still readable" promise.
pub fn atomic_write_string(dest: &std::path::Path, content: &str) -> Result<()> {
    use std::io::Write;
    let parent = dest
        .parent()
        .ok_or_else(|| anyhow::anyhow!("atomic_write_string: dest has no parent: {:?}", dest))?;
    std::fs::create_dir_all(parent).context("atomic_write_string: create parent dir")?;

    // Unique per-process temp path that lives next to the destination so the
    // rename is guaranteed to be same-filesystem (and therefore atomic on Unix).
    let base_name = dest.file_name().and_then(|s| s.to_str()).unwrap_or("rg");
    let tmp = parent.join(format!(
        ".{}.tmp.{}.{}",
        base_name,
        std::process::id(),
        nanos_suffix()
    ));

    let result = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create_new(true) // refuse to overwrite an existing temp — paranoia
            .write(true)
            .open(&tmp)
            .with_context(|| format!("open temp file {:?}", tmp))?;
        f.write_all(content.as_bytes())
            .with_context(|| format!("write temp file {:?}", tmp))?;
        f.sync_all()
            .with_context(|| format!("fsync temp file {:?}", tmp))?;
        drop(f);
        std::fs::rename(&tmp, dest).with_context(|| format!("rename {:?} -> {:?}", tmp, dest))?;
        Ok(())
    })();

    if result.is_err() {
        // Best-effort cleanup so we don't litter the export folder.
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn nanos_suffix() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Crate-wide mutex used by tests that mutate `THROUGHLINE_DATA_DIR` or
/// `THROUGHLINE_EXPORT_DIR`. These env vars are process-global, so concurrent
/// tests that set them will race. Any test that calls `init_isolated_data_dir`,
/// `set_var(THROUGHLINE_*)`, or `db::open_and_migrate` (which reads the dir
/// indirectly) should acquire this lock first.
///
/// We use `std::sync::Mutex` so the mutex is poison-tolerant; the helper
/// `lock_env_for_test()` recovers from poison so a panicking test doesn't
/// brick the rest of the suite.
#[cfg(test)]
pub static ENV_VAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub fn lock_env_for_test() -> std::sync::MutexGuard<'static, ()> {
    ENV_VAR_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **HARD GUARDRAIL #2 contract.** Under `cfg(test)`, `app_support_dir()`
    /// MUST return a path inside `std::env::temp_dir()` — never the user's real
    /// Application Support directory. This is the structural backstop for the
    /// "unit test writes to live DB" class of mistake that recurred after the
    /// bin_guardrail was added (the original guardrail covered only examples/).
    #[test]
    fn cfg_test_app_support_dir_is_under_temp() {
        let _g = lock_env_for_test();
        // Make sure no override is set, so we exercise the real branch.
        unsafe {
            std::env::remove_var("THROUGHLINE_DATA_DIR");
        }
        let resolved = app_support_dir().expect("app_support_dir under cfg(test)");
        let sys_temp = std::env::temp_dir();
        assert!(
            resolved.starts_with(&sys_temp),
            "cfg(test) app_support_dir() returned {:?}, NOT under temp_dir ({:?}). \
             Unit tests would be writing to the user's real DB.",
            resolved,
            sys_temp
        );
    }

    /// **Path-traversal guard.** `book_dir` joins an IPC-supplied `book_id` onto
    /// the books sandbox, so it MUST reject anything that could escape it — a
    /// `..` component, an absolute path, or an empty string — while still
    /// accepting a normal `book_<hex>` id.
    #[test]
    fn book_dir_rejects_traversal_and_absolute_and_empty() {
        for bad in ["../etc", "/abs/path", ""] {
            assert!(
                book_dir(bad).is_err(),
                "book_dir must reject path-escaping id {bad:?}"
            );
        }
        let good = "book_deadbeefcafe";
        let dir = book_dir(good).expect("normal book id must be accepted");
        assert!(
            dir.ends_with(good),
            "accepted id must resolve under books/, got {dir:?}"
        );
    }

    #[test]
    fn atomic_write_creates_file() {
        let dir = std::env::temp_dir().join(format!("tl-atomic-{}", nanos_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("note.md");
        atomic_write_string(&dest, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "hello");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_overwrites_existing_atomically() {
        let dir = std::env::temp_dir().join(format!("tl-atomic-overwrite-{}", nanos_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("note.md");
        std::fs::write(&dest, "original").unwrap();
        atomic_write_string(&dest, "updated").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "updated");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **Durability invariant**: when the rename step fails, the pre-existing
    /// destination must be untouched AND no `.tmp.*` files must be left behind.
    /// We force the failure by passing a destination path that points at a
    /// directory — `fs::rename` of a regular file onto a directory fails with
    /// `EISDIR` on Unix.
    #[test]
    fn atomic_write_failure_preserves_existing_and_cleans_up_tmp() {
        let dir = std::env::temp_dir().join(format!("tl-atomic-fail-{}", nanos_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        // Pre-existing real note next to where we'll attempt to write.
        let real_note = dir.join("real.md");
        std::fs::write(&real_note, "original content").unwrap();

        // Force a failure: try to atomic-write to a *directory* path.
        let dest_is_dir = dir.join("collides_with_dir");
        std::fs::create_dir(&dest_is_dir).unwrap();
        let result = atomic_write_string(&dest_is_dir, "would corrupt");
        assert!(result.is_err(), "rename onto a directory must error");

        // Real note is untouched.
        assert_eq!(
            std::fs::read_to_string(&real_note).unwrap(),
            "original content"
        );

        // No `.tmp.` litter left in the directory.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic_write_string left .tmp files behind after failure: {:?}",
            leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

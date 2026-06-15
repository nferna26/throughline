//! One-shot foreground handoff for updater-driven relaunches.
//!
//! `@tauri-apps/plugin-process::relaunch()` exits the current process and
//! starts a new one, so the exiting process cannot focus the new window. The
//! updater writes this marker before relaunch; the fresh process consumes it on
//! startup and focuses itself.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MARKER_FILE: &str = ".update-relaunch-focus";
const MARKER_MAX_AGE: Duration = Duration::from_secs(10 * 60);

fn marker_path() -> Result<PathBuf> {
    Ok(crate::paths::app_support_dir()?.join(MARKER_FILE))
}

pub fn prepare_update_relaunch_focus() -> Result<()> {
    write_marker_at(&marker_path()?, SystemTime::now())
}

pub fn consume_update_relaunch_focus() -> Result<bool> {
    consume_marker_at(&marker_path()?, SystemTime::now(), MARKER_MAX_AGE)
}

fn epoch_secs(t: SystemTime) -> Result<u64> {
    Ok(t.duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX_EPOCH")?
        .as_secs())
}

fn write_marker_at(path: &Path, now: SystemTime) -> Result<()> {
    crate::paths::atomic_write_string(path, &format!("{}\n", epoch_secs(now)?))
}

fn consume_marker_at(path: &Path, now: SystemTime, max_age: Duration) -> Result<bool> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e).with_context(|| format!("read update relaunch marker {:?}", path)),
    };

    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(e).with_context(|| format!("remove update relaunch marker {:?}", path));
        }
    }
    let Some(marked_at) = raw.trim().parse::<u64>().ok() else {
        return Ok(false);
    };
    let now = epoch_secs(now)?;
    Ok(marked_at <= now && now - marked_at <= max_age.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tl-relaunch-focus-{}-{}", std::process::id(), name))
    }

    #[test]
    fn missing_marker_does_not_focus_startup() {
        let path = marker("missing");
        let _ = std::fs::remove_file(&path);

        let should_focus =
            consume_marker_at(&path, UNIX_EPOCH + Duration::from_secs(100), MARKER_MAX_AGE)
                .expect("consume missing marker");

        assert!(!should_focus);
    }

    #[test]
    fn fresh_marker_is_consumed_once() {
        let path = marker("fresh");
        let _ = std::fs::remove_file(&path);
        write_marker_at(&path, UNIX_EPOCH + Duration::from_secs(100)).expect("write marker");

        let should_focus =
            consume_marker_at(&path, UNIX_EPOCH + Duration::from_secs(101), MARKER_MAX_AGE)
                .expect("consume fresh marker");

        assert!(should_focus);
        assert!(!path.exists(), "marker must be one-shot");

        let second =
            consume_marker_at(&path, UNIX_EPOCH + Duration::from_secs(102), MARKER_MAX_AGE)
                .expect("consume second time");
        assert!(!second);
    }

    #[test]
    fn stale_or_invalid_marker_is_consumed_without_focus() {
        let stale = marker("stale");
        let invalid = marker("invalid");
        let _ = std::fs::remove_file(&stale);
        let _ = std::fs::remove_file(&invalid);
        write_marker_at(&stale, UNIX_EPOCH + Duration::from_secs(100)).expect("write stale");
        std::fs::write(&invalid, "not-a-timestamp").expect("write invalid");

        let should_focus = consume_marker_at(
            &stale,
            UNIX_EPOCH + Duration::from_secs(1000),
            MARKER_MAX_AGE,
        )
        .expect("consume stale marker");
        assert!(!should_focus);
        assert!(!stale.exists(), "stale marker must not linger");

        let should_focus = consume_marker_at(
            &invalid,
            UNIX_EPOCH + Duration::from_secs(1000),
            MARKER_MAX_AGE,
        )
        .expect("consume invalid marker");
        assert!(!should_focus);
        assert!(!invalid.exists(), "invalid marker must not linger");
    }
}

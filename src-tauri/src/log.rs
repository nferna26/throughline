//! Structured logging via the `tracing` ecosystem.
//!
//! Replaces the Shot-5 hand-rolled JSONL writer. Two layers:
//!
//!   1. **Macros**. Anywhere in the code base, use `tracing::info!` /
//!      `tracing::warn!` / etc. with key=value fields. The subscriber set up
//!      in [`init()`] formats every event as JSON and appends one line to
//!      `{app_support_dir}/logs/app.log.YYYY-MM-DD` (daily rolling; files
//!      older than [`KEEP_DAYS`] are pruned on init so the logs dir stays
//!      bounded on a long-lived install).
//!   2. **Convenience wrappers**. The pre-existing `log_ai_call`,
//!      `log_import`, and `log_export` functions are kept as thin wrappers
//!      so the command modules don't have to know the macro spelling. New
//!      code can call them OR use `tracing::info!` directly.
//!
//! Failure semantics: if the appender can't open the log file, the subscriber
//! falls back to no-op. Logging never blocks or panics the user flow.
//!
//! All log output stays on this machine — no telemetry. The "no remote calls
//! by default" non-goal from CLAUDE.md still binds.

use tracing::info;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::paths;

/// Holds the appender's background writer thread alive for the program's
/// lifetime. Dropping this guard flushes pending log lines.
static GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();
static INIT: std::sync::Once = std::sync::Once::new();

/// Initialize the global tracing subscriber. Idempotent; safe to call from
/// `run()` or from tests. On failure (e.g. can't create the log directory)
/// silently installs a no-op subscriber so the app keeps working.
pub fn init() {
    INIT.call_once(|| {
        let dir = match paths::app_support_dir() {
            Ok(d) => d.join("logs"),
            Err(_) => return,
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        prune_old_logs(&dir, KEEP_DAYS);
        let appender = tracing_appender::rolling::daily(&dir, "app.log");
        let (nb, guard) = tracing_appender::non_blocking(appender);
        let _ = GUARD.set(guard);

        // RUST_LOG=trace, RUST_LOG=info,throughline_lib=debug, etc., are honored.
        let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().json().with_writer(nb))
            .try_init();
    });
}

/// How many days of rolled `app.log.YYYY-MM-DD` files to keep on disk.
const KEEP_DAYS: u32 = 14;

/// Retention sweep for the daily-rolled log files. Removes `app.log.YYYY-MM-DD`
/// files dated before `keep_days` ago (UTC — matching the appender's roll
/// date); anything that doesn't parse as that exact pattern is left alone.
/// Best-effort: a failure to read the dir or remove a file is ignored —
/// logging hygiene must never block the user flow.
fn prune_old_logs(dir: &std::path::Path, keep_days: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = chrono::Utc::now().date_naive() - chrono::Duration::days(i64::from(keep_days));
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(date) = name.to_str().and_then(|n| n.strip_prefix("app.log.")) else {
            continue;
        };
        let Ok(date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
            continue;
        };
        if date < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ── Convenience wrappers (kept stable for existing call sites) ────────

/// Log an AI chat completion call (request + outcome).
pub fn log_ai_call(
    mode: &str,
    locator: Option<&str>,
    context_char_count: usize,
    provider_host: &str,
    latency_ms: u128,
    status: &str,
) {
    info!(
        category = "ai_call",
        mode = mode,
        locator = locator,
        context_char_count = context_char_count,
        provider = provider_host,
        latency_ms = latency_ms as u64,
        status = status,
        "ai_call"
    );
}

/// Log a successful book import.
pub fn log_import(
    book_id: &str,
    title: &str,
    source_type: &str,
    section_count: usize,
    sha256: &str,
) {
    info!(
        category = "import",
        book_id = book_id,
        title = title,
        source_type = source_type,
        sections = section_count,
        sha256_prefix = &sha256.chars().take(16).collect::<String>()[..],
        "book imported"
    );
}

/// Log a Markdown export.
pub fn log_export(kind: &str, path: &str) {
    info!(
        category = "export",
        kind = kind,
        path = path,
        "export written"
    );
}

/// Log a phrase batch outcome — counts and statuses only, never slice text
/// (invariant 1: usage, never content). `status` is ok / rate_limited /
/// cap_hit / auth / transient.
pub fn log_phrases(status: &str, provider: &str, requested: usize, stored: usize) {
    info!(
        category = "phrases",
        status = status,
        provider = provider,
        requested = requested,
        stored = stored,
        "phrase batch"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: init() is idempotent and the macros don't panic.
    /// We don't assert on file contents because the non-blocking writer runs
    /// in a background thread and flushes on drop; that's hard to make
    /// deterministic in a unit test. Production code reads the file in
    /// real-world conditions, which is the meaningful test.
    #[test]
    fn init_is_idempotent_and_macros_dont_panic() {
        let _g = paths::lock_env_for_test();
        // First call.
        init();
        // Convenience macros land cleanly even with no subscriber initialized.
        log_ai_call("explain", Some("char:42"), 60, "localhost:1234", 1234, "ok");
        log_import("book_x", "Some Title", "epub", 30, "abc123def456");
        log_export("note", "/tmp/some/path/note.md");
        // Repeated init: must NOT panic.
        init();
        init();
        info!(category = "test", k = "v", "smoke");
    }

    /// app.log must not grow without bound: the appender rolls daily, so the
    /// logs dir may only ever contain `app.log.YYYY-MM-DD` files — never a
    /// bare, grow-forever `app.log`. TOLERANT by design (see the smoke test):
    /// the non-blocking writer flushes in a background thread, so we assert
    /// nothing about contents or that a file exists yet — only that whatever
    /// IS present matches the daily-rolled pattern.
    #[test]
    fn log_files_roll_daily() {
        let _g = paths::lock_env_for_test();
        unsafe {
            std::env::remove_var("THROUGHLINE_DATA_DIR");
        }
        init();
        info!(category = "test", "daily-roll probe");
        let logs = paths::app_support_dir().unwrap().join("logs");
        let names: Vec<String> = std::fs::read_dir(&logs)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let is_daily = |n: &str| {
            n.strip_prefix("app.log.").is_some_and(|d| {
                d.len() == 10
                    && d.chars().enumerate().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            c == '-'
                        } else {
                            c.is_ascii_digit()
                        }
                    })
            })
        };
        assert!(
            names.iter().all(|n| is_daily(n)),
            "logs dir contains non-daily-rolled files (unbounded growth): {names:?}"
        );
    }

    /// Retention sweep: `prune_old_logs` removes `app.log.YYYY-MM-DD` files
    /// dated before the keep window and never touches anything else — not a
    /// bare `app.log`, not unrelated files, not unparseable suffixes. Fully
    /// deterministic: the cutoff is UTC-date arithmetic, no host timezone.
    #[test]
    fn prune_old_logs_removes_only_old_dated_files() {
        let dir = std::env::temp_dir().join(format!("tl-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let today = chrono::Utc::now().date_naive();
        let recent = dir.join(format!("app.log.{}", today.format("%Y-%m-%d")));
        let old = dir.join("app.log.2020-01-01");
        let bare = dir.join("app.log");
        let unrelated = dir.join("notes.txt");
        let unparseable = dir.join("app.log.not-a-date");
        for f in [&recent, &old, &bare, &unrelated, &unparseable] {
            std::fs::write(f, "x").unwrap();
        }
        prune_old_logs(&dir, 14);
        assert!(!old.exists(), "a file older than the keep window must go");
        assert!(recent.exists(), "today's file must stay");
        assert!(bare.exists(), "non-dated filenames are never touched");
        assert!(unrelated.exists(), "unrelated files are never touched");
        assert!(
            unparseable.exists(),
            "unparseable suffixes are never touched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

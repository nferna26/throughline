//! Structured logging via the `tracing` ecosystem.
//!
//! Replaces the Shot-5 hand-rolled JSONL writer. Two layers:
//!
//!   1. **Macros**. Anywhere in the code base, use `tracing::info!` /
//!      `tracing::warn!` / etc. with key=value fields. The subscriber set up
//!      in [`init()`] formats every event as JSON and appends one line to
//!      `{app_support_dir}/logs/app.log`.
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
        let appender = tracing_appender::rolling::never(&dir, "app.log");
        let (nb, guard) = tracing_appender::non_blocking(appender);
        let _ = GUARD.set(guard);

        // RUST_LOG=trace, RUST_LOG=info,reading_gym_lib=debug, etc., are honored.
        let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().json().with_writer(nb))
            .try_init();
    });
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
}

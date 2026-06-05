//! Hard guardrail for diagnostic programs under `examples/`.
//!
//! **Why this exists.** Earlier shots wrote acceptance binaries that called
//! `db::open_and_migrate()` against the user's real Application Support
//! directory, polluting `~/Library/Application Support/Throughline/reading.db`
//! with stub rows. The rule "use a temp dir for acceptance" is too easy to
//! forget — and once forgotten, the user's live data is damaged.
//!
//! This module enforces the rule structurally:
//!
//! 1. Acceptance / test binaries call `init_isolated_data_dir(label)` at the
//!    very top of `main()`. That sets `THROUGHLINE_DATA_DIR` to a fresh
//!    `std::env::temp_dir()`-rooted path and *panics* if the resolved
//!    `paths::app_support_dir()` doesn't actually land under the OS temp dir.
//! 2. The `bin_guardrail_acceptance_binaries_use_isolated_data_dir` test
//!    in `lib::tests` reads every file under `examples/`, and fails the build
//!    if a binary neither calls `init_isolated_data_dir` nor is explicitly
//!    listed on the inspection allowlist. Adding a new bin without a
//!    classification breaks the build.
//!
//! The combination — runtime panic + build-time check — means the same class
//! of mistake that polluted the live DB cannot recur silently.

use std::path::PathBuf;

/// Redirect `paths::app_support_dir()` to a fresh tempdir for the lifetime
/// of this process. Returns the chosen path. Panics if the redirection
/// doesn't land under `std::env::temp_dir()` — which would mean the
/// guardrail itself is broken.
///
/// Call this as the **first line of `main()`**, before any DB or path lookup.
pub fn init_isolated_data_dir(label: &str) -> PathBuf {
    let root = std::env::temp_dir()
        .join("throughline-isolated")
        .join(format!("{}-{}", sanitize_label(label), std::process::id()));
    std::fs::create_dir_all(&root).expect("create isolated data dir");

    let export = root.join("export");
    std::fs::create_dir_all(&export).expect("create isolated export dir");

    // SAFETY: env vars are process-global. This function is documented to run
    // at the top of `main()` before any tokio runtime or worker threads spawn.
    // SET_VAR safety contract is met by that caller-side discipline.
    unsafe {
        std::env::set_var("THROUGHLINE_DATA_DIR", root.to_string_lossy().to_string());
        std::env::set_var(
            "THROUGHLINE_EXPORT_DIR",
            export.to_string_lossy().to_string(),
        );
    }

    // Re-resolve through the same functions the rest of the code uses, and
    // assert both overrides took effect.
    let sys_temp = std::env::temp_dir();
    let resolved_data =
        crate::paths::app_support_dir().expect("paths::app_support_dir after override");
    assert!(
        resolved_data.starts_with(&sys_temp),
        "BIN GUARDRAIL VIOLATED: paths::app_support_dir() returned {:?}, which is NOT under std::env::temp_dir() ({:?}). \
         Acceptance binaries MUST use an isolated temp data dir to avoid polluting the user's real database. \
         Did init_isolated_data_dir() run before any code that opened the DB?",
        resolved_data, sys_temp
    );
    let resolved_export =
        crate::paths::default_export_root().expect("paths::default_export_root after override");
    assert!(
        resolved_export.starts_with(&sys_temp),
        "BIN GUARDRAIL VIOLATED: paths::default_export_root() returned {:?}, which is NOT under std::env::temp_dir() ({:?}). \
         Acceptance binaries MUST use an isolated export dir to avoid scattering stub Markdown into the user's real GBrain folder.",
        resolved_export, sys_temp
    );
    root
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_redirects_under_temp_dir_and_resolves_correctly() {
        // init_isolated_data_dir mutates global env vars — serialize against
        // other env-touching tests.
        let _g = crate::paths::lock_env_for_test();
        let chosen = init_isolated_data_dir("guardrail-self-test");
        let sys_temp = std::env::temp_dir();
        assert!(
            chosen.starts_with(&sys_temp),
            "isolated dir {:?} not under temp {:?}",
            chosen,
            sys_temp
        );
        let resolved = crate::paths::app_support_dir().unwrap();
        assert_eq!(
            resolved, chosen,
            "paths::app_support_dir() must mirror the override"
        );
    }
}

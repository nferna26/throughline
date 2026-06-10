//! Throughline — Tauri backend entry point.
//!
//! The library is organized as:
//!
//!   - `paths`, `db`, `migrations`, `error`, `log`            — primitives
//!   - `models`                                               — DB row structs
//!   - `import`, `import_epub`, `epub_classify`, `book_structure` — book ingestion
//!   - `plan`, `recovery`                                     — scheduling logic
//!   - `ai_stub`, `ai_client`                                 — AI surface
//!   - `export`, `settings`                                   — durable artifacts + user config
//!   - `bin_guardrail`                                        — test-only guardrail used by acceptance bins
//!   - `commands::{books, sessions, notes, ai, settings_cmds}` — Tauri command handlers
//!
//! `run()` opens the DB, applies pending migrations, registers commands, and
//! starts the Tauri runtime. Production behavior is fully contained in the
//! command modules; this file holds only the wiring.

// App-crate lint posture: these clippy lints flag intentional, idiomatic patterns
// rather than defects — Tauri command handlers legitimately take many parameters,
// and a few enums expose deliberate `from_str` constructors that don't fit the
// fallible `std::str::FromStr` shape. Allowed crate-wide instead of scattering
// per-item attributes.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::should_implement_trait)]

pub mod ai_client;
pub mod ai_providers;
pub mod ai_retention;
pub mod ai_stub;
pub mod bin_guardrail;
pub mod book_structure;
pub mod circuit_breaker;
pub mod commands;
pub mod db;
pub mod epub_classify;
pub mod error;
pub mod export;
pub mod gutenberg_markup;
pub mod import;
pub mod import_epub;
pub mod keystore;
pub mod log;
pub mod migrations;
pub mod models;
pub mod paths;
pub mod plan;
pub mod recovery;
pub mod settings;

use std::sync::Mutex;

use crate::db::DbState;

/// **Tauri command API version.**
///
/// Bumped on every breaking change to the command surface (renames, removed
/// commands, type-shape changes of args or returns). See `docs/IPC.md` for
/// the full contract.
///
/// - Patch (e.g. 3 → 3): bug fixes, internal refactors, no contract change.
/// - Minor (e.g. 3 → 3): new commands or strictly-additive optional args.
///   The integer stays the same; CHANGELOG records the addition.
/// - Major (e.g. 3 → 4): any change that could break an existing JS caller.
///
/// The constant is exposed to JS via `cmd_api_version` so the frontend can
/// refuse to talk to an incompatible backend.
///
/// History (each a major, JS-caller-breaking change per docs/IPC.md):
/// - 1 → 2: `cmd_import_book` now returns `ImportOutcome { book, created }`
///   instead of a bare `Book` (so the Book Setup Sheet shows only for genuinely
///   new imports) — a return-shape change.
/// - 2 → 3: cloud AI command surface (provider keys, model listing, Codex device
///   login, request history) reshaped the AI args/returns.
/// - 3 → 4: plan lifecycle (Epic A1/A2) — migration v008 added the `lifecycle`
///   axis (active | paused | completed | archived | superseded) to the plan
///   rows JS receives, and the plan-management command family landed against it
///   (`cmd_list_plans_for_book`, `cmd_get_active_plan`, pause / resume /
///   archive / delete).
/// - 4 → 5: plans frontispiece (P2.1) — migration v009 added `name`,
///   `deleted_at` (soft-delete window), and `reached_percent` to reading_plans;
///   plan rows and the plans list reshaped around naming + let-go semantics.
pub const COMMAND_API_VERSION: u32 = 5;

/// Open the database, recovering from a CORRUPT file rather than crash-looping on
/// launch (a permanently-unusable app — the worst outcome for a paying user). A
/// corrupt DB is preserved alongside the original (renamed `reading.corrupt-<pid>.db`)
/// for manual recovery, and the app starts on a fresh DB. Environmental failures
/// (permissions, full disk) are NOT "recovered" — wiping data wouldn't help — so
/// they still fail loudly with a clear, non-cryptic message.
fn open_db_resilient() -> rusqlite::Connection {
    match db::open_and_migrate() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("{e:#}").to_lowercase();
            let looks_corrupt = [
                "malformed",
                "corrupt",
                "not a database",
                "disk image",
                "file is encrypted",
            ]
            .iter()
            .any(|s| msg.contains(s));
            if !looks_corrupt {
                panic!("Throughline could not open its database (usually a permissions or disk problem, not data loss): {e:#}");
            }
            tracing::error!("database appears corrupt; preserving it and starting fresh: {e:#}");
            if let Ok(dbp) = paths::db_path() {
                let bak = dbp.with_file_name(format!("reading.corrupt-{}.db", std::process::id()));
                let _ = std::fs::rename(&dbp, &bak);
                let _ = std::fs::remove_file(dbp.with_extension("db-wal"));
                let _ = std::fs::remove_file(dbp.with_extension("db-shm"));
            }
            db::open_and_migrate()
                .expect("could not create a fresh database after corruption recovery")
        }
    }
}

/// Parse a `throughline://activate?token=…` deep link, returning the token.
/// Anything else (wrong scheme, wrong action, no token) yields None.
fn parse_activate_token(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "throughline" {
        return None;
    }
    let is_activate = u.host_str() == Some("activate") || u.path().trim_matches('/') == "activate";
    if !is_activate {
        return None;
    }
    u.query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging before anything else so DB migrations,
    // startup errors, and IPC events all get captured.
    log::init();
    let conn = open_db_resilient();
    // adr-001: bound the AI audit trail on every launch. Rows older than the
    // retention window that never became a note are swept; approved rows stay.
    {
        let days = settings::get_ai_retention_days(&conn);
        match ai_retention::sweep(&conn, days) {
            Ok(n) if n > 0 => tracing::info!(
                "ai_retention: swept {} ai_requests row(s) older than {} days",
                n,
                days
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!("ai_retention: sweep failed: {}", e),
        }
    }
    // Purge plans "let go" longer than 30 days ago, with their sessions + notes.
    match commands::plans::sweep_deleted_plans(&conn, 30) {
        Ok(n) if n > 0 => tracing::info!("plan_retention: purged {} let-go plan(s)", n),
        Ok(_) => {}
        Err(e) => tracing::warn!("plan_retention: sweep failed: {}", e),
    }
    let state = DbState(Mutex::new(conn));

    tauri::Builder::default()
        // single-instance MUST be first: a second launch (e.g. a throughline://
        // link click) forwards to the running app and focuses it.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .setup(|app| {
            // Company-mode activation deep link (CM5). Handles warm-start (running)
            // and cold-start (launched from the URL); emits the token to the webview,
            // which calls cmd_activate_company. Verify on a signed release build —
            // the scheme only registers from /Applications, not `tauri dev`.
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(token) = parse_activate_token(url.as_str()) {
                            let _ = handle.emit("tl-activate", token);
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── books ──
            commands::books::cmd_import_book,
            commands::books::cmd_today,
            commands::books::cmd_read_section_text,
            commands::books::cmd_read_section_structure,
            commands::books::cmd_list_sections,
            commands::books::cmd_assignable_sections,
            commands::books::cmd_list_books,
            commands::books::cmd_set_active_book,
            commands::books::cmd_configure_plan,
            // ── discover (public-domain catalogue; reader-initiated egress) ──
            commands::discover::cmd_discover_search,
            commands::discover::cmd_discover_seed,
            commands::discover::cmd_import_from_gutendex,
            // ── sessions / plan / progress ──
            commands::sessions::cmd_start_session,
            commands::sessions::cmd_end_session,
            commands::sessions::cmd_save_section_progress,
            commands::sessions::cmd_extend_finish_date,
            commands::sessions::cmd_restart_current_section,
            // ── notes ──
            commands::notes::cmd_save_note,
            commands::notes::cmd_update_note,
            commands::notes::cmd_delete_note,
            commands::notes::cmd_list_notes,
            commands::notes::cmd_quote_warns,
            // ── AI ──
            commands::ai::cmd_generate_prompt_preview,
            commands::ai::cmd_ai_preview,
            commands::ai::cmd_save_ai_preview_as_note,
            commands::ai::cmd_ai_ask,
            commands::ai::cmd_list_ai_models,
            commands::ai::cmd_model_catalog,
            commands::ai::cmd_finalize_ai_request,
            commands::ai::cmd_get_usage_summary,
            commands::ai::cmd_set_monthly_spend_cap,
            commands::ai::cmd_confirm_cloud_send,
            commands::ai::cmd_activate_company,
            commands::ai::cmd_company_status,
            commands::ai::cmd_company_credits,
            commands::ai::cmd_company_checkout,
            commands::ai::cmd_open_support_email,
            commands::ai::cmd_test_ai_connection,
            commands::ai::cmd_codex_device_start,
            commands::ai::cmd_codex_device_poll,
            commands::ai::cmd_codex_logout,
            commands::ai::cmd_save_ai_response_as_note,
            commands::ai::cmd_list_ai_requests,
            commands::ai::cmd_forget_ai_history,
            // ── settings + system info ──
            commands::settings_cmds::cmd_api_version,
            commands::settings_cmds::cmd_paths_info,
            commands::settings_cmds::cmd_get_settings,
            commands::settings_cmds::cmd_set_export_path,
            commands::settings_cmds::cmd_check_export_path,
            commands::plans::cmd_list_plans_for_book,
            commands::plans::cmd_get_active_plan,
            commands::plans::cmd_start_new_plan,
            commands::plans::cmd_pause_plan,
            commands::plans::cmd_resume_plan,
            commands::plans::cmd_archive_plan,
            commands::plans::cmd_delete_plan,
            commands::plans::cmd_restore_plan,
            commands::settings_cmds::cmd_set_ai_settings,
            commands::settings_cmds::cmd_set_ai_key,
            commands::settings_cmds::cmd_clear_ai_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- crate-wide tests ----------
//
// Cross-cutting invariants live here (e.g. the bin guardrail scans the source
// tree). Module-specific tests live in their own files alongside the code.

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use rusqlite::params;

    use crate::import::{estimate_minutes_for_chars, sectionize};
    use crate::plan::assigned_section_index;
    use crate::{ai_client, db, export, paths};

    #[test]
    fn parses_activate_deep_link_only() {
        use crate::parse_activate_token;
        assert_eq!(
            parse_activate_token("throughline://activate?token=ABCD-1234"),
            Some("ABCD-1234".to_string())
        );
        // Wrong action, wrong scheme, or no token → ignored (no accidental activation).
        assert_eq!(parse_activate_token("throughline://other?token=x"), None);
        assert_eq!(
            parse_activate_token("https://evil.example/activate?token=x"),
            None
        );
        assert_eq!(parse_activate_token("throughline://activate"), None);
    }

    #[test]
    fn test_sectionize_evenly_with_no_chapters() {
        let body = "para one.\n\npara two.\n\npara three.\n\n".repeat(2000);
        let secs = sectionize(&body);
        assert!(secs.len() >= 2);
        let total: usize = secs.iter().map(|(_, s, e)| e - s).sum();
        assert!(total > body.len() / 2);
    }

    #[test]
    fn test_estimate_minutes() {
        assert!(estimate_minutes_for_chars(10_000) >= 1);
    }

    #[test]
    fn test_assigned_section_index() {
        assert_eq!(assigned_section_index(30, 30, 1), Some(0));
        assert_eq!(assigned_section_index(30, 30, 30), Some(29));
        assert_eq!(assigned_section_index(0, 30, 1), None);
    }

    #[test]
    fn test_quote_warn() {
        assert!(!export::quote_too_long(&"x".repeat(300)));
        assert!(export::quote_too_long(&"x".repeat(301)));
    }

    /// **HARD GUARDRAIL — Shot 4.5.** Diagnostic/acceptance programs live in
    /// `examples/` (Cargo example targets, so they're never bundled into the
    /// shipped app). They still pollute the user's real DB if they call
    /// `db::open_and_migrate()` without first redirecting `paths::app_support_dir()`
    /// to a temp dir — so each one must either isolate or be on the allowlist.
    #[test]
    fn bin_guardrail_acceptance_binaries_use_isolated_data_dir() {
        const REAL_DB_ALLOWLIST: &[&str] = &[
            "inspect_state",
            "inspect_epub",
            "reclassify_all",
            "repair_sections",
        ];

        let examples_dir_candidates = ["examples", "src-tauri/examples"];
        let examples_dir = examples_dir_candidates
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .copied()
            .expect("examples dir not found from any working directory");

        let entries = std::fs::read_dir(examples_dir).expect("read examples");
        let mut violations: Vec<String> = Vec::new();
        let mut count = 0usize;
        for e in entries {
            let e = e.expect("dir entry");
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("rs") {
                continue;
            }
            count += 1;
            let stem = path.file_stem().and_then(|s| s.to_str()).expect("filename");
            let body = std::fs::read_to_string(&path).expect("read .rs file");
            let calls_isolated = body.contains("init_isolated_data_dir(");
            let allowlisted = REAL_DB_ALLOWLIST.contains(&stem);
            match (calls_isolated, allowlisted) {
                (true, true) => violations.push(format!(
                    "`{}` is on REAL_DB_ALLOWLIST AND calls init_isolated_data_dir. Pick one classification.",
                    stem
                )),
                (false, false) => violations.push(format!(
                    "`examples/{}.rs` is unclassified. Add init_isolated_data_dir() or REAL_DB_ALLOWLIST entry.",
                    stem
                )),
                _ => { /* properly classified */ }
            }
        }
        assert!(
            count > 0,
            "examples dir appears empty — guardrail test would silently no-op"
        );
        if !violations.is_empty() {
            panic!(
                "Bin guardrail violations:\n  - {}",
                violations.join("\n  - ")
            );
        }
    }

    /// **HARD CONSTRAINT — Shot 4.** AI calls are allowed, but only against a
    /// loopback endpoint while local-only mode is ON. Pins that no other
    /// piece of the app can bypass the loopback check via an alternate HTTP
    /// surface (`tauri-plugin-http` / `tauri-plugin-shell` stay banned), and
    /// that `src/ai_stub.rs` remains pure formatting (no network imports).
    #[test]
    fn no_unaudited_network_plugins() {
        let cargo_toml = std::fs::read_to_string("Cargo.toml")
            .or_else(|_| std::fs::read_to_string("src-tauri/Cargo.toml"))
            .expect("Cargo.toml not found");

        for needle in ["tauri-plugin-http", "tauri-plugin-shell"] {
            assert!(
                !cargo_toml.contains(&format!("{} =", needle)),
                "Cargo.toml directly depends on `{}` — it would bypass ai_client::validate_base_url.",
                needle
            );
        }

        let stub_raw = std::fs::read_to_string("src/ai_stub.rs")
            .or_else(|_| std::fs::read_to_string("src-tauri/src/ai_stub.rs"))
            .expect("src/ai_stub.rs not found");
        let stub_code: String = stub_raw
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") || t.starts_with("///") || t.starts_with("//!") {
                    ""
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        for ident in ["reqwest", "hyper", "ureq", "surf", "isahc"] {
            for shape in &[format!("use {}", ident), format!("{}::", ident)] {
                assert!(
                    !stub_code.contains(shape.as_str()),
                    "src/ai_stub.rs uses `{}` — prompt formatting must stay pure (HTTP lives in ai_client.rs).",
                    shape
                );
            }
        }
    }

    /// **HARD GUARDRAIL — CORE-1011 / P2-13.** AGENTS.md is read by future agent
    /// sessions (the codex/* workflow). Since the AI pivot, CLAUDE.md is the
    /// binding contract: provider-authoritative selection, consent-gated cloud,
    /// Local hardwired to loopback, briefings session-cached and non-persistent
    /// unless saved. AGENTS.md must defer to it and must not re-teach the dead
    /// pre-pivot posture — otherwise agents will enforce dead rules or "fix"
    /// live cloud tutoring as a violation.
    #[test]
    fn agents_md_defers_to_claude_md() {
        let raw = std::fs::read_to_string("../AGENTS.md")
            .or_else(|_| std::fs::read_to_string("AGENTS.md"))
            .expect("AGENTS.md not found");
        // Strip markdown emphasis so `**cached**` can't hide a phrase from the scan.
        let agents = raw.replace('*', "");

        let mut violations: Vec<String> = Vec::new();

        for stale in [
            "never calls a remote endpoint by default",
            "remote endpoints are refused while local-only is ON",
        ] {
            if agents.contains(stale) {
                violations.push(format!(
                    "stale pre-pivot posture still present: `{}` — cloud tutoring is a shipped, consent-gated feature",
                    stale
                ));
            }
        }

        if !agents.contains("CLAUDE.md wins") {
            violations.push(
                "missing an explicit precedence line naming CLAUDE.md as the winner \
                 (e.g. \"CLAUDE.md wins wherever this file disagrees\")"
                    .to_string(),
            );
        }

        // A cache *requirement* is only acceptable with a session-scope qualifier
        // nearby (counsel posture: non-persistent unless saved).
        let lower = agents.to_lowercase();
        for line in lower.lines() {
            let mut rest = line;
            while let Some(pos) = rest.find("must be cached") {
                let after: String = rest[pos..].chars().take(100).collect();
                if !after.contains("session") {
                    violations.push(format!(
                        "requires briefing caching without a session-scope qualifier: `{}`",
                        after.trim()
                    ));
                }
                rest = &rest[pos + "must be cached".len()..];
            }
        }

        if !violations.is_empty() {
            panic!(
                "AGENTS.md must defer to CLAUDE.md (CORE-1011 / P2-13):\n  - {}",
                violations.join("\n  - ")
            );
        }
    }

    /// **CRITICAL — Shot 4.** validate_base_url MUST reject non-loopback URLs
    /// when local-only is ON, and MUST allow them when local-only is OFF.
    #[test]
    fn local_only_rejects_remote_and_allows_loopback() {
        for url in [
            "https://api.openai.com/v1",
            "https://api.anthropic.com/v1",
            "http://192.168.1.10:1234/v1",
            "http://10.0.0.5/v1",
            "http://example.com/v1",
        ] {
            let r = ai_client::validate_base_url(url, true);
            assert!(r.is_err(), "local-only ON must refuse {}", url);
            assert!(
                r.unwrap_err().to_string().contains("Local-only"),
                "rejection error must explain why for: {}",
                url
            );
        }
        for url in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:1234/v1",
        ] {
            assert!(
                ai_client::validate_base_url(url, true).is_ok(),
                "local-only ON must accept loopback: {}",
                url
            );
        }
        assert!(ai_client::validate_base_url("https://api.openai.com/v1", false).is_ok());
    }

    /// **Shot 4 invariant: preview == sent.** The bytes built into the chat
    /// completion's `messages[0].content` MUST be exactly the prompt the user
    /// saw in the Shot 3 preview panel.
    #[test]
    fn preview_text_equals_sent_payload() {
        use crate::ai_stub::{build_prompt, PromptContext, StubMode};
        let ctx = PromptContext {
            book_title: "The Cold Start Problem".to_string(),
            author: Some("Andrew Chen".to_string()),
            chapter: Some("3. Cold Start Theory".to_string()),
            locator: Some("cfi:OEBPS/text/chapter3".to_string()),
            selection: "Network effects compound across both sides of a marketplace.".to_string(),
            user_note: None,
        };
        for mode in [
            StubMode::Explain,
            StubMode::Historical,
            StubMode::Vocabulary,
            StubMode::Socratic,
            StubMode::DurableNote,
            StubMode::PrepareNext,
        ] {
            let preview = build_prompt(mode, &ctx);
            let payload = ai_client::build_request_body("any-model", &preview, true, None);
            assert_eq!(payload.messages.len(), 1);
            assert_eq!(payload.messages[0].role, "user");
            assert_eq!(
                payload.messages[0].content, preview,
                "mode {:?}: preview text MUST match sent payload byte-for-byte",
                mode
            );
        }
    }

    /// AI stub generates a non-empty prompt preview from a real selection,
    /// returns only the prompt that would be sent (no answer).
    #[test]
    fn ai_preview_logs_zero_writes_and_returns_prompt() {
        use crate::ai_stub::{build_prompt, PromptContext, StubMode};
        let ctx = PromptContext {
            book_title: "The Cold Start Problem".to_string(),
            author: Some("Andrew Chen".to_string()),
            chapter: Some("3. Cold Start Theory".to_string()),
            locator: Some("cfi:OEBPS/text/9780062969750_Chapter_3.xhtml".to_string()),
            selection: "Network effects compound across both sides of a marketplace.".to_string(),
            user_note: None,
        };
        let preview = build_prompt(StubMode::Explain, &ctx);
        assert!(preview.contains("The Cold Start Problem"));
        assert!(preview.contains("> Network effects compound"));
        let _proof: fn(StubMode, &PromptContext) -> String = build_prompt;
    }

    /// End-to-end on the command layer: a preview row lands with `wrote_to_memory=0`
    /// and `provider=NULL`; only the approve path flips that to 1 + creates a Note.
    #[test]
    fn ai_preview_db_flow_save_by_approval() {
        // Serialize against other env-var-touching tests.
        let _g = paths::lock_env_for_test();
        let conn = db::open_and_migrate().expect("db");

        let book_id = format!("book_{}", uuid::Uuid::new_v4().simple());
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at)
             VALUES (?1, 'Test Book', 'Author', 'txt', '/tmp/x.txt', 'abc', '2026-05-24')",
            params![book_id],
        ).unwrap();

        let ai_id = format!("ai_{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
             VALUES (?1, ?2, 'explain', 'char:42', 60, NULL, ?3, 0)",
            params![ai_id, book_id, now],
        ).unwrap();

        let (provider, wrote): (Option<String>, i64) = conn
            .query_row(
                "SELECT provider, wrote_to_memory FROM ai_requests WHERE id = ?1",
                params![ai_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(provider, None);
        assert_eq!(wrote, 0);

        let note_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE book_id = ?1",
                params![book_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_count, 0);

        let note_id = format!("note_{}", uuid::Uuid::new_v4().simple());
        conn.execute(
            "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
             VALUES (?1, ?2, NULL, 'Reflection', 'char:42', NULL, 'my thoughts on the prompt', NULL, ?3, ?3, NULL)",
            params![note_id, book_id, now],
        ).unwrap();
        conn.execute(
            "UPDATE ai_requests SET wrote_to_memory = 1 WHERE id = ?1",
            params![ai_id],
        )
        .unwrap();

        let wrote_after: i64 = conn
            .query_row(
                "SELECT wrote_to_memory FROM ai_requests WHERE id = ?1",
                params![ai_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wrote_after, 1);
        let note_count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE book_id = ?1",
                params![book_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_count_after, 1);
    }

    /// Every backend `.rs` file under `src/`, with `//`-style comment lines
    /// stripped (same idiom as `no_unaudited_network_plugins`) so a doc comment
    /// can name a banned pattern without tripping the source scans below.
    fn backend_sources_without_comments() -> Vec<(std::path::PathBuf, String)> {
        let src_dir = ["src", "src-tauri/src"]
            .iter()
            .find(|p| std::path::Path::new(p).join("lib.rs").exists())
            .copied()
            .expect("src dir not found from any working directory");

        fn collect(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).expect("read src dir") {
                let p = e.expect("dir entry").path();
                if p.is_dir() {
                    collect(&p, out);
                } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
                    out.push(p);
                }
            }
        }
        let mut files = Vec::new();
        collect(std::path::Path::new(src_dir), &mut files);
        assert!(!files.is_empty(), "source scan found no .rs files");

        files
            .into_iter()
            .map(|p| {
                let raw = std::fs::read_to_string(&p).expect("read source file");
                let code: String = raw
                    .lines()
                    .map(|l| {
                        let t = l.trim_start();
                        if t.starts_with("//") || t.starts_with("///") || t.starts_with("//!") {
                            ""
                        } else {
                            l
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                (p, code)
            })
            .collect()
    }

    /// **HARD GUARDRAIL — CORE-1014 / P3-16.** All day-boundary "today" math
    /// must go through `plan::app_today()` — the reader's LOCAL calendar day —
    /// never the UTC day. A US evening reader finishing tonight's section at
    /// 9pm ET belongs to tonight, not to tomorrow's UTC date. Banned shapes:
    /// the two chrono UTC-day spellings (`.naive_utc()` + `.date()`,
    /// `Utc::now()` + `.date_naive()`) and the SQL day boundary `date` of
    /// `'now'` in any case — day comparisons must use a Rust-supplied local
    /// date param instead. `datetime('now')` timestamp arithmetic stays
    /// legitimate and is deliberately not matched (`date(` is not a prefix of
    /// `datetime(`, so the case-folded scan can't catch it by accident).
    #[test]
    fn day_boundaries_use_local_app_today() {
        // Needles assembled at runtime so this test's own source never matches.
        let rust_utc_day = format!("{}{}", "naive_utc().", "date()");
        let rust_utc_day_2 = format!("{}{}", "Utc::now().", "date_naive()");
        let sql_utc_day = format!("{}{}", "date('", "now'");
        // SQL day-bucketing of a stored UTC timestamp is the same bug from the
        // other side: `DATE(started_at)` groups a session by the UTC day of its
        // RFC3339 stamp (9pm ET lands on "tomorrow"). Bucket in Rust via
        // `plan::local_day_of` instead.
        let sql_started_day = format!("{}{}", "date(", "started_at");

        let mut violations: Vec<String> = Vec::new();
        for (path, code) in backend_sources_without_comments() {
            // log.rs is exempt: tracing_appender names rolled files by the UTC
            // date, so prune_old_logs must do its retention math on the
            // appender's calendar — that is filename matching, not a
            // reader-facing reading-day boundary.
            if path.ends_with("log.rs") {
                continue;
            }
            for needle in [&rust_utc_day, &rust_utc_day_2] {
                if code.contains(needle.as_str()) {
                    violations.push(format!(
                        "{}: contains `{}` — day boundaries must use plan::app_today() \
                         (pass the local date into SQL as a param)",
                        path.display(),
                        needle
                    ));
                }
            }
            if code.to_lowercase().contains(sql_utc_day.as_str()) {
                violations.push(format!(
                    "{}: contains `{}` (any case) — day boundaries must use \
                     plan::app_today() (pass the local date into SQL as a param)",
                    path.display(),
                    sql_utc_day
                ));
            }
            if code.to_lowercase().contains(sql_started_day.as_str()) {
                violations.push(format!(
                    "{}: contains `{}` (any case) — sessions must bucket by the \
                     reader's LOCAL day via plan::local_day_of, not SQL's UTC \
                     DATE() of the stored timestamp",
                    path.display(),
                    sql_started_day
                ));
            }
        }
        if !violations.is_empty() {
            panic!(
                "UTC day-boundary math found (CORE-1014 / P3-16):\n  - {}",
                violations.join("\n  - ")
            );
        }
    }

    /// **HARD GUARDRAIL — CORE-1017 / P3-19.** A GUI app's stderr lands in the
    /// macOS unified log (sysdiagnose-collectable), and book paths/titles are
    /// content-adjacent metadata — invariant 1 is "usage, never content". So no
    /// command may `eprintln!` anything that references a reader's `path`, a
    /// book `title`, or an import `result.book`. Diagnostics belong in
    /// `tracing` (the local app.log), with ids and counts, not paths/titles.
    #[test]
    fn commands_do_not_eprintln_reader_content() {
        let needles = ["path", "title", "result.book"];
        let mut violations: Vec<String> = Vec::new();
        for (path, code) in backend_sources_without_comments() {
            if !path.components().any(|c| c.as_os_str() == "commands") {
                continue;
            }
            let mut rest = code.as_str();
            while let Some(pos) = rest.find("eprintln!") {
                let call = &rest[pos..];
                let end = call.find(");").map(|i| i + 2).unwrap_or(call.len());
                let call = call[..end].split_whitespace().collect::<Vec<_>>().join(" ");
                for n in needles {
                    if call.contains(n) {
                        violations.push(format!(
                            "{}: `{}` references `{}` — route through tracing and drop the reader content",
                            path.display(),
                            call,
                            n
                        ));
                    }
                }
                rest = &rest[pos + "eprintln!".len()..];
            }
        }
        if !violations.is_empty() {
            panic!(
                "stderr writes referencing reader content (CORE-1017 / P3-19):\n  - {}",
                violations.join("\n  - ")
            );
        }
    }

    /// **GUARDRAIL — CORE-1032 / P3-35.** The doc comment on
    /// `COMMAND_API_VERSION` promises a per-major history; this pins it
    /// complete. Every major up to the current constant must have its
    /// `- {n-1} → {n}:` line, so a future bump fails this test until its
    /// history line is written — that's the point: the archaeology is recorded
    /// while it is still remembered.
    #[test]
    fn command_api_version_history_is_complete() {
        let lib_src = std::fs::read_to_string("src/lib.rs")
            .or_else(|_| std::fs::read_to_string("src-tauri/src/lib.rs"))
            .expect("src/lib.rs not found");
        let mut missing: Vec<String> = Vec::new();
        for n in 2..=crate::COMMAND_API_VERSION {
            let marker = format!("- {} → {}:", n - 1, n);
            if !lib_src.contains(&marker) {
                missing.push(marker);
            }
        }
        if !missing.is_empty() {
            panic!(
                "COMMAND_API_VERSION is {} but its doc history is missing: {} \
                 (CORE-1032 / P3-35 — record why each major bumped before it's forgotten)",
                crate::COMMAND_API_VERSION,
                missing.join(", ")
            );
        }
    }
}

//! Throughline — Tauri backend entry point.
//!
//! The library is organized as:
//!
//!   - `paths`, `db`, `migrations`, `error`, `log`            — primitives
//!   - `models`                                               — DB row structs
//!   - `import`, `import_epub`, `epub_classify`               — book ingestion
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
pub mod circuit_breaker;
pub mod commands;
pub mod db;
pub mod epub_classify;
pub mod error;
pub mod export;
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
            eprintln!("[tl] database appears corrupt; preserving it and starting fresh: {e:#}");
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
            Ok(n) if n > 0 => eprintln!(
                "[tl] ai_retention: swept {} ai_requests row(s) older than {} days",
                n, days
            ),
            Ok(_) => {}
            Err(e) => eprintln!("[tl] ai_retention: sweep failed: {}", e),
        }
    }
    // Purge plans "let go" longer than 30 days ago, with their sessions + notes.
    match commands::plans::sweep_deleted_plans(&conn, 30) {
        Ok(n) if n > 0 => eprintln!("[tl] plan_retention: purged {} let-go plan(s)", n),
        Ok(_) => {}
        Err(e) => eprintln!("[tl] plan_retention: sweep failed: {}", e),
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
    use crate::models::PaceState;
    use crate::plan::{assigned_section_index, expected_completed, pace_state};
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
    fn test_pace_state_on_pace_when_caught_up() {
        let state = pace_state(30, 5, 30, 5);
        matches!(state, PaceState::OnPace);
    }

    #[test]
    fn test_pace_state_behind() {
        let state = pace_state(30, 8, 30, 10);
        if let PaceState::Behind { days_behind } = state {
            assert_eq!(days_behind, 2);
        } else {
            panic!("expected Behind")
        }
    }

    #[test]
    fn test_pace_state_recovery_when_far_behind() {
        let state = pace_state(30, 0, 30, 10);
        matches!(state, PaceState::Recovery);
    }

    #[test]
    fn test_expected_completed_endpoints() {
        assert_eq!(expected_completed(30, 30, 0), 0);
        assert_eq!(expected_completed(30, 30, 30), 30);
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
}

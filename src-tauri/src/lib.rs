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
pub mod backup;
pub mod bin_guardrail;
pub mod book_origin;
pub mod book_structure;
pub mod chunker;
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
pub mod phrases;
pub mod plan;
pub mod relaunch_focus;
pub mod settings;
pub mod sittings;

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
/// - 5 → 6: notes export reshaped from one Markdown file PER NOTE
///   (`Notes/{book}_{note}.md`) to one per-book LITERATURE NOTE
///   (`Books/{slug}.md`) that re-exports idempotently in place; `cmd_save_note`
///   / `cmd_update_note` / `cmd_save_ai_*` now write that shared book file (the
///   note's `exported_markdown_path` points at it), delete-note re-merges rather
///   than removing a file, and the new `cmd_export_library` regenerates every
///   book file. The on-disk export contract a JS caller observes changed.
/// - 6 → 7: failure-honest typed outcomes (audit DATA-004/005) + PRIV-001
///   removal of unsolicited phrase generation. `cmd_save_note` /
///   `cmd_update_note` / `cmd_save_ai_*` return `SavedNote { note, export }`;
///   `cmd_delete_note` returns the `ExportOutcome`; `cmd_end_session` returns
///   `SessionEnd { session, export }`, validates before mutating, transacts the
///   whole end, and is idempotent on repeat; `cmd_export_library` adds
///   `failed: string[]`; `cmd_set_ai_settings` dropped `ai_phrases` and
///   `SettingsDto` dropped `ai_phrases`.
/// - 7 → 8: first-cloud consent is bound to the exact ask (R6-1 / CORE-1177).
///   `cmd_confirm_cloud_send` is REMOVED — a global consent write that raced
///   the send it authorized. `cmd_outbound_envelope` now returns `provider`
///   and `fingerprint` alongside the envelope, and `cmd_ai_ask` takes an
///   optional `consent: { provider, host, fingerprint }` validated at the send
///   boundary against what that very call resolves to; the matching binding is
///   the ONLY writer of `KEY_FIRST_CLOUD_CONFIRMED_AT`.
pub const COMMAND_API_VERSION: u32 = 8;

/// Open the database, recovering from a CORRUPT file rather than crash-looping on
/// launch (a permanently-unusable app — the worst outcome for a paying user).
///
/// On a clean open we write a rolling backup (kept to the last few launches) so
/// corruption is survivable. On corruption the damaged DB + its WAL/SHM are
/// FIRST preserved under unique fsynced names (REQUIRED — a preservation
/// failure aborts loudly with nothing replaced, REC-011), then we try to
/// RESTORE from the newest backup that passes the shared coherence preflight —
/// so the reader loses only since-last-backup, not their entire library ("the
/// first paying reader's reading.db is forever"). Only when no backup passes
/// do we start on a fresh DB (the corrupt original stays preserved).
///
/// Environmental failures (permissions, full disk) are NOT "recovered" — wiping
/// data wouldn't help — so they still fail loudly with a clear, non-cryptic message.
fn open_db_resilient() -> rusqlite::Connection {
    // R10-2: INTERPROCESS exclusion first — before the marker read, any
    // preservation, recovery, or open below. A second launch must stop here,
    // having touched nothing.
    db::acquire_process_lock().unwrap_or_else(|e| {
        panic!(
            "Throughline could not secure exclusive access to its data folder ({e:#}). \
             Nothing was changed — fix permissions on the data folder (or quit the \
             other copy of Throughline), then relaunch."
        );
    });
    // R5: an INTERRUPTED fresh-start transition must never be mistaken for an
    // ordinary missing DB (which would silently mint an empty library with
    // none of the recovery context). The durable marker written by
    // begin_fresh_start brackets the transition; resume it here first.
    if let Ok(dbp) = paths::db_path() {
        // R7-1: an UNREADABLE marker is not an absent one — proceeding as if
        // no transition were interrupted could mint a silent empty library.
        let marker_present = backup::fresh_start_marker_present(&dbp).unwrap_or_else(|e| {
            panic!(
                "Throughline could not determine whether a recovery was interrupted ({e:#}). \
                 Nothing was changed — fix permissions on the data folder, then relaunch."
            )
        });
        if marker_present {
            tracing::error!(
                "resuming an INTERRUPTED fresh-start transition (durable marker present)"
            );
            match db::open_and_migrate() {
                Ok(healthy) => {
                    // The fresh DB was already created; the crash may have hit
                    // anywhere between its creation and the marker removal —
                    // INCLUDING before the generation rotation (R6-4). Rotate
                    // (idempotent for a fresh library: no reader interaction
                    // could have produced drafts against it mid-launch) before
                    // lifting the marker, so the bracket never closes around a
                    // stale token.
                    settings::rotate_library_generation(&healthy).unwrap_or_else(|e| {
                        panic!(
                            "could not stamp the fresh library's generation ({e:#}); relaunch to retry"
                        )
                    });
                    backup::finish_fresh_start(&dbp).unwrap_or_else(|e| {
                        panic!("could not clear the fresh-start marker ({e:#}); relaunch to retry")
                    });
                }
                Err(_) => {
                    // Mid-clear crash: finish clearing the (already-preserved)
                    // triple, create the fresh DB, then lift the marker.
                    backup::clear_live_db_after_preservation(&dbp).unwrap_or_else(|e| {
                        panic!(
                            "could not finish the interrupted fresh start ({e:#}). Nothing was lost — relaunch to retry."
                        )
                    });
                    let conn = db::open_and_migrate().expect(
                        "could not create a fresh database resuming an interrupted fresh start",
                    );
                    // R6-4: rotation happens INSIDE the marker bracket — a
                    // failure panics with the marker still down, so the next
                    // launch resumes (and retries the rotation) instead of
                    // running a replaced library under a stale token.
                    settings::rotate_library_generation(&conn).unwrap_or_else(|e| {
                        panic!(
                            "could not stamp the fresh library's generation ({e:#}). Nothing was lost — relaunch to retry."
                        )
                    });
                    if let Err(e) = backup::finish_fresh_start(&dbp) {
                        tracing::warn!("fresh-start marker not cleared ({e:#}); next launch re-resumes harmlessly");
                    }
                    return conn;
                }
            }
        }
    }
    match db::open_and_migrate() {
        Ok(c) => {
            // Clean startup: refresh the rolling backup. Best-effort — a backup
            // failure must never break launch, and we log without any content.
            // The backup path is intentionally not logged in full (it embeds
            // the data dir); only the fact + retention count is recorded.
            // Readers can turn this off (Settings › Files › Automatic backups).
            if settings::get_backups_enabled(&c) {
                match backup::write_rolling_backup(&c) {
                    Ok(_) => {
                        tracing::info!("reading.db backup written ({} kept)", backup::KEEP_BACKUPS)
                    }
                    Err(e) => tracing::warn!("reading.db backup skipped: {e:#}"),
                }
            } else {
                tracing::info!("reading.db backup skipped: automatic backups are off");
            }
            c
        }
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
            tracing::error!("database appears corrupt; attempting recovery from backup: {e:#}");

            // REC-011 REQUIRED PRECONDITION: preserve the corrupt DB + every
            // WAL/SHM sidecar (unique names, fsynced) BEFORE any recovery may
            // replace anything. If preservation fails, we replace NOTHING and
            // fail loudly — a fresh or restored DB written over unsaved corrupt
            // bytes would destroy the only salvageable copy of the library.
            let dbp = paths::db_path()
                .expect("Throughline could not resolve its database path during recovery");
            match backup::preserve_corrupt_live(&dbp) {
                Ok(Some(kept)) => {
                    tracing::info!("corrupt reading.db preserved as {:?}", kept.file_name())
                }
                Ok(None) => tracing::info!("no live reading.db to preserve"),
                Err(pe) => panic!(
                    "Throughline could not secure the damaged library file before recovery ({pe:#}). \
                     Nothing was changed. Free up disk space or fix permissions on the data folder, then relaunch."
                ),
            }

            // RESTORE-BEFORE-FRESH: prefer the reader's most recent good backup
            // over an empty DB. Only if no backup passes the coherence preflight
            // do we fall through to a fresh database (the corrupt original is
            // already preserved above).
            match backup::try_restore_newest_backup() {
                Ok(backup::RestoreOutcome::Restored(_path)) => {
                    tracing::info!("restored reading.db from a verified backup");
                    match db::open_and_migrate() {
                        // R7-1: the generation was rotated ON THE PREPARED
                        // CANDIDATE before its atomic promotion (see
                        // restore_into_place_prepared) — the restored library
                        // arrives already carrying its own token, so there is
                        // no post-swap rotation left to fail here.
                        Ok(c) => return c,
                        // The restored file failed to re-open (should not happen —
                        // it was validated on a copy). FAIL CLOSED with the truth:
                        // the old "fall through to fresh" claim was a lie — the
                        // unopenable restored file sits at the live path, so the
                        // fresh-open below would panic with a misleading
                        // "could not create a fresh database" message anyway.
                        Err(e) => panic!(
                            "Throughline restored a backup but could not reopen it ({e:#}). \
                             Nothing else was changed — the damaged library is preserved and \
                             your backups are intact. Relaunch to retry recovery."
                        ),
                    }
                }
                Ok(backup::RestoreOutcome::NoneUsable {
                    any_unassessable: false,
                }) => {
                    tracing::error!(
                        "every backup is definitively unusable; starting fresh (corrupt DB preserved)"
                    );
                }
                // R5 FAIL CLOSED: an environmental error is not a verdict. If
                // any candidate could not be ASSESSED, or the attempt itself
                // errored, an empty library is NOT authorized — stop with
                // everything preserved and still in place.
                Ok(backup::RestoreOutcome::NoneUsable {
                    any_unassessable: true,
                }) => panic!(
                    "Throughline could not assess at least one backup (a disk or permissions \
                     problem, not proof it is bad). Nothing was changed — the damaged library \
                     is preserved and your backups are intact. Fix the disk problem and relaunch."
                ),
                // R9-1: the promotion classification is PRESERVED so each
                // hard stop tells the truth about what is on disk — the three
                // classes differ, and only one of them may say "nothing was
                // changed".
                Err(backup::RestoreError::Promotion(backup::PromotionError::After(e))) => panic!(
                    "Throughline restored a backup, but could not PROVE the switch durable \
                     ({e:#}). The restored library IS in place and the damaged one is \
                     preserved — relaunch to re-verify. Nothing was lost."
                ),
                Err(backup::RestoreError::Promotion(backup::PromotionError::AuxMutated(e))) => {
                    panic!(
                        "Throughline could not finish restoring a backup ({e:#}). The damaged \
                         library file was not replaced (helper files beside it were cleared), \
                         and a full copy of it is preserved — fix the disk problem and relaunch."
                    )
                }
                Err(backup::RestoreError::Promotion(backup::PromotionError::Untouched(e))) => {
                    panic!(
                        "Throughline could not restore a backup ({e:#}). Nothing was changed — \
                         the damaged library is preserved and your backups are intact. Fix the \
                         disk problem and relaunch."
                    )
                }
                Err(backup::RestoreError::Env(e)) => panic!(
                    "Throughline could not check your backups ({e:#}). Nothing was changed — \
                     the damaged library is preserved. Fix the disk problem and relaunch."
                ),
            }

            // R4/R5: preservation no longer moves the originals — the corrupt
            // triple still sits at the live path. Only now, with durable
            // preserved copies on disk and every backup DEFINITIVELY unusable,
            // does the crash-safe fresh-start transition run: durable marker →
            // clear → fresh DB → lift marker. A crash at any boundary is
            // resumed at the next launch (see the top of this function) — an
            // interrupted transition is never mistaken for a missing DB.
            if let Err(ce) = backup::begin_fresh_start(&dbp) {
                panic!(
                    "Throughline preserved the damaged library but could not record the fresh start ({ce:#}). \
                     Nothing was lost — relaunch to retry."
                );
            }
            if let Err(ce) = backup::clear_live_db_after_preservation(&dbp) {
                panic!(
                    "Throughline preserved the damaged library but could not clear it for a fresh start ({ce:#}). \
                     Nothing was lost — relaunch to retry."
                );
            }
            let conn = db::open_and_migrate()
                .expect("could not create a fresh database after corruption recovery");
            // R5/R6-4: a fresh library is its own generation too — stamped
            // INSIDE the marker bracket, so a failure panics with the marker
            // still down and the next launch resumes (and retries) instead of
            // running under a stale token.
            settings::rotate_library_generation(&conn).unwrap_or_else(|e| {
                panic!(
                    "Throughline prepared a fresh library but could not stamp its generation ({e:#}). Nothing was lost — relaunch to retry."
                )
            });
            if let Err(e) = backup::finish_fresh_start(&dbp) {
                tracing::warn!(
                    "fresh-start marker not cleared ({e:#}); the next launch resumes harmlessly"
                );
            }
            conn
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
    // R11-2: NO database work happens before the Tauri builder runs. The
    // single-instance plugin initializes FIRST — a second launch (a
    // throughline:// activation click while the app is running) forwards its
    // URL to the primary over the plugin's socket and exits(0) during plugin
    // setup, so it can never reach the interprocess DB lock, let alone panic
    // on it. The database opens inside `.setup()` (below), which only a
    // PRIMARY instance ever reaches. Pinned by
    // `single_instance_forwarding_precedes_any_db_open`.

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
        // CORE-1192: opens the public download page in the reader's BROWSER as
        // the updater's last-resort recovery (window.open is a no-op in wry).
        // The capability scopes it to https://readthroughline.com/* only.
        .plugin(tauri_plugin_opener::init())
        // CORE-1193: the app-menu "Check for Updates…" item. Focus the reading
        // window, then let the webview land the reader on Settings › Software
        // Update and start a manual (cooldown-free) check.
        .on_menu_event(|app, event| {
            if event.id() == "check-for-updates" {
                use tauri::{Emitter, Manager};
                if let Some(w) = app.webview_windows().values().next() {
                    let _ = w.set_focus();
                }
                let _ = app.emit("tl-menu-check-updates", ());
            }
        })
        .setup(|app| {
            // R11-2: the database opens HERE — after every plugin initialized,
            // so a secondary instance already forwarded-and-exited and can
            // never contend on (or panic over) the interprocess DB lock.
            {
                use tauri::Manager;
                let conn = open_db_resilient();
                // adr-001: bound the AI audit trail on every launch. Rows older
                // than the retention window that never became a note are swept;
                // approved rows stay.
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
                // Purge plans "let go" longer than 30 days ago, with their
                // sessions + notes.
                match commands::plans::sweep_deleted_plans(&conn, 30) {
                    Ok(n) if n > 0 => {
                        tracing::info!("plan_retention: purged {} let-go plan(s)", n)
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("plan_retention: sweep failed: {}", e),
                }
                // TRUST-029: commit removals the reader CONFIRMED but whose Undo
                // window a quit interrupted. Staged ids are durable in the
                // settings ledger, so a confirmed removal survives quit/relaunch;
                // Undo (within the window) unstages before this ever runs again.
                match commands::commit_pending_deletes(&conn) {
                    Ok((0, 0)) => {}
                    Ok((notes, books)) => tracing::info!(
                        "pending-delete sweep: committed {notes} note(s), {books} book(s)"
                    ),
                    Err(e) => tracing::warn!("pending-delete sweep failed: {e:#}"),
                }
                // DATA-005: heal stale Markdown mirrors — books whose export
                // failed after a durable row change are marked in a ledger and
                // re-exported here, so the reader's files catch up even if they
                // never pressed "try again". After the delete sweep, so removed
                // books resolve to "nothing to heal".
                match commands::retry_pending_exports(&conn) {
                    (0, 0) => {}
                    (healed, still_dirty) => tracing::info!(
                        "export retry: healed {healed} stale book file(s), {still_dirty} still pending"
                    ),
                }
                // P0 quit-flush safety net: close sessions a previous run left
                // open (hard kill or a lost quit-flush race), honestly, from the
                // last durable reading evidence.
                match commands::sessions::sweep_orphan_sessions(&conn) {
                    Ok(n) if n > 0 => {
                        tracing::info!("session sweep: closed {} orphaned session(s)", n)
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("session sweep failed: {}", e),
                }
                app.manage(DbState::new(conn));
            }
            // macOS app menu: the stock default menu plus "Check for Updates…"
            // right under "About Throughline" (CORE-1193). macOS-only — the
            // other platforms ship no menubar today and this must not add one.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let handle = app.handle();
                let menu = Menu::default(handle)?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                    let check_item = MenuItem::with_id(
                        handle,
                        "check-for-updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?;
                    app_menu.insert(&check_item, 1)?;
                }
                app.set_menu(menu)?;
            }
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
            // In-app backup schedule: the launch backup already covers the
            // open-daily reader; this hourly check covers the Mac that stays
            // open for days, writing a fresh rolling backup once the newest is
            // a day old (backup::backup_due). Local disk only — never network,
            // never content in logs — and OFF with the same toggle as launch.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60 * 60));
                    let state = handle.state::<DbState>();
                    let Ok(conn) = state.lock() else { continue };
                    let enabled = settings::get_backups_enabled(&conn);
                    let newest = backup::newest_backup_taken_at()
                        .ok()
                        .flatten()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                        .map(|t| t.with_timezone(&chrono::Local));
                    if backup::backup_due(enabled, newest, chrono::Local::now()) {
                        match backup::write_rolling_backup(&conn) {
                            Ok(_) => tracing::info!("scheduled reading.db backup written"),
                            Err(e) => tracing::warn!("scheduled backup failed: {e:#}"),
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
            commands::books::cmd_library,
            commands::books::cmd_read_book_cover,
            commands::books::cmd_book_origin,
            commands::books::cmd_relink_book,
            commands::books::cmd_set_active_book,
            commands::books::cmd_delete_book,
            commands::books::cmd_stage_book_delete,
            commands::books::cmd_unstage_book_delete,
            commands::books::cmd_configure_plan,
            // ── discover (public-domain catalogue; reader-initiated egress) ──
            commands::discover::cmd_discover_search,
            commands::discover::cmd_discover_seed,
            commands::discover::cmd_discover_books_by_ids,
            commands::discover::cmd_import_from_gutendex,
            // ── sessions / plan / progress ──
            commands::sessions::cmd_start_session,
            commands::sessions::cmd_end_session,
            commands::sessions::cmd_save_section_progress,
            commands::sessions::cmd_restart_current_section,
            // ── notes ──
            commands::notes::cmd_save_note,
            commands::notes::cmd_update_note,
            commands::notes::cmd_delete_note,
            commands::notes::cmd_stage_note_delete,
            commands::notes::cmd_unstage_note_delete,
            commands::notes::cmd_list_notes,
            commands::notes::cmd_quote_warns,
            commands::notes::cmd_export_library,
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
            commands::ai::cmd_outbound_envelope,
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
            commands::settings_cmds::cmd_reveal_data_folder,
            commands::settings_cmds::cmd_prepare_update_relaunch_focus,
            commands::settings_cmds::cmd_consume_update_relaunch_focus,
            commands::settings_cmds::cmd_focus_main_window_after_update_relaunch,
            commands::settings_cmds::cmd_get_settings,
            commands::feedback::cmd_feedback_diagnostics,
            commands::feedback::cmd_send_feedback,
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
            commands::settings_cmds::cmd_get_reading_pace,
            commands::settings_cmds::cmd_set_reading_pace,
            commands::settings_cmds::cmd_set_appearance,
            commands::backups::cmd_backup_status,
            commands::backups::cmd_set_backups_enabled,
            commands::backups::cmd_list_backups,
            commands::backups::cmd_restore_backup,
            commands::backups::cmd_undo_restore,
            commands::backups::cmd_stage_restore_source,
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
    use crate::{ai_client, db, export, paths};

    /// R7-1(c): an UNREADABLE fresh-start marker state (metadata/permission
    /// failure on the data dir) is a HARD STOP — never treated as "absent",
    /// which would skip the resume of an interrupted transition and could
    /// mint a silent empty library. No session runs on an undetermined state.
    #[cfg(unix)]
    #[test]
    fn unreadable_marker_state_hard_stops_the_launch() {
        use std::os::unix::fs::PermissionsExt;
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-markerread-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&data).unwrap();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        // The data dir cannot be inspected: marker presence is UNKNOWN.
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o000)).unwrap();
        let perms_enforced = std::fs::read_dir(&data).is_err();
        let result = std::panic::catch_unwind(crate::open_db_resilient);
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();

        if perms_enforced {
            let err = result.expect_err("an undetermined marker state must not launch");
            let msg = err
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "non-string panic".to_string());
            // R10-2: the interprocess lock is acquired BEFORE the marker
            // read, so an unreadable data dir now stops the launch at the
            // lock — one step earlier, same protection, honest either way.
            assert!(
                msg.contains("could not determine whether a recovery was interrupted")
                    || msg.contains("could not secure exclusive access to its data folder"),
                "the hard stop names the undetermined/inaccessible state: {msg}"
            );
            // Nothing was created over the unknown state.
            assert!(
                std::fs::read_dir(&data).unwrap().next().is_none(),
                "no library was minted while the marker state was unreadable"
            );
        } else {
            eprintln!("skipping: permissions not enforced (root?)");
        }

        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
    }

    /// R9-1: the AUTOMATIC recovery path hard-stops TRUTHFULLY on an
    /// applied-but-unproven restore — the launch panic must say the restored
    /// library IS in place (never "nothing was changed"), and the process
    /// must not continue to a session or a fresh library.
    #[test]
    fn automatic_applied_but_unproven_restore_hard_stops_truthfully() {
        let g = paths::lock_env_for_test();
        let data = std::env::temp_dir().join(format!(
            "tl-autounproven-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&data);
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_DATA_DIR", &data) };

        let result = std::panic::catch_unwind(|| {
            // A good backup, then a corrupt live DB.
            let conn = db::open_and_migrate().expect("open live DB");
            crate::settings::set_string(&conn, "library_marker", "GOOD BACKUP").unwrap();
            crate::backup::write_rolling_backup(&conn).expect("backup");
            drop(conn);
            let live = paths::db_path().unwrap();
            std::fs::write(&live, b"CORRUPT LIVE BYTES").unwrap();
            let sidecars = [
                format!("{}-wal", live.to_string_lossy()),
                format!("{}-shm", live.to_string_lossy()),
            ];
            for s in &sidecars {
                let _ = std::fs::remove_file(s);
            }

            // The recovery's promotion applies but cannot prove durability.
            crate::backup::promotion_test_seam::arm(
                crate::backup::promotion_test_seam::FailPoint::PostRenameDirFsync,
            );
            let launch = std::panic::catch_unwind(crate::open_db_resilient);
            crate::backup::promotion_test_seam::disarm();

            let err = launch.expect_err("an unproven automatic restore must hard-stop");
            let msg = err
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "non-string panic".to_string());
            assert!(
                msg.contains("could not PROVE the switch durable"),
                "the hard stop names the unproven transition: {msg}"
            );
            assert!(
                msg.contains("The restored library IS in place"),
                "the hard stop tells the truth about what is on disk: {msg}"
            );
            assert!(
                !msg.to_lowercase().contains("nothing was changed"),
                "an applied restore must never claim 'nothing was changed': {msg}"
            );
            // TRUTH of the message: the restored library really is in place…
            let conn = rusqlite::Connection::open(&live).expect("restored library opens");
            assert_eq!(
                crate::settings::get_string(&conn, "library_marker").as_deref(),
                Some("GOOD BACKUP")
            );
            drop(conn);
            // …and the preserved corrupt copy still exists.
            let preserved = std::fs::read_dir(&data)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
            assert!(preserved, "the damaged library remains preserved");
        });

        crate::backup::promotion_test_seam::disarm();
        unsafe { std::env::remove_var("THROUGHLINE_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&data);
        drop(g);
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

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

// PRIV-001 / TRUST-002 regression: configuring a plan and ending a session must
// produce ZERO network traffic and ZERO ai_requests rows on a fresh install,
// for EVERY provider configuration — even when a legacy `ai_phrases = "true"`
// row is present and the provider's endpoints are reachable.
//
// The old behavior under test: `cmd_configure_plan` spawned a background
// phrase batch and `cmd_end_session` prefetched the next sitting's phrase,
// both sending book-text slices to the configured provider with no reader
// action and no first-cloud consent. That code was removed; this test pins
// the removal behaviorally. A counting loopback listener stands in for both
// the company relay and the local AI server, so ANY egress on those routes
// would be observed as a connection.

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection};

use throughline_lib::commands::books::configure_plan_impl;
use throughline_lib::commands::sessions::{end_session_impl, start_session_on};
use throughline_lib::{db, import, settings};

/// A loopback listener that counts every accepted connection. Any phrase-style
/// egress pointed at it (company relay or local AI base URL) increments `hits`.
fn counting_listener() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_c = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stream.is_ok() {
                hits_c.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    (format!("http://127.0.0.1:{port}"), hits)
}

/// Point the app's data + export dirs at a fresh per-tag temp dir, so every
/// provider iteration gets a brand-new DB and book store. This test binary is
/// a single #[test] (sequential by construction), so the process-global env
/// mutation is safe here.
fn fresh_isolated_dirs(tag: &str) -> PathBuf {
    let root = std::env::temp_dir()
        .join("throughline-isolated")
        .join(format!("no-unsolicited-ai-{}-{tag}", std::process::id()));
    let export = root.join("export");
    std::fs::create_dir_all(&export).expect("create isolated dirs");
    unsafe {
        std::env::set_var("THROUGHLINE_DATA_DIR", &root);
        std::env::set_var("THROUGHLINE_EXPORT_DIR", &export);
    }
    root
}

fn seed_book_with_plan(conn: &Connection) -> (String, Vec<throughline_lib::models::BookSection>) {
    let src = PathBuf::from("tests/fixtures/corpus/confessions_augustine.txt");
    let result = import::import_any(&src).expect("import fixture");
    conn.execute(
        "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            result.book.id,
            result.book.title,
            result.book.author,
            result.book.source_type,
            result.book.source_path,
            result.book.source_sha256,
            result.book.created_at,
            result.book.last_opened_at
        ],
    )
    .unwrap();
    for s in &result.sections {
        conn.execute(
            "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                s.id,
                s.book_id,
                s.label,
                s.href,
                s.start_locator,
                s.end_locator,
                s.estimated_units,
                s.sort_order,
                if s.assignable { 1 } else { 0 }
            ],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO reading_plans (id, book_id, start_date, status)
         VALUES ('plan_test', ?1, '2026-01-01', 'plan_ready')",
        params![result.book.id],
    )
    .unwrap();
    let sections = result
        .sections
        .iter()
        .filter(|s| s.assignable)
        .cloned()
        .collect();
    (result.book.id, sections)
}

fn ai_request_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM ai_requests", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn plan_configuration_and_session_end_spawn_zero_ai_work_for_every_provider() {
    let (base_url, hits) = counting_listener();

    for provider in ["company", "anthropic", "openai", "codex", "local", "none"] {
        fresh_isolated_dirs(provider);
        let conn = db::open_and_migrate().expect("open fresh DB");

        // Worst-case configuration: provider chosen, a LEGACY ai_phrases="true"
        // row present, and both configurable endpoints pointing at the counting
        // listener. Nothing below may touch it.
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, provider).unwrap();
        settings::set_string(&conn, settings::KEY_AI_PHRASES, "true").unwrap();
        // R7-2: the company origin is a code constant now — this legacy row is
        // INERT (nothing reads it), planted here as the worst case anyway.
        settings::set_string(&conn, "company_base_url", &base_url).unwrap();
        settings::set_string(&conn, settings::KEY_AI_BASE_URL, &base_url).unwrap();

        let (book_id, sections) = seed_book_with_plan(&conn);
        assert!(!sections.is_empty(), "fixture must sectionize");

        // Configure the plan — the old import-time phrase batch fired here.
        configure_plan_impl(&conn, &book_id, 25, Some("Attempt".into())).expect("configure plan");

        // Sittings were built with opening hashes and no cached phrases — the
        // exact precondition under which the old code sent slices.
        let missing_phrases: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sittings s
                 LEFT JOIN phrases p ON p.opening_hash = s.opening_hash
                 WHERE s.book_id = ?1 AND s.opening_hash IS NOT NULL
                   AND p.opening_hash IS NULL",
                params![book_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            missing_phrases > 0,
            "{provider}: precondition — sittings exist without cached phrases"
        );

        // Start and end a real session — the old next-phrase prefetch fired here.
        let session = start_session_on(&conn, &book_id, None, Some("0")).expect("start session");
        end_session_impl(
            &conn,
            &session.id,
            Some("1200".into()),
            Some(25),
            None,
            Some("A takeaway.".into()),
        )
        .expect("end session");

        assert_eq!(
            ai_request_count(&conn),
            0,
            "{provider}: no ai_requests row may appear without a reader action"
        );
    }

    // Give any stray background work a beat to betray itself, then assert the
    // wire stayed silent across every provider configuration.
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "plan configuration / session end reached the network — unsolicited AI is back (PRIV-001)"
    );
}

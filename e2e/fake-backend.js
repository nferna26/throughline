// Browser-side fake of the Tauri IPC layer, injected via Playwright addInitScript
// BEFORE the app's JS runs. Tauri v2's `invoke`/`Channel` go through
// `window.__TAURI_INTERNALS__`; by defining it here we make the real React app
// run in plain Chromium against seeded data — so the UI can be driven and
// screenshotted end-to-end without the Rust backend (which the cargo acceptance
// examples cover separately). Self-contained: no imports, plain browser JS.
(() => {
  "use strict";

  // ── Seed data ──────────────────────────────────────────────────────────────
  const BOOK = {
    id: "book_demo",
    title: "Meditations",
    author: "Marcus Aurelius",
    source_type: "txt",
    source_path: "/demo/meditations.txt",
    source_sha256: "demo".padEnd(64, "0"),
    created_at: "2026-06-01T09:00:00Z",
    last_opened_at: "2026-06-07T08:00:00Z",
  };

  const SECTION_TEXT = `Begin the morning by saying to thyself, I shall meet with the busybody, the ungrateful, arrogant, deceitful, envious, unsocial. All these things happen to them by reason of their ignorance of what is good and evil.

But I who have seen the nature of the good that it is beautiful, and of the bad that it is ugly, and the nature of him who does wrong, that it is akin to me, not only of the same blood or seed, but that it participates in the same intelligence and the same portion of the divinity, I can neither be injured by any of them, for no one can fix on me what is ugly, nor can I be angry with my kinsman, nor hate him.

For we are made for cooperation, like feet, like hands, like eyelids, like the rows of the upper and lower teeth. To act against one another then is contrary to nature; and it is acting against one another to be vexed and to turn away.`;

  // NB: section start/end locators are BARE number strings (the backend stores
  // `usize.to_string()`), not the "char:N" tagged form used by note anchors.
  const SECTIONS = [
    { id: "sec_2", book_id: BOOK.id, label: "Book II", href: null, start_locator: "0", end_locator: String(SECTION_TEXT.length), estimated_units: SECTION_TEXT.length, sort_order: 0 },
    { id: "sec_3", book_id: BOOK.id, label: "Book III", href: null, start_locator: "0", end_locator: "900", estimated_units: 900, sort_order: 1 },
    { id: "sec_4", book_id: BOOK.id, label: "Book IV", href: null, start_locator: "0", end_locator: "900", estimated_units: 900, sort_order: 2 },
  ];

  let NOTES = [
    {
      id: "note_1", book_id: BOOK.id, session_id: null, note_type: "MarginNote",
      locator: "char:0", chapter_label: "Book II", body: "The whole book in one line.",
      short_quote: null, created_at: "2026-06-06T08:10:00Z", updated_at: "2026-06-06T08:10:00Z",
      exported_markdown_path: null,
      anchor_start: "char:0", anchor_end: "char:64",
      anchored_text: "Begin the morning by saying to thyself, I shall meet with the bu",
    },
  ];

  const SETTINGS = {
    export_path: "/Users/demo/GBrain/Reading", export_path_is_default: true,
    app_data_path: "/Users/demo/Library/Application Support/Throughline",
    ai_posture: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "local-model",
    ai_local_only: true, quote_policy: "warn", quote_warn_chars: 300,
    ai_requests_retention_days: 30, margin_help: "guided",
    ai_provider: "local", ai_provider_chosen: true, ai_remote_allowed: false,
    ai_model_openai: "", ai_model_anthropic: "", ai_model_codex: "",
    ai_key_present_openai: false, ai_key_present_anthropic: false, ai_codex_creds_present: false,
  };

  const TODAY = {
    book: BOOK,
    plan: {
      id: "plan_1", book_id: BOOK.id, start_date: "2026-06-01", target_finish_date: "2026-07-01",
      daily_target_units: 1, days_per_week: 7, catchup_mode: "gentle", status: "active",
      activated_at: "2026-06-01T09:00:00Z", original_finish_date: null,
    },
    section: SECTIONS[0],
    section_completed: false,
    estimated_minutes: 6, session_minutes: 25, monthly_pct: 18,
    pace: { kind: "on_pace" }, day_index: 3, total_days: 30,
    streak: { days_read_last_7: 4, minutes_last_7: 96 },
    recovery: null, resume_locator: null, resume_percent: null,
    plan_status: "active",
    forecast: { state: "on_track", projected_finish_date: "2026-06-29", days_late: 0 },
    memory: {
      last_capture: { note_type: "MarginNote", body: "The whole book in one line.", chapter_label: "Book II", created_at: "2026-06-06T08:10:00Z" },
      highlight_count: 1, note_count: 1,
    },
    teaser: {
      excerpt: "Begin the morning by saying to thyself, I shall meet with the busybody, the ungrateful, arrogant, deceitful, envious, unsocial.",
      prompt: "Read for the argument — what claim is being built?",
      locator: "char:0", is_resume_excerpt: false,
    },
  };

  const DISCOVER_PAGE = {
    count: 372, next_page: 2, offline: false,
    results: [
      { id: 1342, title: "Pride and Prejudice", author: "Jane Austen", language: "en", download_count: 99000, has_txt: true, has_epub: true, txt_url: "x", epub_url: "y" },
      { id: 2701, title: "Moby Dick; Or, The Whale", author: "Herman Melville", language: "en", download_count: 42000, has_txt: true, has_epub: true, txt_url: "x", epub_url: "y" },
      { id: 1232, title: "The Prince", author: "Niccolò Machiavelli", language: "en", download_count: 31000, has_txt: true, has_epub: true, txt_url: "x", epub_url: "y" },
    ],
  };

  const TUTOR_REPLY =
    "Aurelius is bracing himself before the day: he expects to meet difficult people, and pre-decides not to be surprised or angered by them. The move is Stoic — locate the fault in their ignorance of good and evil, recognize a shared rational nature, and so refuse both injury and hatred.";

  let noteSeq = 100;
  const nowIso = () => "2026-06-07T08:30:00Z";

  // ── Command table ────────────────────────────────────────────────────────────
  function handle(cmd, args) {
    switch (cmd) {
      case "cmd_today": return TODAY;
      case "cmd_get_settings": return SETTINGS;
      case "cmd_list_books": return [BOOK];
      case "cmd_assignable_sections": return SECTIONS;
      case "cmd_list_notes": return NOTES.slice();
      case "cmd_read_section_text": return SECTION_TEXT;
      case "cmd_read_section_structure": return [];
      case "cmd_quote_warns": return false;
      case "cmd_set_active_book": return null;
      case "cmd_configure_plan": return null;
      case "cmd_extend_finish_date":
        return { new_target_finish_date: "2026-07-11", new_daily_target_units: 1, remaining_sections: 12, remaining_days: 34 };
      case "cmd_save_section_progress": return null;
      case "cmd_start_session":
        return { id: "sess_1", book_id: BOOK.id, started_at: nowIso(), ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null };
      case "cmd_end_session": return null;
      case "cmd_save_note": {
        const n = {
          id: "note_" + ++noteSeq, book_id: BOOK.id, session_id: args && args.sessionId ? args.sessionId : null,
          note_type: (args && args.noteType) || "Observation", locator: (args && args.locator) || "char:0",
          chapter_label: (args && args.chapterLabel) || null, body: (args && args.body) || "",
          short_quote: (args && args.shortQuote) || null, created_at: nowIso(), updated_at: nowIso(),
          exported_markdown_path: null,
          anchor_start: (args && args.anchorStart) || null, anchor_end: (args && args.anchorEnd) || null,
          anchored_text: (args && args.anchoredText) || null,
        };
        NOTES.push(n);
        return n;
      }
      case "cmd_update_note": {
        const n = NOTES.find((x) => x.id === (args && args.noteId));
        if (n) { if (args.body != null) n.body = args.body; n.updated_at = nowIso(); }
        return n || null;
      }
      case "cmd_delete_note":
        NOTES = NOTES.filter((x) => x.id !== (args && args.noteId));
        return null;
      case "cmd_ai_preview":
        return { ai_request_id: "req_preview", mode: (args && args.mode) || "explain", mode_label: "Explain this passage", prompt: "Explain this passage from Meditations by Marcus Aurelius:\n\n“" + ((args && args.selection) || "") + "”", wrote_to_memory: false, provider: null };
      case "cmd_test_ai_connection":
        return { reachable: true, first_model_id: "gemma-4-31b-it-mlx", message: "ok" };
      case "cmd_list_ai_models": return ["gemma-4-31b-it-mlx", "qwen2.5-14b"];
      case "cmd_list_ai_requests": return [];
      case "cmd_discover_seed": return DISCOVER_PAGE;
      case "cmd_discover_search": return DISCOVER_PAGE;
      case "cmd_set_ai_settings": case "cmd_set_ai_key": case "cmd_clear_ai_key":
      case "cmd_set_export_path": case "cmd_forget_ai_history": case "cmd_codex_logout":
        return null;
      case "cmd_codex_device_start": return { user_code: "ABCD-1234", verification_uri: "https://example.com", device_code: "dev", interval: 5 };
      case "cmd_codex_device_poll": return { status: "pending" };
      case "cmd_import_book": case "cmd_import_from_gutendex":
        return { book: BOOK, created: false };
      // Tauri dialog plugin (file picker) — return no selection.
      case "plugin:dialog|open": return null;
      default:
        // eslint-disable-next-line no-console
        console.warn("[fake-backend] unhandled command:", cmd, args);
        return null;
    }
  }

  // cmd_ai_ask streams via the Channel passed as args.onEvent, then resolves a handle.
  function handleAsk(args) {
    const ch = args && args.onEvent;
    const emit = (ev) => { try { if (ch && typeof ch.onmessage === "function") ch.onmessage(ev); } catch (_) {} };
    const words = TUTOR_REPLY.split(" ");
    let i = 0;
    const tick = () => {
      if (i >= words.length) { emit({ kind: "done" }); return; }
      emit({ kind: "delta", text: (i ? " " : "") + words[i] });
      i += 1;
      setTimeout(tick, 18);
    };
    setTimeout(tick, 30);
    return Promise.resolve({ ai_request_id: "req_ask", prompt_sent: "(prompt)", provider_host: "localhost:1234" });
  }

  // ── Install the fake IPC bridge ──────────────────────────────────────────────
  let cbId = 0;
  const callbacks = {};
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = ++cbId; callbacks[id] = cb; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    invoke(cmd, args) {
      if (cmd === "cmd_ai_ask") return handleAsk(args);
      try { return Promise.resolve(handle(cmd, args)); } catch (e) { return Promise.reject(e); }
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
  };
  // Some @tauri-apps/api paths read this convenience global too.
  window.__TAURI__ = window.__TAURI__ || {};
  // Pre-enable the local tutor so a lens click streams immediately (consent is a
  // localStorage flag — see src/tutorConsent.ts), and pin the margin open so its
  // cards are visible for the screenshot.
  try {
    localStorage.setItem("rg.tutorEnabled", "true");
  } catch (_) {}
  window.__TAURI_DEMO__ = true; // marker the spec can assert the fake loaded
})();

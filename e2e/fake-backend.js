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
  // `usize.to_string()`), not the "char:N" tagged form used by note anchors —
  // and they are GLOBAL, contiguous body offsets (each section starts where the
  // previous one ends), exactly as the importer emits them.
  const SEC2_END = SECTION_TEXT.length;
  const SECTIONS = [
    { id: "sec_2", book_id: BOOK.id, label: "Book II", href: null, start_locator: "0", end_locator: String(SEC2_END), estimated_units: SECTION_TEXT.length, sort_order: 0 },
    { id: "sec_3", book_id: BOOK.id, label: "Book III", href: null, start_locator: String(SEC2_END), end_locator: String(SEC2_END + 900), estimated_units: 900, sort_order: 1 },
    { id: "sec_4", book_id: BOOK.id, label: "Book IV", href: null, start_locator: String(SEC2_END + 900), end_locator: String(SEC2_END + 1800), estimated_units: 900, sort_order: 2 },
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

  // Settings redesign: appearance prefs + automatic backups (Files pane).
  const APPEARANCE = { ui_theme: "", reading_typeface: "newsreader", reading_line_spacing: "comfortable" };
  let BACKUPS_ON = true;
  const LAST_BACKUP_AT = "2026-07-08T09:12:00-07:00";
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

  // The five-state TodayCard (Stage 2). The default is mid-book "reading";
  // flags flip it into the other states. Locators are bare-digit globals.
  const FIRST_PARA_END = SECTION_TEXT.indexOf("\n\n");
  const TODAY = {
    book: BOOK,
    plan: {
      id: "plan_1", book_id: BOOK.id, start_date: "2026-06-01", status: "active",
      activated_at: "2026-06-01T09:00:00Z", sitting_length_minutes: 25,
    },
    state: "reading",
    chapter_label: "Book II",
    phrase: null,
    estimated_minutes: 6,
    fraction_complete: 0.18,
    next_label: null,
    section: SECTIONS[0],
    sitting_start_locator: 0,
    sitting_end_locator: SECTION_TEXT.length,
    resume_locator: "0",
    resume_percent: null,
    memory: {
      last_capture: { note_type: "MarginNote", body: "The whole book in one line.", chapter_label: "Book II", created_at: "2026-06-06T08:10:00Z" },
      highlight_count: 1, note_count: 1,
    },
    teaser: null,
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

  // ── Library seed (handoff §1) ────────────────────────────────────────────────
  // A self-contained SVG "embedded cover" for the imported-with-cover case — no
  // external asset, so the cover renders identically in headless Chromium.
  const EMBED_COVER =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#1b2a33"/><stop offset="0.6" stop-color="#324653"/>' +
        '<stop offset="1" stop-color="#5b7384"/></linearGradient></defs>' +
        '<rect width="120" height="180" fill="url(#g)"/>' +
        '<text x="12" y="42" fill="#fff" font-family="Georgia" font-size="14" font-weight="700">Sapiens</text>' +
        '<text x="12" y="168" fill="rgba(255,255,255,.92)" font-family="Inter" font-size="8" letter-spacing="1.5">HARARI</text>' +
        "</svg>",
    );

  const LIB_TITLES = [
    "Walden", "Dracula", "The Trial", "Educated", "Emma", "Ulysses", "The Iliad",
    "Middlemarch", "Notes from Underground", "Crime and Punishment", "Frankenstein",
    "The Republic", "Heart of Darkness", "Sense & Sensibility", "Beyond Good & Evil",
    "Pride & Prejudice", "War and Peace", "The Odyssey", "Bleak House", "Anna Karenina",
  ];
  const LIB_AUTHORS = [
    "H. D. Thoreau", "Bram Stoker", "Franz Kafka", "Tara Westover", "Jane Austen",
    "James Joyce", "Homer", "George Eliot", "Dostoevsky", "Dostoevsky", "Mary Shelley",
    "Plato", "Joseph Conrad", "Jane Austen", "Friedrich Nietzsche", "Jane Austen",
    "Leo Tolstoy", "Homer", "Charles Dickens", "Leo Tolstoy",
  ];

  // Build an n-book library: index 0 is the active/featured book (the TODAY
  // book, so the featured card's progress matches the real card), index 2 is the
  // one imported-with-cover book (Sapiens), the rest are catalogue cloth covers;
  // roughly a third are finished. Recency descends with the index.
  function makeLibrary(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        out.push({
          id: BOOK.id, title: BOOK.title, author: BOOK.author, provenance: "imported",
          has_cover: false, finished: false, fraction: TODAY.fraction_complete,
          location: TODAY.chapter_label, last_opened_at: BOOK.last_opened_at, is_active: true,
        });
        continue;
      }
      const embed = i === 2;
      const finished = !embed && i % 3 === 0;
      out.push({
        id: embed ? "lib_embed" : "lib_" + i,
        title: embed ? "Sapiens" : LIB_TITLES[i % LIB_TITLES.length],
        author: embed ? "Yuval Noah Harari" : LIB_AUTHORS[i % LIB_AUTHORS.length],
        provenance: embed ? "imported" : "catalogue",
        has_cover: embed,
        finished,
        fraction: finished ? 1 : 0.12 + ((i * 13) % 70) / 100,
        location: "Chapter " + (1 + (i % 9)),
        last_opened_at: "2026-06-" + String(Math.max(1, 28 - i)).padStart(2, "0") + "T09:00:00Z",
        is_active: false,
      });
    }
    return out;
  }

  function libraryDefault() {
    if (window.__TL_FAKE_EMPTY__) return [];
    const n = window.__TL_FAKE_LIBRARY_N__;
    if (typeof n === "number") return makeLibrary(n);
    // The everyday case: the active book as a one-book library.
    return [{
      id: BOOK.id, title: BOOK.title, author: BOOK.author,
      provenance: window.__TL_FAKE_CATALOGUE__ ? "catalogue" : "imported",
      has_cover: false, finished: false, fraction: TODAY.fraction_complete,
      location: TODAY.chapter_label, last_opened_at: BOOK.last_opened_at, is_active: true,
    }];
  }

  // ── Command table ────────────────────────────────────────────────────────────
  function handle(cmd, args) {
    switch (cmd) {
      // window.__TL_FAKE_EMPTY__ → no books yet. The other flags pick a state:
      // __TL_FAKE_DONE__ → finished; __TL_FAKE_DAY_ONE__ → day_one;
      // __TL_FAKE_RETURNING__ → returning; __TL_FAKE_NO_PLAN__ → no_plan
      // (cmd_configure_plan clears it, so Begin reading lands in the reader);
      // __TL_FAKE_SPLIT_SITTING__ → the sitting is a sub-range of Book II.
      case "cmd_today": {
        const card = (() => {
          if (window.__TL_FAKE_EMPTY__) return null;
          if (window.__TL_FAKE_DONE__)
            return Object.assign({}, TODAY, { state: "finished", section: null, next_label: "Book XII", sitting_start_locator: null, sitting_end_locator: null, resume_locator: null, fraction_complete: 1 });
          if (window.__TL_FAKE_DAY_ONE__)
            return Object.assign({}, TODAY, { state: "day_one", fraction_complete: 0, resume_locator: null });
          if (window.__TL_FAKE_RETURNING__)
            return Object.assign({}, TODAY, { state: "returning", resume_locator: "64" });
          if (window.__TL_FAKE_NO_PLAN__)
            return Object.assign({}, TODAY, { state: "no_plan", section: null, sitting_start_locator: null, sitting_end_locator: null, resume_locator: null, plan: { id: "", book_id: BOOK.id, start_date: "2026-06-11", status: "no_plan", activated_at: null, sitting_length_minutes: null } });
          if (window.__TL_FAKE_SPLIT_SITTING__)
            return Object.assign({}, TODAY, { sitting_end_locator: FIRST_PARA_END });
          if (window.__TL_FAKE_PHRASE__)
            return Object.assign({}, TODAY, { phrase: "the morning resolve at the day's door" });
          if (window.__TL_FAKE_PHRASE_MAX__)
            return Object.assign({}, TODAY, {
              chapter_label: "The Second Book of the Meditations of Marcus Aurelius Antoninus, continued",
              phrase: "the busybody, the ungrateful, the arrogant, the deceitful, the envious met calmly",
            });
          return TODAY;
        })();
        // __TL_FAKE_LONG_TITLE__ (a string) overrides the book title at display
        // time — the long-title torture case for the bounded Today hero and, via
        // "Start a plan", the first-journey chosen screen.
        const longTitle = window.__TL_FAKE_LONG_TITLE__;
        return card && longTitle
          ? Object.assign({}, card, { book: Object.assign({}, card.book, { title: longTitle }) })
          : card;
      }
      case "cmd_get_settings": {
        const base = Object.assign({}, SETTINGS, APPEARANCE);
        // __TL_FAKE_DEEP_STUDY__ → the reader chose Deep Study margin help, so
        // TextReader mounts SectionBriefingCard for today's section. Combined
        // with __TL_FAKE_NEEDS_CONSENT__ this drives the FIRST-cloud briefing
        // through the same consent gate the lenses use (subject: "section").
        if (window.__TL_FAKE_DEEP_STUDY__) base.margin_help = "deep_study";
        if (window.__TL_FAKE_COMPANY_ACTIVE__ || window.__TL_FAKE_COMPANY_UNLICENSED__)
          return Object.assign(base, { ai_provider: "company", ai_remote_allowed: true, ai_local_only: false, ai_posture: "Sends your selection to ai.readthroughline.com", ai_model_anthropic: "claude-sonnet-4-6" });
        return window.__TL_FAKE_CLOUD__
          ? Object.assign(base, { ai_provider: "anthropic", ai_remote_allowed: true, ai_local_only: false, ai_posture: "Sends your selection to api.anthropic.com", ai_model_anthropic: "claude-sonnet-4-6" })
          : base;
      }
      case "cmd_company_status":
        if (window.__TL_FAKE_COMPANY_UNLICENSED__)
          return { provider_active: true, has_license: false };
        return window.__TL_FAKE_COMPANY_ACTIVE__
          ? { provider_active: true, has_license: true }
          : { provider_active: false, has_license: false };
      case "cmd_company_credits": {
        if (window.__TL_FAKE_COMPANY_UNLICENSED__) throw { kind: "Config", message: "Throughline AI isn't activated." };
        // Fraction-only credits (the proxy never sends dollars). Scenarios set
        // __TL_FAKE_REMAINING_FRACTION__ to drive the 75%/90%-used nudges.
        const rem = typeof window.__TL_FAKE_REMAINING_FRACTION__ === "number"
          ? window.__TL_FAKE_REMAINING_FRACTION__ : 0.75;
        return { status: "active", remaining_fraction: rem, approx_questions_left: Math.round(rem * 400) };
      }
      case "cmd_activate_company":
        window.__TL_FAKE_COMPANY_ACTIVE__ = true;
        window.__TL_FAKE_COMPANY_UNLICENSED__ = false;
        return { provider_active: true, has_license: true };
      case "cmd_company_checkout":
        return "https://checkout.stripe.com/c/pay/cs_test_fake123";
      case "cmd_open_support_email":
        window.__TL_FAKE_MAILTO_OPENED__ = true;
        return null;
      case "cmd_list_books": return window.__TL_FAKE_EMPTY__ ? [] : [BOOK];
      // ── library surface (handoff §1/§4) ──
      case "cmd_library": return libraryDefault();
      case "cmd_read_book_cover":
        return args && typeof args.bookId === "string" && args.bookId.indexOf("embed") !== -1
          ? EMBED_COVER
          : null;
      case "cmd_book_origin":
        return {
          provenance: window.__TL_FAKE_CATALOGUE__ ? "catalogue" : "imported",
          original_path: window.__TL_FAKE_MOVED_FILE__ ? "/Users/demo/Books/walden.epub" : null,
          original_missing: !!window.__TL_FAKE_MOVED_FILE__,
        };
      case "cmd_relink_book": window.__TL_FAKE_MOVED_FILE__ = false; return null;
      case "cmd_reveal_data_folder": window.__TL_FAKE_REVEAL_OPENED__ = true; return null;
      case "cmd_paths_info":
        return {
          app_support: "/Users/demo/Library/Application Support/Throughline",
          db_path: "/Users/demo/Library/Application Support/Throughline/reading.db",
          export_root: "/Users/demo/Documents/Throughline",
        };
      // The file picker (plugin-dialog) + a created import, so the one-time
      // data-folder moment can be driven in the walkthrough.
      case "plugin:dialog|open": return window.__TL_FAKE_PICK_PATH__ || null;
      case "cmd_import_book": {
        window.__TL_FAKE_EMPTY__ = false;
        return { book: Object.assign({}, BOOK, { id: "lib_embed", title: "Sapiens", author: "Yuval Noah Harari", source_type: "epub" }), created: true };
      }
      case "cmd_assignable_sections": return SECTIONS;
      case "cmd_list_notes": return NOTES.slice();
      case "cmd_read_section_text": return SECTION_TEXT;
      case "cmd_read_section_structure": return [];
      case "cmd_quote_warns": return false;
      case "cmd_set_active_book": return null;
      case "cmd_delete_book":
        // Removed → the library is now empty (single seeded book), so the next
        // cmd_today returns the front door. Mirrors the real reconciliation.
        window.__TL_FAKE_EMPTY__ = true;
        return null;
      case "cmd_configure_plan":
        // Configuring the plan resolves the plan-less state — the next
        // cmd_today serves the reading card, so Begin reading opens the reader.
        // (__TL_FAKE_STAY_PLANLESS__ keeps the section-less card to exercise
        // the Begin-reading fallback: never a section-less reader.)
        if (!window.__TL_FAKE_STAY_PLANLESS__) window.__TL_FAKE_NO_PLAN__ = false;
        return Object.assign({}, TODAY.plan, { sitting_length_minutes: (args && args.sittingLengthMinutes) || 25 });
      case "cmd_save_section_progress": return null;
      case "cmd_start_session":
        return { id: "sess_1", book_id: BOOK.id, started_at: nowIso(), ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null };
      case "cmd_end_session":
        return {
          session: { id: (args && args.sessionId) || "sess_1", book_id: BOOK.id, started_at: nowIso(), ended_at: nowIso(), start_locator: "char:0", end_locator: (args && args.endLocator) || null, minutes: (args && args.minutes) || null, completed_assignment: true, subjective_difficulty: null },
          export: { ok: true, message: null },
        };
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
        return { note: n, export: { ok: true, message: null } };
      }
      case "cmd_update_note": {
        const n = NOTES.find((x) => x.id === (args && args.noteId));
        if (n) { if (args.body != null) n.body = args.body; n.updated_at = nowIso(); }
        return n ? { note: n, export: { ok: true, message: null } } : null;
      }
      case "cmd_delete_note":
        NOTES = NOTES.filter((x) => x.id !== (args && args.noteId));
        return { ok: true, message: null };
      case "cmd_ai_preview":
        return { ai_request_id: "req_preview", mode: (args && args.mode) || "explain", mode_label: "Explain this passage", prompt: "Explain this passage from Meditations by Marcus Aurelius:\n\n“" + ((args && args.selection) || "") + "”", wrote_to_memory: false, provider: null };
      case "cmd_test_ai_connection":
        return { reachable: true, first_model_id: "gemma-4-31b-it-mlx", message: "ok" };
      case "cmd_list_ai_models": return ["gemma-4-31b-it-mlx", "qwen2.5-14b"];
      case "cmd_get_usage_summary":
        return {
          total_calls: 27, total_cost_micros: 540000, month_cost_micros: 180000,
          spend_cap_cents: 0, pricing_verified_at: "2026-06-08",
          by_provider: [{ key: "anthropic", calls: 27, cost_micros: 540000 }],
          by_lens: [{ key: "explain", calls: 18, cost_micros: 360000 }, { key: "historical", calls: 9, cost_micros: 180000 }],
        };
      case "cmd_set_monthly_spend_cap": return null;
      case "cmd_model_catalog": {
        const cat = {
          anthropic: [
            { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — best value", input_per_mtok: 3, output_per_mtok: 15, tier: "default" },
            { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest, cheapest", input_per_mtok: 1, output_per_mtok: 5, tier: "fast" },
            { id: "claude-opus-4-8", label: "Opus 4.8 — most capable (~5× cost)", input_per_mtok: 15, output_per_mtok: 75, tier: "power" },
          ],
          openai: [
            { id: "gpt-5.5", label: "GPT-5.5", input_per_mtok: 1.25, output_per_mtok: 10, tier: "default" },
            { id: "gpt-5-mini", label: "GPT-5 mini — cheapest", input_per_mtok: 0.25, output_per_mtok: 2, tier: "fast" },
          ],
          codex: [{ id: "gpt-5.5", label: "GPT-5.5 (via Codex login)", input_per_mtok: 1.25, output_per_mtok: 10, tier: "default" }],
        };
        return cat[(args && args.provider) || "anthropic"] || [];
      }
      case "cmd_list_ai_requests": return [];
      case "cmd_discover_seed": return DISCOVER_PAGE;
      case "cmd_discover_search":
        // The empty (mounted) query reports the whole-catalogue scale for the
        // header count; a typed query returns the seeded results.
        return (args && args.query) == null
          ? Object.assign({}, DISCOVER_PAGE, { count: 77386 })
          : DISCOVER_PAGE;
      case "cmd_discover_books_by_ids":
        // The curated doorways + front-door starters resolve through this. The
        // cell shows the AUTHORED title/author/blurb (from discoverShelves.ts);
        // the row only needs to exist + carry import URLs.
        return ((args && args.ids) || []).map((id) => ({
          id, title: "Catalogue " + id, author: "Author", language: "en",
          download_count: 100, has_txt: true, has_epub: true, txt_url: "x", epub_url: "y",
        }));
      case "cmd_get_reading_pace":
        // Default: not chosen yet → the chosen → pace step asks. A flag flips it
        // to a returning reader who skips the step.
        return window.__TL_FAKE_PACE_CHOSEN__
          ? { minutes: 25, chosen: true }
          : { minutes: 25, chosen: false };
      case "cmd_set_reading_pace":
        return { minutes: (args && args.minutes) || 25, chosen: true };
      case "cmd_check_export_path":
        return window.__TL_FAKE_EXPORT_BROKEN__
          ? { path: "/Volumes/USB/GBrain/Reading", writable: false, message: "Throughline can't save notes to this folder (No such file or directory)." }
          : { path: SETTINGS.export_path, writable: true, message: null };
      case "cmd_list_plans_for_book": {
        const live = { id: "p_live", book_id: BOOK.id, name: "Slow mornings", lifecycle: "active", status: "active", start_date: "2026-05-28", paused_days_total: 0, session_count: 9, note_count: 4, reached_percent: null };
        const past = [
          { id: "p3", book_id: BOOK.id, name: "Winter read", lifecycle: "paused", status: "rebalanced", start_date: "2026-01-03", paused_days_total: 0, session_count: 14, note_count: 7, reached_percent: 34 },
          { id: "p1", book_id: BOOK.id, name: "First attempt", lifecycle: "archived", status: "rebalanced", start_date: "2025-11-04", paused_days_total: 3, session_count: 6, note_count: 2, reached_percent: 22 },
        ];
        return window.__TL_FAKE_RESTING__ ? past : [live, ...past];
      }
      case "cmd_get_active_plan":
        return window.__TL_FAKE_RESTING__ ? null : { id: "p_live", book_id: BOOK.id, name: "Slow mornings", lifecycle: "active", status: "active", start_date: "2026-05-28", paused_days_total: 0, session_count: 9, note_count: 4, reached_percent: null };
      case "cmd_pause_plan": case "cmd_resume_plan": case "cmd_archive_plan": case "cmd_delete_plan":
      case "cmd_restore_plan": case "cmd_start_new_plan":
        return null;
      case "cmd_set_ai_settings":
        return handle("cmd_get_settings", {});
      // ── Settings redesign: appearance + backups + rail-footer version ──
      case "cmd_set_appearance":
        if (args && args.theme) APPEARANCE.ui_theme = args.theme;
        if (args && args.typeface) APPEARANCE.reading_typeface = args.typeface;
        if (args && args.lineSpacing) APPEARANCE.reading_line_spacing = args.lineSpacing;
        return handle("cmd_get_settings", {});
      case "cmd_feedback_diagnostics":
        // Keep in lockstep with the shipped version (package.json /
        // tauri.conf.json / Cargo.toml — `npm run version:check`), so the
        // Settings rail footer + feedback preview screenshots show the truth.
        return { app_version: "0.9.3", macos_version: "15.5", mode: "included" };
      case "cmd_backup_status":
        return { enabled: BACKUPS_ON, last_backup_at: BACKUPS_ON ? LAST_BACKUP_AT : null, undo_available: false };
      case "cmd_set_backups_enabled":
        BACKUPS_ON = !!(args && args.enabled);
        return { enabled: BACKUPS_ON, last_backup_at: BACKUPS_ON ? LAST_BACKUP_AT : null, undo_available: false };
      case "cmd_list_backups":
        return [
          { id: "reading-20260708-091200.db", taken_at: LAST_BACKUP_AT },
          { id: "reading-20260707-181500.db", taken_at: "2026-07-07T18:15:00-07:00" },
        ];
      case "cmd_restore_backup":
        window.__TL_FAKE_RESTORED__ = args && args.id;
        return null;
      case "cmd_set_ai_key": case "cmd_clear_ai_key":
      case "cmd_set_export_path": case "cmd_forget_ai_history": case "cmd_codex_logout":
        return null;
      // ── Updater (CORE-1192/1193). Default: up to date (null). Flags drive the
      // found/failing paths so the Software Update section and the pill can be
      // clicked end-to-end. The recorded __TL_FAKE_* markers are what the spec
      // asserts — a REAL click firing the REAL plugin IPC, observed at the
      // faked __TAURI_INTERNALS__ boundary.
      case "plugin:updater|check": {
        if (window.__TL_FAKE_UPDATE_CHECK_FAILS__) throw { message: "could not fetch a valid release JSON" };
        if (window.__TL_FAKE_UPDATE_AVAILABLE__ || window.__TL_FAKE_UPDATE_DOWNLOAD_FAILS__) {
          return {
            rid: 4242,
            currentVersion: "0.9.3", // the installed build (matches the repo version)
            version: "0.9.9", // the offered update — must stay greater than currentVersion
            date: null,
            body: null,
            rawJson: window.__TL_FAKE_UPDATE_CRITICAL__ ? { severity: "critical" } : {},
          };
        }
        return null;
      }
      case "plugin:updater|download_and_install": {
        if (window.__TL_FAKE_UPDATE_DOWNLOAD_FAILS__) throw { message: "signature mismatch" };
        const ch = args && args.onEvent;
        const emit = (ev) => { try { if (ch && typeof ch.onmessage === "function") ch.onmessage(ev); } catch (_) {} };
        emit({ event: "Started", data: { contentLength: 100 } });
        emit({ event: "Progress", data: { chunkLength: 42 } });
        emit({ event: "Progress", data: { chunkLength: 58 } });
        emit({ event: "Finished" });
        window.__TL_FAKE_UPDATE_DOWNLOADED__ = true;
        return null;
      }
      case "plugin:opener|open_url":
        window.__TL_FAKE_OPENED_URL__ = args && args.url;
        return null;
      case "plugin:process|restart":
        window.__TL_FAKE_RESTARTED__ = true;
        return null;
      case "cmd_prepare_update_relaunch_focus":
        window.__TL_FAKE_RELAUNCH_MARKER__ = true;
        return null;
      case "cmd_consume_update_relaunch_focus":
        return false;
      case "cmd_codex_device_start": return { user_code: "ABCD-1234", verification_uri: "https://example.com", device_code: "dev", interval: 5 };
      case "cmd_codex_device_poll": return { status: "pending" };
      case "cmd_import_book": case "cmd_import_from_gutendex":
        return { book: BOOK, created: false };
      // Tauri dialog plugin (file picker) — return no selection.
      case "plugin:dialog|open": return null;
      case "cmd_outbound_envelope":
        return {
          host: "api.anthropic.com",
          provider: "anthropic",
          // R6-1: the backend-issued consent binding. The fake accepts exactly
          // this value back in cmd_ai_ask's consent arg, mirroring the real
          // send-boundary validation.
          fingerprint: "fake-fingerprint-anthropic-" + ((args && args.selection) || "").length,
          envelope: {
            book_title: BOOK.title,
            author: BOOK.author,
            chapter: (args && args.chapter) || null,
            selection_bounded: (args && args.selection) || "",
            prompt: "You are a patient tutor.\n\n<<<UNTRUSTED_PASSAGE>>>\n" + ((args && args.selection) || "") + "\n<<<END_UNTRUSTED_PASSAGE>>>",
          },
        };
      default:
        // eslint-disable-next-line no-console
        console.warn("[fake-backend] unhandled command:", cmd, args);
        return null;
    }
  }

  // cmd_ai_ask streams via the Channel passed as args.onEvent, then resolves a handle.
  function handleAsk(args) {
    // C2/R6-1: first cloud send gated until a consent BINDING matching the
    // envelope this fake issued rides in with the ask (the real backend
    // validates provider + host + fingerprint at the send boundary and
    // records consent only on a match).
    if (window.__TL_FAKE_NEEDS_CONSENT__ && !window.__cloud_confirmed__) {
      const b = args && args.consent;
      const bound =
        b &&
        b.provider === "anthropic" &&
        b.host === "api.anthropic.com" &&
        b.fingerprint === "fake-fingerprint-anthropic-" + (((args && args.selection) || "").length);
      if (!bound) {
        return Promise.reject({ kind: "NeedsCloudConsent", host: "api.anthropic.com" });
      }
      window.__cloud_confirmed__ = true;
    }
    // CM6: company-paid cap spent.
    if (window.__TL_FAKE_CAP_EXHAUSTED__) {
      return Promise.reject({ kind: "CapExhausted" });
    }
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

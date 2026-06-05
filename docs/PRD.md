Throughline

TL;DR

Throughline is a focused, local-first macOS app that helps one serious reader import a DRM-free book, see exactly what to read today, complete a 15–30 minute reading session, capture one useful note, and export durable Markdown into a GBrain-style knowledgebase. The recommended path is Option C: build a tiny reading app first, use GBrain/Markdown as the durable substrate, and delay OpenClaw until the reading habit proves itself.

The product is not a generic e-reader, AI summary app, social reading app, Bible app, or personal OS. The MVP should prove one loop: import one book, create a daily plan, read today’s section, track progress, capture a note, and export safe Markdown.



Goals

Business Goals





Validate whether a focused reading surface increases serious reading consistency within a 14-day experiment.



Deliver a smallest useful macOS MVP in roughly two weeks without expanding into a personal OS.



Preserve durable reading notes in a local Markdown/GBrain-compatible structure from day one.



Establish a privacy-first and copyright-safe foundation for future AI-assisted reading.



De-risk the larger OpenClaw/GBrain rollout by proving the narrow daily reading habit before adding orchestration.

User Goals





Open the app and immediately know what to read today.



Read one serious book section for 15–30 minutes with low friction.



Capture one useful note tied to a source locator.



Stay on pace to finish roughly one serious book per month.



Export notes safely to local Markdown without uploading raw book text.

Non-Goals





Do not build a full “Noom for Reading” with broad coaching, gamification, local embeddings, Bible mode, review systems, and personal OS expansion in the MVP.



Do not build OpenClaw integration first; OpenClaw should be a later review/orchestration layer after the reading habit exists.



Do not build cloud sync, accounts, social features, mobile apps, DRM handling, PDF/OCR, quizzes, spaced repetition, or background/remote/unsolicited AI. (See "AI posture (updated)" below: local, reader-initiated tutor lenses and a session-triggered Deep Study briefing ARE in scope; AI that runs on a timer, on launch, in the background, or against a remote endpoint by default is NOT.)



User Stories

Primary reader: Nick, local-first serious reader





As a serious reader, I want to open the app and see today’s assigned reading, so that I do not waste willpower deciding what to do.



As a serious reader, I want the book to open where I left off, so that continuing is easier than procrastinating.



As a serious reader, I want to read for 15–30 minutes in a calm reading surface, so that serious books feel tractable.



As a serious reader, I want to capture one structured note tied to a locator, so that my reading produces durable thought instead of scattered highlights.



As a serious reader, I want missed days to generate recovery options, so that falling behind does not make me quit.

Local-first knowledge worker





As a local-first user, I want raw EPUB and text files to remain private and local, so that I can read without creating privacy or copyright risk.



As a local-first user, I want SQLite for operational app state and Markdown for durable notes, so that the system is both reliable and portable.



As a local-first user, I want exports to work with my GBrain-style folder, so that notes survive even if the app dies.

AI-assisted reader





As an AI-assisted reader, I want optional tutor-style prompts on selected passages, so that I can understand difficult text without outsourcing my thinking.



As an AI-assisted reader, I want remote AI disabled by default, so that raw book text is never uploaded accidentally.



As an AI-assisted reader, I want AI output to become a note only after I approve or edit it, so that the knowledgebase reflects my thinking.

Future reviewer





As a future reviewer, I want weekly review notes based on my Markdown exports, so that I can consolidate what I learned.



As a future reviewer, I want OpenClaw to read only approved Markdown notes later, so that orchestration does not become the first wedge.



Functional Requirements





Book Import (Priority: Day 1)





One-book library: Import one DRM-free EPUB or plain text file.



Local source preservation: Copy the source file into app storage under ~/Library/Application Support/Throughline/books/{book_id}/.



Source hash: Compute and store SHA-256 for every imported source file.



Metadata extraction: Attempt to extract title, author, and table of contents for EPUBs.



Text fallback: If EPUB rendering or parsing is brittle, support plain text import first and preserve EPUB support as a visible limitation.



Today Screen (Priority: Day 1)





Daily assignment: Show the current book and today’s assigned section.



Primary action: Show one dominant “Start Reading” action.



Pace indicator: Show monthly completion progress and whether the user is on pace, slightly behind, or in recovery.



Recovery prompt: If behind, offer shame-free options such as resume today, gentle catch-up, weekend catch-up, or extend finish date.



Reading Surface (Priority: Day 1)





Calm display: Render the current section in a focused reading view.



Saved location: Resume from the last known reading location.



Basic typography: Support font size, line width, and light/dark mode.



Minimal actions: Provide highlight, quick note, ask for help, mark confusion, and finish session.



No dashboard-first UX: Do not make graphs, libraries, or prompt playgrounds the default entry point.



Daily Reading Plan (Priority: Day 1)





Plan creation: Create a default 30-day plan or allow target finish date selection.



Section assignment: Divide by chapters/TOC where available; otherwise divide by approximate text length.



Pace tracking: Track on pace, behind, and recovery path states.



Catch-up behavior: Use gentle recovery options rather than punishment streaks.



Progress Tracking (Priority: Day 1)





Sessions: Track reading sessions with started time, ended time, minutes read, and completed assignment status.



Location: Store start and end locators for each session where possible.



Completion: Track current section, monthly completion percentage, total serious reading minutes, and notes created.



Difficulty: Optionally record subjective difficulty for later review.



Note Capture (Priority: Day 1)





Locator-attached notes: Tie each note to book ID, source hash, chapter label, and locator.



Note types: Support Observation, Question, Connection, Reflection, and Short Quote.



One-sentence closure: At session end, ask “What is one sentence you want to remember from today?”



Quote safety: Prefer paraphrase and reflection; warn above a short quote threshold such as 300 characters.



Markdown Export (Priority: Day 1)





GBrain target: Export to a user-selected folder, defaulting to ~/GBrain/Reading/.



Folder structure: Create Books, Sessions, Notes, Reviews, and _indexes directories.



Frontmatter: Include type, book_id, title, author, source_sha256, source_private, locator, chapter, and created fields as applicable.



Copyright posture: Do not export raw book text or bulk excerpts.



Stable files: Use stable IDs and predictable filenames to avoid duplicate note rot.



AI Stubs (Priority: Week 2)





Stub modes: Include Explain this passage, Historical context, Vocabulary/reference, Socratic questions, Extract durable note, and Prepare tomorrow’s reading.



No remote calls by default: tutor calls go to a local OpenAI-compatible endpoint; remote endpoints are refused while local-only is ON. (Historical note: the original MVP shipped prompt-preview-only stubs; the app has since added real local streaming — see "AI posture (updated)" below.)

AI posture (updated): AI is local-first and reader-initiated. (1) Tutor lenses (Explain/Context/Define/Socratic) fire only on a reader's passage selection + lens click and stream from the local endpoint. (2) Deep Study margin-help may generate a local "section briefing" — study prep for the section about to be read — ONLY after the reader chose Deep Study, started a session, and gave tutor consent. The briefing is cached, dismissable, regenerable, local-only, and never exported unless the reader saves it. No AI runs in the background, on a timer, on launch, or against a remote endpoint by default. AI output becomes a durable note + Markdown only on explicit save. Raw source text never leaves the device and is never exported.



Selected context only: AI prompt previews should use selected text or user notes, not entire raw books.



Save by approval: AI outputs must not write to Markdown or memory unless the user saves or approves them.



Settings (Priority: Week 2)





Export folder: Let the user select or type the GBrain export path.



Local storage visibility: Show app data location.



AI posture: Show “Local-only mode: ON” by default.



Quote safety: Surface the quote warning policy.



Tests and Documentation (Priority: Week 2)





Unit tests: Cover reading plan calculation, source hashing, Markdown export formatting, and quote length warning.



Integration-ish test: Create a sample text book, create a note, and export Markdown.



README: Include scope, non-goals, install/run instructions, local data paths, copyright/privacy posture, AI posture, rollback plan, limitations, and 14-day protocol.



User Experience

Entry Point & First-Time User Experience





The user launches Throughline as a local macOS app.



On first launch, the app explains the narrow loop: import one book, create a plan, read today, capture one note, export Markdown.



The app asks the user to import one DRM-free EPUB or text file.



The app copies the file locally, computes a source hash, extracts metadata when possible, and creates a default 30-day reading plan.



The app suggests ~/GBrain/Reading/ as the Markdown export target but does not require GBrain CLI or OpenClaw.



The app shows “Local-only mode: ON” and states that raw book files stay local.

Core Experience





Step 1: Open the app.





The default screen is Today.



The user sees one primary card: “Read this today.”



The card shows current book, assigned section, estimated time, monthly pace, and Start Reading.



The app does not open to a library, dashboard, analytics view, or AI prompt playground.



Step 2: Start today’s reading.





The user clicks Start Reading.



The reader opens exactly where the user left off or at today’s assigned start locator.



Typography is calm and uncluttered.



The note panel and AI tools are hidden until intentionally opened.



Step 3: Read the assigned section.





The user reads for 15–30 minutes or completes the assigned section.



Available actions are limited to quick note, highlight, ask for help, mark confusion, and finish session.



The app saves reading progress without requiring manual bookkeeping.



Step 4: Ask for help only when needed.





The user selects a sentence, paragraph, term, name, or event.



The user chooses a tutor-style AI stub such as Explain this passage or Historical context.



The app shows a prompt preview and a warning that remote AI is disabled and raw book text will not be uploaded.



No AI response is saved as a note without explicit user approval.



Step 5: Capture one useful note.





The user opens the note panel.



The app shows locator, chapter, note type, body, and optional short quote fields.



Note types are Observation, Question, Connection, Reflection, and Short Quote.



The app encourages paraphrase, reflection, and locators rather than large excerpts.



Step 6: End the session.





The app asks: “What is one sentence you want to remember from today?”



The user marks the assignment complete or saves partial progress.



The app updates session history, reading progress, and tomorrow’s assignment.



The app exports the session and note Markdown if export is configured.



Step 7: Recover from missed days.





If the user misses a day, the app does not lead with “streak broken.”



The app offers recovery paths: resume today, add 10 extra minutes for several sessions, weekend catch-up, extend finish date, or restart the current chapter.



The main message is “Next smallest step: 10 minutes.”

Advanced Features & Edge Cases





EPUB parsing may fail or produce weak TOC data; the app should preserve the source file and fall back to approximate divisions or plain text support.



Locators may vary by rendering engine; notes should include EPUB CFI when available, chapter href when available, and approximate percent as fallback.



Imported files must not be modified.



DRM-protected files are unsupported and must not be processed or circumvented.



If GBrain export path is missing, the app should save to SQLite and show export pending status.



If exported Markdown already exists, the app should update stable files or generate stable note filenames rather than create duplicates.



If quote length exceeds the warning threshold, the app should warn that fair use has no fixed safe word count and that the default posture is short quotes only for private study.

UI/UX Highlights





The app should feel like a serious desk, not a productivity cockpit.



Default screen is Today with one clear next action.



Use calm typography, generous margins, and minimal chrome.



Avoid childish gamification: no XP, badges, levels, leaderboards, mascots, confetti, or AI praise.



Use serious progress indicators: monthly completion, days read this month, total reading minutes, notes created, and recovery status.



Streaks should be gentle and secondary: “You read 4 of the last 7 days,” not “You lost your streak.”



AI should be intentionally summoned and visually secondary.



Accessibility should include keyboard navigation, readable contrast, scalable fonts, and dark mode.



Narrative

Nick wants to become the kind of person who reads serious books consistently, not the kind of person who endlessly designs systems for reading. He has a local-first workflow, a GBrain-style Markdown knowledgebase, and interest in future OpenClaw orchestration, but the hardest moment is simpler: after coffee, before email or Slack, he needs to open something and read today’s section.

Throughline turns that moment into a concrete routine. The app opens to a single prescription: the current book, today’s section, estimated time, and a Start Reading button. The reader resumes where he left off, keeps the interface calm, and makes notes available without turning the session into a dashboard. If he is confused, AI appears only as a tutor on selected text, not as an automatic chapter summary. At the end, he captures one sentence or note worth keeping, and the app exports safe Markdown with source locators into GBrain.

The product succeeds if it helps Nick read Augustine for 14 days instead of spending the month building infrastructure. GBrain remains the durable substrate. OpenClaw waits until there is enough real reading behavior and Markdown memory to review. The wedge is narrow by design: today’s reading, one session, one serious book, one durable note.



Success Metrics

User-Centric Metrics





Read at least 10 of 14 days during the initial experiment.



Read at least 250 total minutes during the initial experiment.



Create at least 8 useful notes worth keeping.



Start reading within 2 minutes of opening the app on at least 70% of reading days.



Maintain a subjective “felt like reading, not managing a system” score of at least 4 out of 5.



Still want to open the app on day 15.

Business Metrics





MVP delivered in roughly two weeks without expanding into excluded scope.



Reading time exceeds app-building time after day 2 of the experiment.



One serious book remains on pace for completion in roughly one month.



OpenClaw integration is not started until after at least 30 days of reading data.



GBrain Markdown exports are usable without requiring the app to remain alive.

Technical Metrics





Imported source files are copied locally and hashed successfully 100% of the time for supported file types.



Markdown export succeeds for book, session, and note files with valid frontmatter.



App can complete the core loop without cloud services, accounts, telemetry, or background agents.



EPUB/text reader saves and restores current location reliably for the test book.



Unit tests cover plan calculation, hashing, Markdown export, and quote warning logic.



App data can be backed up or removed using documented rollback steps.

Tracking Plan





App opened.



Book imported.



Source hash computed.



Reading plan created.



Today screen viewed.



Start Reading clicked.



Session started.



Session ended.



Assignment completed.



Reading minutes recorded.



Current locator saved.



Note created.



Note type selected.



Markdown export completed.



AI stub opened.



AI prompt preview generated.



Recovery option viewed.



Recovery option selected.



Export path configured.



App friction/crash reported manually during experiment.



Technical Considerations

Technical Needs





macOS desktop shell: Tauri v2 is the recommended shell for a small, local-first app.



Frontend: React, TypeScript, and Vite for fast iteration.



Backend commands: Rust commands for filesystem operations, hashing, SQLite access, and export operations where appropriate.



Operational database: SQLite database at ~/Library/Application Support/Throughline/reading.db.



Local files: Imported books stored under ~/Library/Application Support/Throughline/books/{book_id}/.



EPUB rendering: Use epub.js if feasible inside the webview; fall back to plain text if EPUB support slows the MVP.



Markdown export: Write GBrain-compatible files under ~/GBrain/Reading/ or a user-selected folder.



AI stubs: Implement prompt-preview UI only; no remote API calls by default.

Suggested SQLite tables:

books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT
);


book_sections (
id TEXT PRIMARY KEY,
book_id TEXT NOT NULL,
label TEXT NOT NULL,
href TEXT,
start_locator TEXT,
end_locator TEXT,
estimated_units INTEGER,
sort_order INTEGER NOT NULL
);

reading_plans (
id TEXT PRIMARY KEY,
book_id TEXT NOT NULL,
start_date TEXT NOT NULL,
target_finish_date TEXT NOT NULL,
daily_target_units INTEGER,
days_per_week INTEGER DEFAULT 6,
catchup_mode TEXT DEFAULT 'gentle'
);

reading_sessions (
id TEXT PRIMARY KEY,
book_id TEXT NOT NULL,
started_at TEXT NOT NULL,
ended_at TEXT,
start_locator TEXT,
end_locator TEXT,
minutes INTEGER,
completed_assignment INTEGER DEFAULT 0,
subjective_difficulty INTEGER
);

notes (
id TEXT PRIMARY KEY,
book_id TEXT NOT NULL,
session_id TEXT,
note_type TEXT NOT NULL,
locator TEXT NOT NULL,
chapter_label TEXT,
body TEXT NOT NULL,
short_quote TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
exported_markdown_path TEXT
);

ai_requests (
id TEXT PRIMARY KEY,
book_id TEXT NOT NULL,
mode TEXT NOT NULL,
locator TEXT,
context_char_count INTEGER,
provider TEXT,
created_at TEXT NOT NULL,
wrote_to_memory INTEGER DEFAULT 0
);




Integration Points





Local macOS filesystem for source storage, database, backups, and Markdown export.



GBrain-style Markdown folder structure:






Books/



Sessions/



Notes/



Reviews/



_indexes/



Optional future OpenClaw integration after the habit is proven:






Sunday review.



Plan adjustment.



Cross-domain note connections.



Durable note consolidation.



Optional future remote AI providers only after explicit user opt-in.



No GBrain CLI dependency in MVP.



No OpenClaw runtime dependency in MVP.

Data Storage & Privacy





Application data path:






~/Library/Application Support/Throughline/reading.db



~/Library/Application Support/Throughline/books/{book_id}/source.epub



~/Library/Application Support/Throughline/books/{book_id}/source.txt



~/Library/Application Support/Throughline/books/{book_id}/manifest.json



~/Library/Application Support/Throughline/books/{book_id}/toc.json



~/Library/Application Support/Throughline/backups/



Markdown export path:






~/GBrain/Reading/Books/



~/GBrain/Reading/Sessions/



~/GBrain/Reading/Notes/



~/GBrain/Reading/Reviews/



~/GBrain/Reading/_indexes/



Raw EPUB and text files remain local.



Remote AI is disabled by default.



No telemetry, accounts, cloud sync, or background agents in MVP.



Exported notes include source_private: true.



Exported notes use locators, paraphrases, reflections, and short quotes only when needed.



Public/export mode is explicitly excluded from MVP.

Example note frontmatter:

type: reading_note
book_id: book_abc123
title: "The Confessions of St. Augustine"
author: "Augustine of Hippo"
source_sha256: "..."
source_private: true
locator: "epubcfi(...)"
chapter: "Book II"
created: 2026-05-24

Scalability & Performance





Expected user load is one local user on one Mac.



Optimize for fast app open, quick resume, reliable export, and low cognitive overhead.



Avoid infrastructure built for multi-user, sync, accounts, or scale.



EPUB rendering should prioritize the test book and common DRM-free EPUBs, not every edge case.



SQLite backups should be simple, local, and inspectable.

Potential Challenges





EPUB parsing and rendering can become a trap; mitigate by supporting plain text fallback and limiting EPUB ambition.



The product can become procrastination-by-building; mitigate with a 14-day experiment and a rule that reading happens before development.



AI can replace thinking; mitigate by hiding AI until selected text or session context exists, disabling remote calls by default, and requiring approval before saving.



Copyright leakage can happen through exports or AI prompts; mitigate by keeping raw files local, limiting quotes, and exporting locators plus paraphrases.



OpenClaw can expand the project into agent infrastructure too early; mitigate by delaying it until after 30 days of reading data.



Note duplication can create memory rot; mitigate with stable IDs, canonical book notes, session backlinks, and weekly consolidation later.



Local-first data can be lost; mitigate with SQLite backups, Markdown exports, and optional Git for GBrain.



Milestones & Sequencing

Project Estimate

Small: 1–2 weeks for a focused MVP that proves the core loop with one DRM-free EPUB or text file.

The key constraint is not technical completeness. The key constraint is avoiding overbuild. If EPUB rendering slows the build, ship text import and a preserved EPUB file first.

Team Size & Composition





1 person who does everything: product, design, engineering, QA, and experiment operation.



Optional AI coding assistant: Claude Code or Codex for scaffolding and implementation support.



No separate design, backend, data, or infrastructure team is needed for the MVP.

Suggested Phases

Week 0: GBrain substrate and scope lock (0.5–1 day)





Key Deliverables:






Create ~/GBrain/Reading/ folder structure.



Create Markdown templates for book, session, note, and review files.



Confirm MVP non-goals.



Select the first test book, likely Augustine’s Confessions from a public-domain or DRM-free source.



Dependencies:






Local folder access.



Decision to delay OpenClaw.

Phase 1: App scaffold and local storage (1–2 days)





Key Deliverables:






Create Tauri v2, React, TypeScript, and Vite app.



Initialize Git repo under ~/Code/throughline or timestamped fallback.



Add README with scope and rollback plan.



Initialize SQLite database and migrations.



Implement app data directory creation.



Dependencies:






Node, package manager, Rust, Cargo, Xcode command line tools, and Tauri prerequisites.

Phase 2: Import, plan, and Today screen (2–3 days)





Key Deliverables:






Import DRM-free EPUB or text file.



Copy source file into app storage.



Compute SHA-256 and create book record.



Create default 30-day reading plan.



Show Today screen with current book, assignment, progress, and Start Reading.



Dependencies:






File picker.



SQLite commands.



Basic plan calculation logic.

Phase 3: Reader, progress, and notes (3–4 days)





Key Deliverables:






Render text content and attempt EPUB rendering via epub.js if feasible.



Save reading location and session progress.



Add Mark Today’s Section Complete.



Add note capture panel with required note types and locators.



Add one-sentence retention prompt at session end.



Dependencies:






Text parsing or EPUB rendering.



Locator strategy.



Session and note persistence.

Phase 4: Markdown export and AI stubs (2–3 days)





Key Deliverables:






Configure GBrain export folder.



Export book, session, and note Markdown files.



Include frontmatter, source hash, source_private flag, locators, and chapter labels.



Add quote length warning.



Add AI prompt-preview stubs with remote AI disabled by default.



Dependencies:






Filesystem permissions.



Markdown formatter.



Prompt preview UI.

Phase 5: Tests, README, and 14-day experiment start (1–2 days)





Key Deliverables:






Unit tests for plan calculation, hashing, Markdown export, and quote warning.



Integration-ish script for sample text import and note export.



README install/run instructions, local data paths, privacy posture, AI posture, rollback plan, and known limitations.



Begin 14-day Augustine experiment.



Dependencies:






Test runner setup.



One real sample book.

Post-MVP: 14-day usage experiment (2 weeks)





Key Deliverables:






Use the app every day before email/social.



Read for 20 minutes or complete the assigned section.



Capture one note per session.



Use AI stubs at most twice per day and only on selected text.



Track reading days, minutes, notes, AI usage, friction, feature work time, and subjective score.



Dependencies:






MVP must complete the core loop.



No major feature expansion during the experiment.

Decision after 14 days





Continue if:






At least 10 of 14 reading days.



At least 250 total minutes.



At least 8 useful notes.



Still on pace for the monthly book.



AI acted as tutor, not substitute.



App development did not dominate reading.



Simplify or stop if:






Fewer than 7 reading days.



More coding than reading after setup.



AI summaries replace reading.



Notes feel generic.



EPUB bugs dominate.



The app starts expanding into running, nutrition, Bible mode, or OpenClaw before finishing the book.

Month 2 candidates only if the experiment succeeds





Better catch-up mode.



Vocabulary/reference cards.



Argument map after reading.



Weekly review from session notes.



OpenClaw Sunday review over Markdown notes only.



Optional remote AI with explicit consent per request.



Local LLM exploration only after the core reading habit is stable.

Implementation handoff summary





Build the tiny reading app, not the life OS.



Make GBrain the durable substrate.



Delay OpenClaw.



Judge the product by whether it helps Nick read Augustine for 14 days, not whether the app feels exciting to build.

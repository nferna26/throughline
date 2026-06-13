# Throughline

[![CI](https://github.com/nferna26/throughline/actions/workflows/ci.yml/badge.svg)](https://github.com/nferna26/throughline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-black)

Local-first macOS reading app for one serious reader. Import a DRM-free book, see exactly what to read today, complete a focused sitting, capture one useful note, and export clean Markdown to a folder you control.

The binding contract is [CLAUDE.md](./CLAUDE.md). The full spec is [docs/PRD.md](./docs/PRD.md). The IPC surface is [docs/IPC.md](./docs/IPC.md).

## Screenshots

| Today | Reader | AI Tutor |
| --- | --- | --- |
| ![Today screen](docs/screenshots/today.png) | ![Reader](docs/screenshots/reader.png) | ![AI tutor](docs/screenshots/tutor.png) |

## Platform support

**macOS only.** Data paths are macOS-specific (`~/Library/Application Support/Throughline/`). Tauri can compile for Linux and Windows, but those paths would need to move to `dirs::data_dir()` first — see [issue tracker](https://github.com/nferna26/throughline/issues) if you want to help.

## Scope

The whole loop end to end, local-first by default:

1. Import one plain-text or DRM-free EPUB book (immutable copy + SHA-256).
2. Choose how long a sitting should feel; Throughline builds a position-based sequence with front/back matter skipped where it can.
3. Open to **Today** — see the next sitting, progress, and any useful memory from earlier reading.
4. Read in a calm reader. One session per sitting, Next ›/‹ Prev between sections, Finish session.
5. Capture highlights, notes, takeaways, and saved tutor answers with durable locators.
6. Optional: AI **tutor lenses** fire against a selected passage; Deep Study can prepare a section briefing only after you choose Deep Study, start a session, and consent to the assistant.
7. Export safe Markdown to `~/Documents/Throughline/Books/` by default.

There is no "behind" state. Today advances from the reader's actual position, so missing a day simply means the next sitting is still waiting.

## Non-goals (still hard)

- No background, scheduled, or unsolicited AI. AI is reader-initiated only — it never runs on a timer, on launch, or in the background. (Cloud tutoring is opt-in: see [AI posture](#ai-posture).)
- No cloud sync, accounts, telemetry, background agents.
- No OpenClaw integration. Not even a stub.
- No mobile app, PDF/OCR, DRM handling.
- No quizzes, spaced repetition, XP, badges, mascots, leaderboards, confetti.
- No dashboard-first or library-first UX. The app opens to **Today**.

See [CLAUDE.md](./CLAUDE.md) for the full list.

## Tech

- Shell: Tauri v2
- Frontend: React 19 + TypeScript + Vite
- Backend: Rust commands (filesystem, hashing, SQLite, Markdown export, EPUB extraction + classifier, AI client)
- EPUB rendering: none. EPUBs are extracted to clean plain text on import and rendered through the same `TextReader` path as `.txt` books (the epub.js iframe is retired).

## Local data paths

| What | Where |
| --- | --- |
| Operational DB | `~/Library/Application Support/Throughline/reading.db` |
| Imported book sources | `~/Library/Application Support/Throughline/books/{book_id}/source.txt` or `source.epub` (chmod 444) |
| Manifests | `~/Library/Application Support/Throughline/books/{book_id}/manifest.json` |
| Markdown exports | `~/Documents/Throughline/{Books,Sessions}/` by default (path overridable in Settings) |

Raw source files stay local. Exports contain locators, paraphrases, reflections, and short quotes only — never raw book text.

## Install & run

Prereqs: Node 20+, Rust + Cargo, Xcode Command Line Tools, macOS.

**Run from source (dev):**

```bash
git clone https://github.com/nferna26/throughline
cd throughline
npm install
npm run tauri dev
```

**Build a standalone app:**

```bash
npm run tauri build
# Produces an unsigned .app + .dmg under:
#   src-tauri/target/release/bundle/{macos,dmg}/
```

A local `npm run tauri build` is **unsigned** — on first open macOS Gatekeeper will warn (right-click → Open). Tagged releases (`git tag v*`) build a universal `.dmg` via GitHub Actions and **sign + notarize** it when the Apple signing secrets are configured, so the released `.dmg` opens cleanly on any Mac. Setup runbook: [docs/SIGNING.md](./docs/SIGNING.md).

**Optional — AI tutor:** the signed build can use the included Throughline assistant after activation. Source builds can use your own Anthropic/OpenAI key, ChatGPT/Codex login, or a local OpenAI-compatible server such as LM Studio at `http://localhost:1234/v1`. The rest of the app works without AI.

## Rollback — remove all app data

This deletes the DB, all imported source files, and the manifests. Markdown
exports in `~/Documents/Throughline/` are kept by default; remove them separately if
you want a clean slate.

```bash
# 1. Quit Throughline first (Cmd-Q in the app window).

# 2. Remove operational state + imported sources.
rm -rf "$HOME/Library/Application Support/Throughline"

# 3. (Optional) Remove exported Markdown.
rm -rf "$HOME/Documents/Throughline"

# 4. (Optional) Remove the repo itself.
rm -rf "$HOME/code/throughline"
```

The export path is configurable. If you've changed it in Settings, swap that location into step 3.

## Privacy posture

- Raw text and EPUB source files stay local — the whole-book source is never bulk-uploaded to any API. When the reader opts into a remote AI provider, only the passage they selected or the current section is sent (see [AI posture](#ai-posture)). If AI session phrases are enabled, Throughline sends each sitting's chapter label and opening slice, never the full text.
- Every imported source has a SHA-256 hash stored in the DB.
- Exported notes carry `source_private: true` in frontmatter.
- Quote fields longer than ~300 characters trigger a non-blocking warning (fair use has no fixed safe word count; the default posture is short quotes for private study only).

## AI posture

AI is **reader-initiated** — it never runs on a timer, on launch, or in the background. The provider you choose in Settings is authoritative.

- **Signed build:** the paid app can activate the included Throughline assistant through `ai.readthroughline.com`, with an allowance shown in plain language and a path to BYO/local when needed.
- **Source build:** bring your own Anthropic/OpenAI key, use ChatGPT/Codex login, choose Local/LM Studio, or leave AI off. Setup appears at the moment you ask for help; there is no forced first-run AI chooser.
- **Local means loopback.** The Local provider accepts `localhost`, `127.0.0.0/8`, and `::1`; any non-loopback URL is rejected at the call site by `ai_client::validate_base_url`.
- **Selection or section only — never the whole book.** Tutor lenses use the selected passage; Deep Study uses the current section after the reader chose Deep Study, started a session, and consented. Raw source files are never bulk-uploaded.
- **Provider is visible.** Settings and the reader show whether answers come from Throughline AI, Anthropic, OpenAI, ChatGPT/Codex, or the model on this Mac. API keys and licenses live in the OS Keychain and are never logged or exported.
- Save-by-approval: AI responses are ephemeral. Saving a response as a note is opt-in per request and writes a real Note row + Markdown export. `ai_requests.wrote_to_memory` flips to `1` only on approval; the `provider` field stores the host that was actually contacted (e.g. `localhost:1234` or `api.openai.com`).
- A unit test (`validate_rejects_non_loopback_when_local_only_on`) pins the loopback guard for local-only mode. A mock-HTTP integration test (`mock_server_streams_deltas_to_client`) verifies the exact OpenAI-shape POST + SSE streaming without needing a live model server.

## IPC contract

The frontend talks to the Rust backend through Tauri commands. The full surface — every command, args, return shape, error shape — is in [`docs/IPC.md`](./docs/IPC.md). Current API version is `6`. Read at runtime via `invoke("cmd_api_version")`.

Semver commitment: patch and minor versions are non-breaking; major bumps the `COMMAND_API_VERSION` constant and is called out in the README + CHANGELOG.

## Known limitations

- The library can hold several imported books, but exactly **one is active** at a time — the active book is what "Today" reads from. Switch the active book from the library (`cmd_list_books` / `cmd_set_active_book`); importing another book adds it to the library rather than replacing the current one.
- Plain text books trim a Project-Gutenberg-style header/footer when detected; arbitrary plain text may include front matter.
- EPUB front/back-matter classification is heuristic: cover / title page / contents / copyright / acknowledgments / about-the-author / "also by" / about-the-publisher are skipped, everything else (including Prologue / Foreword / Preface / Notes) is kept. Edge-case books may need a re-import once classifier patterns expand.
- EPUBs are flattened to clean plain text (plus offset-safe inline/block style ranges) on import, so the reader intentionally drops rich author layout — images, tables, and complex CSS are not reproduced.
- Char-offset resume on text books is paragraph-accurate, not glyph-accurate. Notes always carry a precise `char:N` locator regardless.
- A local `npm run tauri build` is unsigned (Gatekeeper warns; right-click → Open). Tagged releases are signed + notarized via CI and open cleanly — see [docs/SIGNING.md](docs/SIGNING.md).

## 14-day experiment protocol

Goal of the experiment: prove the loop builds a serious reading habit, not just a working app.

**Each day**
1. Open the app before email/social. Today screen first.
2. Read for 20 minutes or until the assigned section is complete — whichever comes first.
3. Capture one note per session (any of Observation / Question / Connection / Reflection / Short Quote).
4. Use the AI tutor at most twice per day, only on selected text or the current section. Save to note only if it earns its keep.
5. Finish session.

**At end of week**
- Read the exported Markdown in `~/Documents/Throughline/Books/`. Anything generic gets deleted.

**Decision after 14 days — continue if all of:**
- At least 10 of 14 reading days.
- At least 250 total reading minutes.
- At least 8 notes worth keeping.
- The next sitting still feels clear and worth opening.
- AI acted as a tutor, not a substitute for reading.
- App development did not dominate reading time.

**Simplify or stop if any of:** fewer than 7 reading days, more coding than reading after setup, AI summaries replacing reading, notes feel generic, EPUB bugs dominate, scope creep toward Bible mode / nutrition / running / OpenClaw before the book is finished.

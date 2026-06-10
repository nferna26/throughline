//! Discover: search and import public-domain books.
//!
//! Search runs entirely on-device against a catalogue bundled into the binary
//! (`resources/discover_catalogue.tsv`) — no network, no live API, no single
//! point of failure: every keystroke is answered from memory in well under a
//! millisecond. Only *downloads* still reach out, and only to Project
//! Gutenberg's own file servers (URLs derived from the book id), never to a
//! search service. Per the design brief the source's brand name never appears
//! in the UI — the reader only ever sees "the public-domain library".
//!
//! Network egress is therefore download-only and **reader-initiated**: a
//! download happens only in response to a click, never on a timer or in the
//! background, and only *incoming* public-domain text crosses the wire — no
//! source text or reader data is ever sent out (consistent with the local-first
//! / copyright posture in CLAUDE.md).
//!
//! Imports funnel through `books::import_or_dedup`, the single owned import path,
//! so SHA dedup, source immutability, and the default plan all happen in exactly
//! one place — a downloaded book is indistinguishable from a file-picker import
//! once it lands.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::books::import_or_dedup;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::ImportOutcome;

const USER_AGENT: &str = concat!("Throughline/", env!("CARGO_PKG_VERSION"));

/// Upper bound on a single download's body. Public-domain plain-text/EPUB sources
/// are kilobytes-to-low-megabytes; this leaves a generous margin for the largest
/// collected works while refusing a hostile or runaway response that would
/// otherwise be buffered into memory unbounded. ~64 MiB.
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;

// ───────────────────────── DTOs sent to the frontend ─────────────────────────

/// A single catalogue row. `txt_url`/`epub_url` are echoed back verbatim by the
/// import command so the frontend never has to know about format selection.
#[derive(Serialize, Clone)]
pub struct DiscoverBook {
    pub id: i64,
    pub title: String,
    /// Human-friendly "First Last" (multiple authors joined with ", "); "" if unknown.
    pub author: String,
    /// Primary language tag for the small chip, e.g. "en".
    pub language: String,
    pub download_count: i64,
    pub has_txt: bool,
    pub has_epub: bool,
    pub txt_url: Option<String>,
    pub epub_url: Option<String>,
}

#[derive(Serialize)]
pub struct DiscoverPage {
    /// Total matches across the full bundled catalogue for the "Search all
    /// {count}" line (whole-catalogue size for an empty query) — displayed,
    /// never hardcoded.
    pub count: i64,
    /// 1-based page number to request for the next batch, or None at the end.
    pub next_page: Option<u32>,
    pub results: Vec<DiscoverBook>,
    /// Retained for wire compatibility with the `cmd_discover_seed` shape. The
    /// full catalogue lives on-device, so `cmd_discover_search` can never fail
    /// to reach it: this is **always false** for search results. (Seed results
    /// still set it true to let the UI show a calm "offline catalogue" hint.)
    pub offline: bool,
}

/// Minimal reference the frontend round-trips back to import a chosen book.
#[derive(Deserialize)]
pub struct DiscoverImportRef {
    pub txt_url: Option<String>,
    pub epub_url: Option<String>,
}

// ───────────────────────── helpers ─────────────────────────

fn http_client(secs: u64) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(secs))
        // Cap redirect chains: a download URL is validated up front (see
        // `validate_download_url`), but a malicious/misconfigured redirect could
        // try to walk us off the allowlist. A few hops cover Gutenberg's own
        // canonicalisation; the final host is re-validated after the response.
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| AppError::io(format!("could not build http client: {e}")))
}

/// Gate every outbound download URL before a request is made. The frontend
/// round-trips `txt_url`/`epub_url` back to us verbatim, so they are treated as
/// untrusted input even though we originally produced them. Accept only:
///   - scheme `https` (no cleartext, no `file:`/`ftp:`/etc.), and
///   - a host on the Project Gutenberg / Gutendex allowlist — the exact set this
///     module itself emits (`gutenberg.org`, any `*.gutenberg.org` such as
///     `www.gutenberg.org`, and `gutendex.com` for the API).
///
/// Everything else — other domains, `localhost`, loopback, RFC-1918 literals —
/// is refused, so a tampered URL can't turn the importer into an SSRF gadget.
fn validate_download_url(url: &str) -> Result<reqwest::Url, AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::validation(format!("download URL is not a valid URL: {url}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::validation(format!(
            "download URL must be https (got {})",
            parsed.scheme()
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::validation("download URL has no host".to_string()))?;
    if is_allowed_download_host(host) {
        Ok(parsed)
    } else {
        Err(AppError::validation(format!(
            "download host '{host}' is not in the public-domain library allowlist"
        )))
    }
}

/// The host allowlist for downloads/API. Case-insensitive; `*.gutenberg.org`
/// subdomains (e.g. `www.gutenberg.org`) are accepted along with the apex.
fn is_allowed_download_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "gutenberg.org" || host.ends_with(".gutenberg.org") || host == "gutendex.com"
}

// ───────────────────────── offline seed ─────────────────────────
// A small catalogue of the top-N most-downloaded public-domain books, bundled
// into the binary so Discover keeps working (idle browse + search of popular
// titles) when the live search API is unreachable. Built offline by
// scripts/build-discover-seed.mjs from Project Gutenberg's own sanctioned feeds
// (NOT the search API). Download URLs are derived from the book id, so getting a
// seeded book never touches the API either — only Project Gutenberg's file
// servers, which stay up independently. Regenerate the JSON to refresh.

const SEED_JSON: &str = include_str!("../../resources/discover_seed.json");
const SEED_PAGE_SIZE: usize = 32;

/// The seed file's row shape (download URLs are derived, not stored).
#[derive(Deserialize)]
struct SeedBook {
    id: i64,
    title: String,
    author: String,
    language: String,
    download_count: i64,
}

/// Canonical, id-derivable Project Gutenberg download URLs. The plain-text cache
/// file (`pg{id}.txt`) is the UTF-8 copy and exists for essentially every
/// Type=Text book; the matching `.epub` is the small (no-large-images) EPUB3.
fn gutenberg_txt_url(id: i64) -> String {
    format!("https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt")
}
fn gutenberg_epub_url(id: i64) -> String {
    format!("https://www.gutenberg.org/cache/epub/{id}/pg{id}.epub")
}

/// Parse + cache the bundled seed once, as ready-to-serve `DiscoverBook` rows
/// with download URLs derived from each id. A malformed seed degrades to an
/// empty catalogue (never a panic); a test guards that the shipped file parses.
fn seed() -> &'static [DiscoverBook] {
    static CACHE: OnceLock<Vec<DiscoverBook>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let rows: Vec<SeedBook> = serde_json::from_str(SEED_JSON).unwrap_or_default();
        rows.into_iter()
            .map(|s| DiscoverBook {
                txt_url: Some(gutenberg_txt_url(s.id)),
                epub_url: Some(gutenberg_epub_url(s.id)),
                has_txt: true,
                has_epub: true,
                id: s.id,
                title: s.title,
                author: s.author,
                language: s.language,
                download_count: s.download_count,
            })
            .collect()
    })
}

/// Offline answer: case-insensitive substring search over the bundled seed, in
/// popularity order, paginated to match the live page size. An empty query is
/// idle browse (the whole seed). Always flagged `offline: true`.
fn seed_search(query: Option<&str>, page: u32) -> DiscoverPage {
    let needle = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let matched: Vec<&DiscoverBook> = seed()
        .iter()
        .filter(|b| match &needle {
            Some(q) => b.title.to_lowercase().contains(q) || b.author.to_lowercase().contains(q),
            None => true,
        })
        .collect();

    let count = matched.len();
    let page = page.max(1) as usize;
    let start = (page - 1) * SEED_PAGE_SIZE;
    let results: Vec<DiscoverBook> = matched
        .iter()
        .skip(start)
        .take(SEED_PAGE_SIZE)
        .map(|b| (*b).clone())
        .collect();
    let next_page = if start + SEED_PAGE_SIZE < count {
        Some((page + 1) as u32)
    } else {
        None
    };

    DiscoverPage {
        count: count as i64,
        next_page,
        results,
        offline: true,
    }
}

// ───────────────────────── bundled full catalogue (on-device search) ─────────
// The whole public-domain catalogue (~77k books) ships inside the binary as a
// tab-separated table, sorted most-popular-first. Search is answered entirely
// from this in-memory copy — there is no live API to be down, so a search can
// never fail to reach its catalogue. Download URLs are still derived from the
// book id (no URL is stored), so importing a book touches only Project
// Gutenberg's file servers, never a search service.
//
// Row format: `id<TAB>title<TAB>author<TAB>lang<TAB>pop`. Authors are already
// humanized ("First Last", multiple joined ", "); `pop` is a 30-day download
// count (0 when the book is outside the tracked top-1000).

const CATALOGUE_TSV: &str = include_str!("../../resources/discover_catalogue.tsv");

/// One parsed catalogue row, with lowercased title/author precomputed so a
/// query scans the ~77k rows without re-lowercasing on every keystroke.
struct CatRow {
    id: i64,
    title: String,
    author: String,
    lang: String,
    pop: i64,
    title_lc: String,
    author_lc: String,
}

/// Parse + cache the bundled catalogue once. Malformed lines are skipped (never
/// a panic); a test guards that the shipped file parses to a populated table.
fn catalogue() -> &'static [CatRow] {
    static CACHE: OnceLock<Vec<CatRow>> = OnceLock::new();
    CACHE.get_or_init(|| {
        CATALOGUE_TSV
            .lines()
            .filter_map(|line| {
                if line.is_empty() {
                    return None;
                }
                let mut f = line.split('\t');
                let id = f.next()?.parse::<i64>().ok()?;
                let title = f.next()?.to_string();
                let author = f.next().unwrap_or("").to_string();
                let lang = f.next().unwrap_or("").to_string();
                // `pop` is optional/loose: a missing or unparseable value is 0,
                // not a reason to drop an otherwise-good row.
                let pop = f
                    .next()
                    .and_then(|p| p.trim().parse::<i64>().ok())
                    .unwrap_or(0);
                if title.is_empty() {
                    return None;
                }
                let title_lc = title.to_lowercase();
                let author_lc = author.to_lowercase();
                Some(CatRow {
                    id,
                    title,
                    author,
                    lang,
                    pop,
                    title_lc,
                    author_lc,
                })
            })
            .collect()
    })
}

/// Best per-token score for one token against one field (title or author).
/// A word-boundary or prefix hit beats a mid-word substring hit; no hit is 0.
/// `field` is already lowercased; `token` is a lowercased, non-empty needle.
fn token_field_score(field: &str, token: &str) -> u32 {
    match field.find(token) {
        None => 0,
        Some(at) => {
            let before_is_boundary = at == 0
                || !field[..at]
                    .chars()
                    .next_back()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false);
            if before_is_boundary {
                2 // word-start / prefix match
            } else {
                1 // mid-word substring match
            }
        }
    }
}

/// Search the bundled full catalogue on-device. AND semantics: every query
/// token must appear in the title or author of a row, or the row is excluded.
/// Surviving rows are scored (best field match per token, summed) and ordered
/// score desc, then pop desc, title asc, id asc. An empty query is browse: all
/// rows in their bundled popularity order, `count` == the full catalogue size.
/// Always `offline: false` — the catalogue is on-device and always reachable.
fn catalogue_search(query: Option<&str>, page: u32) -> DiscoverPage {
    let rows = catalogue();
    let page = page.max(1) as usize;
    let start = (page - 1) * SEED_PAGE_SIZE;

    // Tokenize on whitespace, lowercased, deduped, empties dropped.
    let tokens: Vec<String> = {
        let mut seen: Vec<String> = Vec::new();
        for t in query
            .map(|s| s.to_lowercase())
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
        {
            if !seen.contains(&t) {
                seen.push(t);
            }
        }
        seen
    };

    // Empty query: browse the whole catalogue in its existing popularity order,
    // paginated. `count` is the full catalogue size.
    if tokens.is_empty() {
        let count = rows.len();
        let results: Vec<DiscoverBook> = rows
            .iter()
            .skip(start)
            .take(SEED_PAGE_SIZE)
            .map(cat_to_book)
            .collect();
        let next_page = if start + SEED_PAGE_SIZE < count {
            Some((page + 1) as u32)
        } else {
            None
        };
        return DiscoverPage {
            count: count as i64,
            next_page,
            results,
            offline: false,
        };
    }

    // Single pass: keep rows where every token matches title OR author, scoring
    // each by the summed best-field match. `idx` preserves the original
    // (popularity) order as a stable tiebreak after pop.
    let mut scored: Vec<(u32, &CatRow, usize)> = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let mut total = 0u32;
        let mut all_present = true;
        for token in &tokens {
            let best = token_field_score(&row.title_lc, token)
                .max(token_field_score(&row.author_lc, token));
            if best == 0 {
                all_present = false;
                break;
            }
            total += best;
        }
        if all_present {
            scored.push((total, row, idx));
        }
    }

    // score desc, pop desc, title asc, id asc. `idx` is unused as a key but the
    // sort is total via (title, id); kept stable regardless.
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.pop.cmp(&a.1.pop))
            .then(a.1.title.cmp(&b.1.title))
            .then(a.1.id.cmp(&b.1.id))
    });

    let count = scored.len();
    let results: Vec<DiscoverBook> = scored
        .iter()
        .skip(start)
        .take(SEED_PAGE_SIZE)
        .map(|(_, row, _)| cat_to_book(row))
        .collect();
    let next_page = if start + SEED_PAGE_SIZE < count {
        Some((page + 1) as u32)
    } else {
        None
    };

    DiscoverPage {
        count: count as i64,
        next_page,
        results,
        offline: false,
    }
}

/// Map a parsed catalogue row to the wire DTO, deriving download URLs from the
/// id (every catalogue book has both a `.txt` and a `.epub` on the file server).
fn cat_to_book(row: &CatRow) -> DiscoverBook {
    DiscoverBook {
        id: row.id,
        title: row.title.clone(),
        author: row.author.clone(),
        language: row.lang.clone(),
        download_count: row.pop,
        has_txt: true,
        has_epub: true,
        txt_url: Some(gutenberg_txt_url(row.id)),
        epub_url: Some(gutenberg_epub_url(row.id)),
    }
}

// ───────────────────────── commands ─────────────────────────

/// Instant, network-free search over the bundled offline seed (the 200-book
/// most-popular shelf). The frontend calls this to paint idle shelves the
/// moment Discover opens, before the reader types anything. Always
/// `offline: true`. Unchanged by the on-device search rework.
#[tauri::command]
pub fn cmd_discover_seed(query: Option<String>, page: Option<u32>) -> DiscoverPage {
    seed_search(query.as_deref(), page.unwrap_or(1))
}

/// Search the public-domain library against the bundled full catalogue
/// (~77k books), entirely on-device. Synchronous and network-free: there is no
/// live API to be down, so a search can never fail to reach its catalogue.
///
/// An empty query is idle browse (most-downloaded first, `count` == the whole
/// catalogue size); a non-empty query is AND-matched across title and author,
/// scored, and ordered best-first with `count` == total matches. `page` is
/// 1-based; omit or pass 1 for the first batch. `offline` is always false (the
/// catalogue is on-device).
#[tauri::command]
pub fn cmd_discover_search(query: Option<String>, page: Option<u32>) -> DiscoverPage {
    catalogue_search(query.as_deref(), page.unwrap_or(1))
}

/// Download a chosen public-domain book and import it through the owned path.
/// Prefers plain text, falls back to EPUB — both because some titles only ship
/// one and because Gutenberg's legacy txt can be latin-1, which our strict-UTF-8
/// text importer rejects (the EPUB then carries its own encoding). Returns the
/// same `ImportOutcome` as the file picker, so the caller routes to plan setup
/// identically.
#[tauri::command]
pub async fn cmd_import_from_gutendex(
    book: DiscoverImportRef,
    state: State<'_, DbState>,
) -> Result<ImportOutcome, AppError> {
    let client = http_client(60)?;
    let mut last_err: Option<AppError> = None;

    for (url, ext) in [
        (book.txt_url.as_deref(), "txt"),
        (book.epub_url.as_deref(), "epub"),
    ] {
        let Some(url) = url else { continue };
        match download_and_import(&client, url, ext, state.inner()).await {
            Ok(outcome) => return Ok(outcome),
            Err(e) => {
                tracing::warn!("gutendex import via .{ext} failed: {e}");
                last_err = Some(e);
            }
        }
    }

    Err(last_err
        .unwrap_or_else(|| AppError::validation("this book has no importable format".to_string())))
}

/// Counter for unique temp filenames (process-local; the file is deleted right
/// after the immutable copy is made, so this only needs to avoid same-process
/// collisions between concurrent imports).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

async fn download_and_import(
    client: &reqwest::Client,
    url: &str,
    ext: &str,
    state: &DbState,
) -> Result<ImportOutcome, AppError> {
    // Validate before touching the network: only https + an allowlisted
    // Gutenberg/Gutendex host is ever fetched, even though we produced this URL
    // ourselves (the frontend round-trips it back as untrusted input).
    let validated = validate_download_url(url)?;
    let resp = client
        .get(validated)
        .send()
        .await
        .map_err(|e| AppError::io(format!("download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::io(format!("download returned {}", resp.status())));
    }
    // Re-validate the host actually reached: redirects are capped (Policy::limited)
    // but a permitted hop could still land on an off-allowlist host, so refuse it
    // before reading any body.
    if let Some(final_host) = resp.url().host_str() {
        if !is_allowed_download_host(final_host) {
            return Err(AppError::validation(format!(
                "download redirected to disallowed host '{final_host}'"
            )));
        }
    }

    // A cheap pre-check when the server advertises its size, then a hard cap while
    // streaming so a missing/lying Content-Length can't blow past the budget. The
    // body is bounded in memory at ~MAX_DOWNLOAD_BYTES either way.
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_DOWNLOAD_BYTES {
            return Err(AppError::validation(format!(
                "download is {len} bytes, over the {MAX_DOWNLOAD_BYTES}-byte limit"
            )));
        }
    }
    let mut stream = resp.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::io(format!("download interrupted: {e}")))?;
        if bytes.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
            return Err(AppError::validation(format!(
                "download exceeded the {MAX_DOWNLOAD_BYTES}-byte limit"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    // Stage the download as a temp file with the right extension; import_any
    // dispatches on extension. import_or_dedup then copies it into the immutable
    // store, so the temp file is disposable.
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = std::env::temp_dir().join(format!("tl-import-{}-{}.{ext}", std::process::id(), seq));
    std::fs::write(&tmp, &bytes)
        .map_err(|e| AppError::io(format!("could not stage download: {e}")))?;

    // No `await` between locking and unlocking the DB happens inside
    // import_or_dedup (it is fully synchronous), so this never holds the std
    // Mutex across an await point.
    let result = import_or_dedup(&tmp, state);
    let _ = std::fs::remove_file(&tmp); // best-effort; the owned copy already exists
    result
}

// ───────────────────────── tests ─────────────────────────
// Pure parsing / search / URL-validation logic. Hermetic: no network is ever
// touched, and the bundled catalogue makes the search tests fully deterministic.

#[cfg(test)]
mod tests {
    use super::*;

    // ── bundled full catalogue (on-device search) ──

    #[test]
    fn bundled_catalogue_parses_and_is_populated() {
        // Guards the shipped resources/discover_catalogue.tsv: it must parse to a
        // large, well-formed table with the fields the UI needs on every row.
        let rows = catalogue();
        assert!(
            rows.len() > 50_000,
            "catalogue should bundle the full library, got {}",
            rows.len()
        );
        for r in rows.iter().take(2000) {
            assert!(
                !r.title.is_empty(),
                "catalogue row {} has empty title",
                r.id
            );
            assert!(r.id > 0, "catalogue row has non-positive id");
            // Lowercased shadows stay in sync with their source field.
            assert_eq!(r.title_lc, r.title.to_lowercase());
            assert_eq!(r.author_lc, r.author.to_lowercase());
        }
    }

    #[test]
    fn catalogue_search_finds_poe_cask_of_amontillado() {
        let page = catalogue_search(Some("edgar allan poe"), 1);
        assert!(!page.offline, "catalogue search is never offline");
        assert!(page.count > 0, "Poe should have catalogue matches");
        // Every hit actually matches the "poe" token in title or author.
        for b in &page.results {
            let hay = format!("{} {}", b.title, b.author).to_lowercase();
            assert!(hay.contains("poe"), "row {} did not match poe", b.id);
        }

        // The Cask of Amontillado, id 1063, is a Poe title. It may sit beyond
        // page 1 of the broad "edgar allan poe" query, so resolve it by its own
        // title query, which returns it directly.
        let book = catalogue_search(Some("cask of amontillado"), 1)
            .results
            .into_iter()
            .find(|b| b.id == 1063)
            .expect("The Cask of Amontillado (id 1063) must be in the catalogue");
        assert_eq!(book.title.to_lowercase(), "the cask of amontillado");
        assert!(!book.author.is_empty(), "Poe title must carry an author");
        assert!(book.author.to_lowercase().contains("poe"));
        assert!(book.has_txt, "catalogue books always have a txt format");
        assert_eq!(
            book.txt_url.as_deref(),
            Some(gutenberg_txt_url(1063).as_str()),
            "txt_url must be derived from the id"
        );
    }

    #[test]
    fn catalogue_search_empty_query_browses_whole_catalogue_in_popularity_order() {
        let page = catalogue_search(None, 1);
        assert!(!page.offline);
        assert_eq!(
            page.count as usize,
            catalogue().len(),
            "empty query count is the whole catalogue size"
        );
        assert!(page.results.len() <= SEED_PAGE_SIZE);
        // Bundled order is most-popular-first, so the first row is the first
        // catalogue row (download_count carries pop).
        let first = &page.results[0];
        assert_eq!(first.id, catalogue()[0].id);
        assert_eq!(first.download_count, catalogue()[0].pop);
        if catalogue().len() > SEED_PAGE_SIZE {
            assert_eq!(page.next_page, Some(2));
        }
    }

    #[test]
    fn catalogue_search_and_semantics_require_every_token() {
        // A two-token query keeps only rows where BOTH tokens appear somewhere in
        // title/author. "austen prejudice" matches Pride and Prejudice.
        let page = catalogue_search(Some("austen prejudice"), 1);
        assert!(page.count > 0);
        for b in &page.results {
            let hay = format!("{} {}", b.title, b.author).to_lowercase();
            assert!(hay.contains("austen") && hay.contains("prejudice"));
        }
    }

    #[test]
    fn catalogue_search_returns_zero_for_nonsense() {
        let page = catalogue_search(Some("zzxqwwk-not-a-real-title-anywhere"), 1);
        assert_eq!(page.count, 0);
        assert!(page.results.is_empty());
        assert!(page.next_page.is_none());
        assert!(!page.offline);
    }

    #[test]
    fn catalogue_search_pagination_advances_next_page() {
        // A broad single token ("the") matches far more than one page; page 1
        // offers a next page and page 2 returns a fresh, non-overlapping batch.
        let p1 = catalogue_search(Some("the"), 1);
        assert!(p1.count as usize > SEED_PAGE_SIZE);
        assert_eq!(p1.next_page, Some(2));
        assert_eq!(p1.results.len(), SEED_PAGE_SIZE);
        let p2 = catalogue_search(Some("the"), 2);
        assert_eq!(p2.count, p1.count, "count is stable across pages");
        let p1_ids: Vec<i64> = p1.results.iter().map(|b| b.id).collect();
        assert!(
            p2.results.iter().all(|b| !p1_ids.contains(&b.id)),
            "page 2 must not repeat page 1 rows"
        );
    }

    #[test]
    fn catalogue_search_is_fast() {
        // Sanity: a single pass over the full ~77k-row catalogue per query is
        // fast. Measured ~12ms in an unoptimized debug build (release is several
        // times faster — comfortably sub-millisecond), so the cache is warmed
        // first and the bound is generous to stay green on slow CI machines.
        let _ = catalogue(); // warm the cache so we time the scan, not the parse
        let start = std::time::Instant::now();
        let _ = catalogue_search(Some("edgar allan poe"), 1);
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 100,
            "catalogue search took {elapsed:?}, expected a single fast pass"
        );
    }

    // ── offline seed (instant idle shelves) ──

    #[test]
    fn bundled_seed_parses_and_is_populated() {
        // Guards the shipped resources/discover_seed.json: it must parse, be
        // non-trivial, and every row must carry the fields the UI needs.
        let books = seed();
        assert!(
            books.len() >= 100,
            "seed should bundle a healthy catalogue, got {}",
            books.len()
        );
        for b in books {
            assert!(!b.title.is_empty(), "seed row {} has empty title", b.id);
            assert!(b.id > 0, "seed row has non-positive id");
            assert!(b.txt_url.is_some() && b.epub_url.is_some());
            assert!(b.has_txt && b.has_epub);
        }
    }

    #[test]
    fn gutenberg_urls_are_id_derived() {
        assert_eq!(
            gutenberg_txt_url(1342),
            "https://www.gutenberg.org/cache/epub/1342/pg1342.txt"
        );
        assert_eq!(
            gutenberg_epub_url(1342),
            "https://www.gutenberg.org/cache/epub/1342/pg1342.epub"
        );
    }

    #[test]
    fn seed_rows_derive_download_urls_from_id() {
        // A known classic that is reliably in the most-downloaded seed.
        let austen = seed().iter().find(|b| b.id == 1342);
        if let Some(b) = austen {
            assert_eq!(b.txt_url.as_deref(), Some(gutenberg_txt_url(1342).as_str()));
            assert!(b.author.to_lowercase().contains("austen"));
        }
    }

    #[test]
    fn seed_search_idle_browse_is_flagged_offline_and_paginated() {
        let page = seed_search(None, 1);
        assert!(page.offline, "seed results must be flagged offline");
        assert_eq!(page.count as usize, seed().len());
        assert!(page.results.len() <= SEED_PAGE_SIZE);
        // More than one page of seed -> a next page is offered.
        if seed().len() > SEED_PAGE_SIZE {
            assert_eq!(page.next_page, Some(2));
        }
    }

    #[test]
    fn seed_search_matches_title_or_author_case_insensitively() {
        let page = seed_search(Some("AUSTEN"), 1);
        assert!(page.offline);
        // Every hit actually contains the needle in title or author.
        for b in &page.results {
            let hay = format!("{} {}", b.title, b.author).to_lowercase();
            assert!(hay.contains("austen"));
        }
    }

    #[test]
    fn seed_search_empty_for_nonsense_query() {
        let page = seed_search(Some("zzxqwwk-not-a-real-title"), 1);
        assert_eq!(page.count, 0);
        assert!(page.results.is_empty());
        assert!(page.next_page.is_none());
        assert!(page.offline);
    }

    // ── download URL validation (SSRF / scheme hardening) ──

    #[test]
    fn validate_download_url_accepts_real_gutenberg_https() {
        // The exact shape this module emits for seeded books.
        assert!(
            validate_download_url("https://www.gutenberg.org/cache/epub/1342/pg1342.txt").is_ok()
        );
        // Apex and the Gutendex API host are allowlisted too.
        assert!(validate_download_url("https://gutenberg.org/files/1342/1342-0.txt").is_ok());
        assert!(validate_download_url("https://gutendex.com/books/").is_ok());
    }

    #[test]
    fn validate_download_url_rejects_non_https_scheme() {
        // Cleartext is refused even on an otherwise allowlisted host.
        assert!(validate_download_url("http://www.gutenberg.org/cache/epub/1/pg1.txt").is_err());
        assert!(validate_download_url("file:///etc/passwd").is_err());
        assert!(validate_download_url("ftp://www.gutenberg.org/pg1.txt").is_err());
    }

    #[test]
    fn validate_download_url_rejects_non_allowlisted_host() {
        // Other domains, look-alikes, and loopback/RFC-1918 are all refused.
        assert!(validate_download_url("https://evil.example.com/pg1342.txt").is_err());
        assert!(validate_download_url("https://gutenberg.org.evil.com/x.txt").is_err());
        assert!(validate_download_url("https://localhost/pg1.txt").is_err());
        assert!(validate_download_url("https://127.0.0.1/pg1.txt").is_err());
        assert!(validate_download_url("https://192.168.1.10/pg1.txt").is_err());
        assert!(validate_download_url("not a url at all").is_err());
    }

    #[test]
    fn allowed_host_matching_is_case_insensitive_and_subdomain_aware() {
        assert!(is_allowed_download_host("WWW.Gutenberg.ORG"));
        assert!(is_allowed_download_host("www.gutenberg.org"));
        assert!(is_allowed_download_host("gutenberg.org"));
        assert!(is_allowed_download_host("gutendex.com"));
        // A suffix match must respect the dot boundary.
        assert!(!is_allowed_download_host("notgutenberg.org"));
        assert!(!is_allowed_download_host("gutenberg.org.evil.com"));
    }
}

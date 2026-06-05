//! Discover: search and import public-domain books.
//!
//! The catalogue is Project Gutenberg, reached through the Gutendex API. Per the
//! design brief the API/service brand name never appears in the UI — the reader
//! only ever sees "the public-domain library". This is **reader-initiated**
//! network egress: a search or a download happens only in response to a click,
//! never on a timer or in the background, and only *incoming* public-domain
//! text crosses the wire — no source text or reader data is ever sent out
//! (consistent with the local-first / copyright posture in CLAUDE.md).
//!
//! Imports funnel through `books::import_or_dedup`, the single owned import path,
//! so SHA dedup, source immutability, and the default plan all happen in exactly
//! one place — a downloaded book is indistinguishable from a file-picker import
//! once it lands.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::books::import_or_dedup;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::ImportOutcome;

const GUTENDEX_BASE: &str = "https://gutendex.com/books/";
const USER_AGENT: &str = concat!("Throughline/", env!("CARGO_PKG_VERSION"));

/// Upper bound on a single download's body. Public-domain plain-text/EPUB sources
/// are kilobytes-to-low-megabytes; this leaves a generous margin for the largest
/// collected works while refusing a hostile or runaway response that would
/// otherwise be buffered into memory unbounded. ~64 MiB.
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;

// ───────────────────────── Gutendex wire shapes ─────────────────────────
// Only the fields we use; everything else is ignored.

#[derive(Deserialize)]
struct GxPage {
    count: i64,
    next: Option<String>,
    #[serde(default)]
    results: Vec<GxBook>,
}

#[derive(Deserialize)]
struct GxBook {
    id: i64,
    title: String,
    #[serde(default)]
    authors: Vec<GxPerson>,
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    formats: HashMap<String, String>,
    #[serde(default)]
    download_count: i64,
}

#[derive(Deserialize)]
struct GxPerson {
    name: String,
}

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
    /// Live catalogue size for the "Search all {count}" line — displayed, never hardcoded.
    pub count: i64,
    /// 1-based page number to request for the next batch, or None at the end.
    pub next_page: Option<u32>,
    pub results: Vec<DiscoverBook>,
    /// True when these results came from the bundled offline seed (the live API
    /// was unreachable) rather than the full live catalogue. Lets the UI show a
    /// calm "offline catalogue" hint instead of pretending nothing changed.
    pub offline: bool,
}

/// Minimal reference the frontend round-trips back to import a chosen book.
#[derive(Deserialize)]
pub struct DiscoverImportRef {
    pub txt_url: Option<String>,
    pub epub_url: Option<String>,
}

// ───────────────────────── helpers ─────────────────────────

/// Reformat a Gutendex author ("Last, First, 1820-1910" / "Twain, Mark
/// (Samuel Langhorne Clemens)") into "First Last", dropping life dates and
/// parentheticals. Single-token names pass through unchanged.
fn humanize_author(raw: &str) -> String {
    let main = raw.split('(').next().unwrap_or(raw).trim();
    let parts: Vec<&str> = main.split(',').map(str::trim).collect();
    match parts.as_slice() {
        [last] => last.to_string(),
        [last, first, ..] if !first.is_empty() => format!("{first} {last}"),
        [last, ..] => last.to_string(),
        [] => String::new(),
    }
}

/// Pick the best importable URLs from a Gutendex formats map.
/// - txt: a `text/plain*` whose URL is not a `.zip` (zipped HTML masquerades as
///   `application/octet-stream` / ends in `.zip`); prefer the explicit
///   `charset=utf-8` variant since Gutenberg's legacy txt is often latin-1 and
///   our importer decodes strictly as UTF-8.
/// - epub: the exact `application/epub+zip`.
fn pick_formats(formats: &HashMap<String, String>) -> (Option<String>, Option<String>) {
    let mut txt_utf8: Option<String> = None;
    let mut txt_any: Option<String> = None;
    let mut epub: Option<String> = None;
    for (mime, url) in formats {
        if url.ends_with(".zip") {
            continue; // zipped HTML bundle, not a clean source
        }
        if mime.starts_with("text/plain") {
            if mime.to_ascii_lowercase().contains("utf-8") {
                txt_utf8.get_or_insert_with(|| url.clone());
            } else {
                txt_any.get_or_insert_with(|| url.clone());
            }
        } else if mime == "application/epub+zip" {
            epub.get_or_insert_with(|| url.clone());
        }
    }
    (txt_utf8.or(txt_any), epub)
}

fn map_book(b: GxBook) -> DiscoverBook {
    let (txt_url, epub_url) = pick_formats(&b.formats);
    let author = b
        .authors
        .iter()
        .map(|p| humanize_author(&p.name))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    DiscoverBook {
        id: b.id,
        title: b.title,
        author,
        language: b.languages.first().cloned().unwrap_or_default(),
        download_count: b.download_count,
        has_txt: txt_url.is_some(),
        has_epub: epub_url.is_some(),
        txt_url,
        epub_url,
    }
}

/// Extract the `page=N` query param from a Gutendex `next` URL.
fn parse_page_param(next: &str) -> Option<u32> {
    next.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix("page="))
        .and_then(|v| v.parse().ok())
}

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

// ───────────────────────── commands ─────────────────────────

/// Instant, network-free search over the bundled offline seed. The frontend
/// calls this FIRST to paint the popular list (or a query's seed matches) with
/// zero latency, then upgrades to the full live catalogue via
/// `cmd_discover_search` when/if the network answers — so opening Discover never
/// waits on the (down-prone) live API. Always `offline: true`.
#[tauri::command]
pub fn cmd_discover_seed(query: Option<String>, page: Option<u32>) -> DiscoverPage {
    seed_search(query.as_deref(), page.unwrap_or(1))
}

/// Search the public-domain library. Idle (empty query) returns the most
/// downloaded books first. `page` is 1-based; omit or pass 1 for the first batch.
///
/// Tries the live catalogue; if it is unreachable, falls back to the bundled
/// offline seed (flagged `offline: true`) so Discover keeps working during an
/// API outage instead of dead-ending. A *successful* empty result is NOT a
/// fallback trigger — only a transport/HTTP/parse failure is, so a genuine
/// "no live matches" never gets masked by unrelated seed books.
#[tauri::command]
pub async fn cmd_discover_search(
    query: Option<String>,
    page: Option<u32>,
    languages: Option<String>,
) -> Result<DiscoverPage, AppError> {
    match live_search(query.clone(), page, languages).await {
        Ok(page_data) => Ok(page_data),
        Err(e) => {
            eprintln!("[tl] discover: live search unavailable ({e}); serving offline seed");
            Ok(seed_search(query.as_deref(), page.unwrap_or(1)))
        }
    }
}

/// The live-catalogue path (Gutendex). Returns `Err` on any transport, HTTP, or
/// parse failure so `cmd_discover_search` can degrade to the offline seed.
async fn live_search(
    query: Option<String>,
    page: Option<u32>,
    languages: Option<String>,
) -> Result<DiscoverPage, AppError> {
    let lang = languages
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("en")
        .to_string();

    // Gutendex defaults to popularity order; be explicit. `mime_type=text/plain`
    // keeps the catalogue to importable titles (and makes `count` an honest
    // "importable books" figure for the Search-all line).
    let mut params: Vec<(&str, String)> = vec![
        ("languages", lang),
        ("mime_type", "text/plain".to_string()),
        ("sort", "popular".to_string()),
    ];
    if let Some(q) = query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(("search", q.to_string()));
    }
    if let Some(p) = page.filter(|&p| p > 1) {
        params.push(("page", p.to_string()));
    }

    // A healthy library answers in well under a second. The common failure mode
    // is the opposite extreme — the service hangs after the TLS handshake and
    // never sends a response — so cap the wait low: the sooner this errors, the
    // sooner the caller can fall back to the offline seed instead of leaving the
    // reader on a spinner.
    let client = http_client(8)?;
    let resp = client
        .get(GUTENDEX_BASE)
        .query(&params)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                AppError::io("the public-domain library isn't responding".to_string())
            } else {
                AppError::io(format!("library search failed: {e}"))
            }
        })?;
    if !resp.status().is_success() {
        return Err(AppError::io(format!(
            "library search returned {}",
            resp.status()
        )));
    }
    let data: GxPage = resp
        .json()
        .await
        .map_err(|e| AppError::io(format!("could not read library response: {e}")))?;

    let next_page = data.next.as_deref().and_then(parse_page_param);
    let results = data.results.into_iter().map(map_book).collect();
    Ok(DiscoverPage {
        count: data.count,
        next_page,
        results,
        offline: false,
    })
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
                eprintln!("[tl] gutendex import via .{ext} failed: {e}");
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
// Pure mapping/format-selection logic, exercised against captured Gutendex
// shapes. No network: the live API is never touched in the test suite.

#[cfg(test)]
mod tests {
    use super::*;

    fn fmts(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn humanize_author_reformats_last_first() {
        assert_eq!(
            humanize_author("Shakespeare, William"),
            "William Shakespeare"
        );
        assert_eq!(
            humanize_author("Twain, Mark (Samuel Langhorne Clemens)"),
            "Mark Twain"
        );
        // Life dates are dropped.
        assert_eq!(
            humanize_author("Dickens, Charles, 1812-1870"),
            "Charles Dickens"
        );
        // Single-token / organisation names pass through.
        assert_eq!(humanize_author("Anonymous"), "Anonymous");
        assert_eq!(humanize_author("Various"), "Various");
    }

    #[test]
    fn pick_formats_prefers_utf8_text_and_skips_zip() {
        let f = fmts(&[
            ("text/plain; charset=us-ascii", "https://x/1.txt"),
            ("text/plain; charset=utf-8", "https://x/1-0.txt"),
            ("application/epub+zip", "https://x/1.epub"),
            ("text/html", "https://x/1.html"),
            ("application/octet-stream", "https://x/1-h.zip"),
        ]);
        let (txt, epub) = pick_formats(&f);
        assert_eq!(txt.as_deref(), Some("https://x/1-0.txt"));
        assert_eq!(epub.as_deref(), Some("https://x/1.epub"));
    }

    #[test]
    fn pick_formats_falls_back_to_non_utf8_text() {
        let f = fmts(&[("text/plain; charset=iso-8859-1", "https://x/legacy.txt")]);
        let (txt, epub) = pick_formats(&f);
        assert_eq!(txt.as_deref(), Some("https://x/legacy.txt"));
        assert!(epub.is_none());
    }

    #[test]
    fn pick_formats_skips_zipped_plaintext() {
        // A text/plain entry that is actually a .zip must not be chosen.
        let f = fmts(&[("text/plain; charset=utf-8", "https://x/1.txt.zip")]);
        let (txt, _epub) = pick_formats(&f);
        assert!(txt.is_none());
    }

    #[test]
    fn map_book_builds_dto() {
        let b = GxBook {
            id: 1342,
            title: "Pride and Prejudice".to_string(),
            authors: vec![GxPerson {
                name: "Austen, Jane".to_string(),
            }],
            languages: vec!["en".to_string()],
            formats: fmts(&[
                ("text/plain; charset=utf-8", "https://x/1342-0.txt"),
                ("application/epub+zip", "https://x/1342.epub"),
            ]),
            download_count: 99000,
        };
        let dto = map_book(b);
        assert_eq!(dto.id, 1342);
        assert_eq!(dto.author, "Jane Austen");
        assert_eq!(dto.language, "en");
        assert!(dto.has_txt && dto.has_epub);
        assert_eq!(dto.txt_url.as_deref(), Some("https://x/1342-0.txt"));
    }

    #[test]
    fn parse_page_param_reads_next_url() {
        let next = "https://gutendex.com/books/?languages=en&mime_type=text%2Fplain&page=3";
        assert_eq!(parse_page_param(next), Some(3));
        assert_eq!(
            parse_page_param("https://gutendex.com/books/?languages=en"),
            None
        );
    }

    #[test]
    fn deserializes_a_gutendex_page() {
        let json = r#"{
            "count": 78613,
            "next": "https://gutendex.com/books/?page=2",
            "previous": null,
            "results": [
                {
                    "id": 1342,
                    "title": "Pride and Prejudice",
                    "authors": [{"name": "Austen, Jane", "birth_year": 1775, "death_year": 1817}],
                    "languages": ["en"],
                    "download_count": 99000,
                    "media_type": "Text",
                    "formats": {
                        "text/plain; charset=utf-8": "https://x/1342-0.txt",
                        "application/epub+zip": "https://x/1342.epub"
                    }
                }
            ]
        }"#;
        let page: GxPage = serde_json::from_str(json).expect("parse");
        assert_eq!(page.count, 78613);
        assert_eq!(parse_page_param(page.next.as_deref().unwrap()), Some(2));
        assert_eq!(page.results.len(), 1);
        let dto = map_book(page.results.into_iter().next().unwrap());
        assert_eq!(dto.title, "Pride and Prejudice");
        assert_eq!(dto.author, "Jane Austen");
    }

    // ── offline seed (bundled catalogue + fallback) ──

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

#!/usr/bin/env node
// Build the FULL Discover catalogue: the entire public-domain library of
// readable books, bundled into the app so search is INSTANT, OFFLINE, and never
// depends on a live search API. This replaces the live-search dependency
// (gutendex.com, a single point of failure) for the search path; the small
// `discover_seed.json` stays as the editorial "shelves" on the idle screen.
//
// Like the seed builder this is a BUILD-TIME / maintainer tool — it is NOT run
// at app runtime. It reads only Project Gutenberg's own sanctioned feeds (the
// catalog CSV is explicitly offered "as input to a database … instead of
// crawling"):
//   1. Top-1000 page  → a popularity signal for ranking (30-day downloads)
//   2. pg_catalog.csv.gz → authoritative id / title / author / language
// It keeps every `Type=Text` book (all languages), and writes a compact
// tab-separated file `id\ttitle\tauthor\tlang\tpop` (one row per book), sorted
// most-popular-first. The Rust side derives the gutenberg.org download URLs
// from `id` at load time, exactly as it already does for the seed.
//
// Usage:  node scripts/build-discover-catalogue.mjs
// Needs network to www.gutenberg.org (its file servers stay up even when the
// search API is down). Re-run each release to refresh; commit the output.

import { gunzipSync } from "node:zlib";
import { writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TOP_URL = "https://www.gutenberg.org/browse/scores/top1000.php";
const CSV_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src-tauri/resources/discover_catalogue.tsv");

const UA = "Throughline-catalogue-builder/1.0 (one-shot maintainer tool; reads published feeds only)";

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchGzip(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
}

// Parse the "Top 1000 EBooks last 30 days" section into ordered [{id, count}].
function parseTop(html) {
  const start = html.indexOf('id="books-last30"');
  if (start < 0) throw new Error('could not find the "books-last30" section');
  const next = html.indexOf("<h2", start + 1);
  const section = html.slice(start, next < 0 ? undefined : next);
  const out = [];
  const re = /<a href="\/ebooks\/(\d+)">[\s\S]*?\((\d+)\)<\/a>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    out.push({ id: Number(m[1]), count: Number(m[2]) });
  }
  return out;
}

// Minimal RFC-4180 CSV parser: quoted fields with embedded commas/newlines/"".
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // ignore; newline handled by \n
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// "Surname, Given, 1775-1817" (possibly "; "-joined co-authors) -> "Given Surname".
function humanizeAuthors(raw) {
  if (!raw) return "";
  return raw
    .split(";")
    .map((one) => {
      const main = one.split("(")[0].trim();
      const parts = main.split(",").map((s) => s.trim());
      if (parts.length === 1) return parts[0];
      const [last, given] = parts;
      return given ? `${given} ${last}` : last;
    })
    .filter(Boolean)
    .join(", ");
}

// Collapse all whitespace (incl. tabs/newlines) so a field is TSV-safe and clean.
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

async function main() {
  console.error(`[catalogue] fetching popularity ranking: ${TOP_URL}`);
  const top = parseTop(await fetchText(TOP_URL));
  const pop = new Map(top.map(({ id, count }) => [id, count]));
  console.error(`[catalogue] parsed ${top.length} ranked ebooks (last 30 days)`);

  console.error(`[catalogue] fetching catalog: ${CSV_URL}`);
  const rows = parseCsv(await fetchGzip(CSV_URL));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const cId = col("Text#"), cType = col("Type"), cTitle = col("Title"),
        cLang = col("Language"), cAuthors = col("Authors");
  if ([cId, cType, cTitle, cLang, cAuthors].some((i) => i < 0)) {
    throw new Error(`unexpected catalog header: ${header.join(",")}`);
  }
  console.error(`[catalogue] catalog rows: ${rows.length - 1}`);

  const books = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= cAuthors) continue;
    if (r[cType] !== "Text") continue; // readable books only (drop Sound/Dataset/…)
    const id = Number(r[cId]);
    if (!Number.isInteger(id) || id <= 0) continue;
    const title = clean(r[cTitle]);
    if (!title) continue;
    // First language tag only ("en", "fr", …); some rows carry "en; fr".
    const lang = clean(r[cLang]).split(/[;,]/)[0].trim() || "en";
    books.push({
      id,
      title,
      author: clean(humanizeAuthors(r[cAuthors])),
      lang,
      pop: pop.get(id) || 0,
    });
  }

  // Most-popular-first so the bundled file's head is the browse order, and ties
  // by id (stable, oldest-first).
  books.sort((a, b) => b.pop - a.pop || a.id - b.id);

  const out = books
    .map((b) => `${b.id}\t${b.title}\t${b.author}\t${b.lang}\t${b.pop}`)
    .join("\n") + "\n";
  writeFileSync(OUT, out, "utf8");

  const mb = (statSync(OUT).size / 1_048_576).toFixed(1);
  const langs = new Set(books.map((b) => b.lang));
  console.error(
    `[catalogue] wrote ${books.length} books (${langs.size} languages, ` +
    `${books.filter((b) => b.pop > 0).length} with a popularity signal) -> ${OUT} (${mb} MB)`,
  );
}

main().catch((e) => {
  console.error(`[catalogue] FAILED: ${e.message}`);
  process.exit(1);
});

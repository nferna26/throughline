#!/usr/bin/env node
// Build the Discover offline seed: a small, bundled catalogue of the top-N most
// downloaded public-domain books, so Discover keeps working (browse + search of
// popular titles) when the live search API is unreachable.
//
// This is a BUILD-TIME / maintainer tool — it is NOT shipped in the app and runs
// no network at runtime. It reads only Project Gutenberg's own sanctioned feeds
// (the catalog CSV is explicitly offered "as input to a database … instead of
// crawling"), never the down search API:
//   1. Top-1000 page  → popularity ranking + ids + 30-day download counts
//   2. pg_catalog.csv.gz → authoritative title / author / language, Type filter
// then joins, filters to English Text, takes the top N, and writes a compact
// JSON array of { id, title, author, language, download_count }. The Rust side
// derives the gutenberg.org download URLs from `id` at load time.
//
// Usage:  node scripts/build-discover-seed.mjs [N]   (default N = 200)
// Needs network to www.gutenberg.org (the file servers, which stay up even when
// the search API is down). Re-run weekly/monthly to refresh; commit the output.

import { gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const N = Number(process.argv[2] || 200);
const TOP_URL = "https://www.gutenberg.org/browse/scores/top1000.php";
const CSV_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src-tauri/resources/discover_seed.json");

const UA = "Throughline-seed-builder/1.0 (one-shot maintainer tool; reads published feeds only)";

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
// 30-day is the most stable ranking. Each entry is:
//   <li><a href="/ebooks/{id}">Title by Author (COUNT)</a></li>
// We take only the id (from the href) and the trailing (COUNT); title/author
// come from the authoritative CSV to avoid the "title contains ' by '" ambiguity.
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

// Minimal RFC-4180 CSV parser: handles quoted fields with embedded commas,
// newlines, and "" escapes. Returns an array of string-arrays (rows).
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

// "Surname, Given, 1775-1817" (possibly "; "-joined for co-authors) -> "Given Surname".
// Drops life dates and parentheticals; joins multiple authors with ", ".
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

const collapseWs = (s) => s.replace(/\s+/g, " ").trim();

async function main() {
  console.error(`[seed] fetching popularity ranking: ${TOP_URL}`);
  const top = parseTop(await fetchText(TOP_URL));
  console.error(`[seed] parsed ${top.length} ranked ebooks (last 30 days)`);

  console.error(`[seed] fetching catalog: ${CSV_URL}`);
  const rows = parseCsv(await fetchGzip(CSV_URL));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const cId = col("Text#"), cType = col("Type"), cTitle = col("Title"),
        cLang = col("Language"), cAuthors = col("Authors");

  const meta = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= cAuthors) continue;
    meta.set(Number(r[cId]), {
      type: r[cType],
      title: collapseWs(r[cTitle]),
      language: r[cLang],
      author: humanizeAuthors(r[cAuthors]),
    });
  }
  console.error(`[seed] catalog rows: ${meta.size}`);

  // Join in popularity order, keep English Text titles, take the top N.
  const seed = [];
  const seen = new Set();
  for (const { id, count } of top) {
    if (seen.has(id)) continue;
    const m = meta.get(id);
    if (!m) continue;
    if (m.type !== "Text") continue;
    // Language is usually a single code; accept rows whose language set includes en.
    const langs = m.language.split(";").map((s) => s.trim());
    if (!langs.includes("en")) continue;
    if (!m.title) continue;
    seen.add(id);
    seed.push({
      id,
      title: m.title,
      author: m.author,
      language: "en",
      download_count: count,
    });
    if (seed.length >= N) break;
  }

  if (seed.length < N) {
    console.error(`[seed] WARNING: only ${seed.length} of ${N} after filtering`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(seed, null, 0) + "\n");
  const bytes = Buffer.byteLength(JSON.stringify(seed));
  console.error(`[seed] wrote ${seed.length} books -> ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);
  console.error(`[seed] top 5:`);
  for (const b of seed.slice(0, 5)) console.error(`   ${b.id}  ${b.title} — ${b.author} (${b.download_count})`);
}

main().catch((e) => { console.error("[seed] FAILED:", e.message); process.exit(1); });

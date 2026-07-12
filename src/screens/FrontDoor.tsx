import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import Cover, { decollideCovers } from "../components/Cover";
import { STARTERS, resolveStarters } from "../discoverShelves";

// The three starter covers are shown together, so de-collide their cloth up front
// (deterministic, since STARTERS is fixed) — Meditations / Walden / Pride &
// Prejudice render as three clearly distinct colours, never two near-purples.
const TRIO_CLOTH = decollideCovers(STARTERS.map((s) => ({ title: s.title, author: s.author })));
import { errorMessage, type DiscoverBook, type ImportOutcome } from "../types";
import "./FrontDoor.css";

interface Props {
  /** Open the library (the primary "find a book" path). */
  onDiscover: () => void;
  /** Import a local .txt/.epub via the file picker (the secondary path). */
  onImport: () => void;
  /** A starter cover finished downloading + importing — route forward exactly
   *  like a Discover pick (new book → the chosen + pace step; dedup → Today). */
  onPicked: (outcome: ImportOutcome) => void;
}

/* Small inline glyph helper so the front door carries the handoff's exact icons
   without a new dependency (mirrors Settings.tsx's inline-SVG approach). */
function Glyph({
  children,
  width = 1.7,
  size = 16,
}: {
  children: ReactNode;
  width?: number;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type ActState = "resting" | "entering" | "success";
type ActError = { text: string; recovery: boolean } | null;
const SUPPORT_EMAIL = "hello@readthroughline.com";

/**
 * The first-run screen — the front door. Replaces the old "Welcome to
 * Throughline" empty state. The three cloth covers are the primary invitation
 * (click one to start reading at once); Browse + Import sit beside them; the
 * activation code is a quiet whisper at the bottom, never a gate (reading is
 * always free). The same Cover object begins the continuity thread that runs
 * through browse → chosen → Today.
 */
export default function FrontDoor({ onDiscover, onImport, onPicked }: Props) {
  // The three starter covers, resolved against the catalogue for their import
  // URLs. Until they load we still render placeholder covers from the authored
  // titles so the shelf never pops in empty.
  const [starters, setStarters] = useState<
    Array<{ book: DiscoverBook; title: string; author: string }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    invoke<DiscoverBook[]>("cmd_discover_books_by_ids", { ids: STARTERS.map((s) => s.id) })
      .then((rows) => {
        if (!cancelled) setStarters(resolveStarters(new Map(rows.map((b) => [b.id, b]))));
      })
      .catch(() => {
        /* leave the placeholder trio; the covers are still inviting, just inert */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Importing a starter cover (one at a time). A calm line carries any failure.
  const [importingId, setImportingId] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  function startBook(item: { book: DiscoverBook; title: string }) {
    if (importingId != null) return;
    setStartError(null);
    setImportingId(item.book.id);
    invoke<ImportOutcome>("cmd_import_from_gutendex", {
      book: { txt_url: item.book.txt_url, epub_url: item.book.epub_url },
    })
      .then((outcome) => {
        setImportingId(null);
        onPicked(outcome);
      })
      .catch((e) => {
        setImportingId(null);
        const why = errorMessage(e);
        setStartError(
          why && why !== "(no error)"
            ? `Couldn't open “${item.title}” — ${why} Check your connection, then try again.`
            : `Couldn't open “${item.title}” — check your connection, then try again.`,
        );
      });
  }

  // ── Activation (calm, never a gate) ──────────────────────────────────────
  const [actState, setActState] = useState<ActState>("resting");
  const [code, setCode] = useState("");
  const [activating, setActivating] = useState(false);
  const [actError, setActError] = useState<ActError>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  function openActivation() {
    setActState("entering");
    setActError(null);
    // Focus the field once it mounts.
    requestAnimationFrame(() => codeRef.current?.focus());
  }
  function cancelActivation() {
    setActState("resting");
    setCode("");
    setActError(null);
  }

  async function activate() {
    const token = code.trim();
    if (!token || activating) return;
    setActivating(true);
    setActError(null);
    try {
      await invoke("cmd_activate_company", { activationToken: token });
      setActState("success");
      setCode("");
      // The same event the deep link fires — keeps an open Settings in sync.
      window.dispatchEvent(new Event("tl-company-activated"));
    } catch (e) {
      // The backend returns ONE message for a code that's mistyped, expired, or
      // already used (it cannot tell them apart), so the front door stays honest:
      // a warm clay line (never red) that offers the recovery path. A reachability
      // error (kind "Ai") shows its own message instead of a code-recovery line.
      const kind = (e as { kind?: string })?.kind;
      if (kind === "Validation") {
        setActError({
          text: "That code didn't activate. Check for a typo and try again.",
          recovery: true,
        });
      } else {
        setActError({ text: errorMessage(e), recovery: false });
      }
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="tl-fd-scroll">
      <div className="tl-fd">
        <p className="tl-fd-eyebrow">A quiet place to read</p>
        <h1 className="tl-fd-hero">Begin with a book you mean to finish.</h1>
        <p className="tl-fd-lede">
          Read it a few pages a day, with a tutor in the margin for the passages that lose you.
        </p>

        {/* The three cloth covers — the primary invitation. Click a cover to start
            reading at once. Real buttons, named by title + author. Always iterate
            the authored STARTERS (stable keys, no remount flash); each cover is
            inert until its catalogue row resolves to give it import URLs. */}
        <div className="tl-fd-shelf">
          {STARTERS.map((s, i) => {
            const resolved = starters.find((r) => r.book.id === s.id) ?? null;
            const loading = resolved != null && importingId === resolved.book.id;
            const disabled = resolved == null || importingId != null;
            return (
              <button
                key={s.id}
                type="button"
                className={"tl-book tl-fd-book" + (loading ? " is-loading" : "")}
                onClick={() => resolved && startBook({ book: resolved.book, title: s.title })}
                disabled={disabled}
                aria-label={`Start reading ${s.title} by ${s.author}`}
                aria-busy={loading}
              >
                <Cover title={s.title} author={s.author} size="trio" cloth={TRIO_CLOTH[i]} />
                {loading && <span className="tl-fd-book-loading">Opening…</span>}
              </button>
            );
          })}
        </div>

        {startError && (
          <p className="tl-fd-starterror" role="alert">
            {startError}
          </p>
        )}

        <div className="tl-fd-actions">
          <button type="button" className="tl-btn tl-btn-primary" onClick={onDiscover}>
            <Glyph>
              <circle cx="9" cy="9" r="5.5" />
              <path d="M13.5 13.5L17 17" />
            </Glyph>
            Browse the library
          </button>
          <button type="button" className="tl-btn-quiet tl-fd-import" onClick={onImport}>
            <Glyph>
              <path d="M10 13V4M6.5 7.5L10 4l3.5 3.5" />
              <path d="M4 16h12" />
            </Glyph>
            Import a .txt or .epub
          </button>
        </div>

        <p className="tl-fd-trust">
          Thousands of free public-domain books. Your books and notes stay on this Mac — no
          account, nothing tracked. The tutor sends only what you choose — a selected passage,
          or the section you're starting in Deep Study, along with the book's title, author,
          and chapter name for context — and only after you confirm it.
        </p>

        {/* ── Activation: a whisper, never a gate. ── */}
        <div className="tl-fd-actbar">
          {actState === "resting" && (
            <button type="button" className="tl-fd-actrest" onClick={openActivation}>
              <Glyph width={1.6} size={15}>
                <circle cx="7" cy="10" r="3" />
                <path d="M10 10h7M14.5 10v3M17 10v2.5" />
              </Glyph>
              Bought Throughline? <u>Enter your code</u>
            </button>
          )}

          {actState === "entering" && (
            <div className="tl-fd-actexpand">
              <p className="tl-fd-acth">Enter your activation code</p>
              <p className="tl-fd-actsub">Reading is free. Your code lights up the tutor in the margin.</p>
              <div className="tl-fd-codefield">
                <input
                  ref={codeRef}
                  className={"tl-fd-code" + (actError ? " err" : "")}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void activate();
                  }}
                  placeholder="56HA-N460-C47S"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Activation code"
                  aria-invalid={actError != null}
                  aria-describedby={actError ? "tl-fd-actmsg" : undefined}
                />
                <button
                  type="button"
                  className="tl-fd-go"
                  onClick={() => void activate()}
                  disabled={activating || !code.trim()}
                >
                  {activating ? "Activating…" : "Activate"}
                </button>
              </div>
              {actError && (
                <p className="tl-fd-actmsg" id="tl-fd-actmsg" role="alert">
                  <Glyph size={14}>
                    <circle cx="10" cy="10" r="7.5" />
                    <path d="M10 6.5v4M10 13.5h.01" />
                  </Glyph>
                  <span>
                    {actError.text}
                    {actError.recovery && (
                      <>
                        {" "}
                        Or email{" "}
                        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and I'll make it
                        right.
                      </>
                    )}
                  </span>
                </p>
              )}
              <button type="button" className="tl-fd-actcancel" onClick={cancelActivation}>
                Not now
              </button>
            </div>
          )}

          {actState === "success" && (
            <div className="tl-fd-actbanner" role="status">
              <span className="bi">
                <Glyph>
                  <path d="M16.5 6.5L8.5 14.5 4 10" />
                </Glyph>
              </span>
              <div>
                <h4>You're activated. Welcome in.</h4>
                <p>The tutor is ready in the margin, whenever a passage gives you pause.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

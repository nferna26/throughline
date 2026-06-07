import TLIcon from "./TLIcon";
import type { TodayTeaser as Teaser } from "../types";

interface Props {
  /** The prepared teaser from the backend, or null when the section text can't
   *  be read (the calm "unavailable" fallback is shown then). */
  teaser: Teaser | null;
  /** True once the reader has finished today's assigned section. */
  completed: boolean;
}

// Inline styles, not new stylesheet rules: this unit owns only its component,
// so it composes the existing --tl- tokens directly. Visual intent matches the
// app's quiet pull-quote idiom (serif body-title type, a muted uppercase kicker,
// a soft left rule) used by .tl-lasttime / .tl-section-label.
const wrapStyle: React.CSSProperties = {
  marginTop: "var(--tl-5)",
  paddingLeft: "var(--tl-4)",
  borderLeft: "2px solid var(--tl-line)",
};
const kickerStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontFamily: "var(--tl-sans)",
  fontSize: "10.5px",
  fontWeight: 650,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--tl-muted)",
};
const excerptStyle: React.CSSProperties = {
  margin: "var(--tl-2) 0 0",
  fontFamily: "var(--tl-serif)",
  fontSize: "19px",
  lineHeight: 1.45,
  fontStyle: "italic",
  color: "var(--tl-ink)",
};
const promptStyle: React.CSSProperties = {
  margin: "var(--tl-3) 0 0",
  fontFamily: "var(--tl-sans)",
  fontSize: "13.5px",
  lineHeight: 1.5,
  color: "var(--tl-muted)",
};
const fallbackStyle: React.CSSProperties = {
  margin: "var(--tl-2) 0 0",
  fontFamily: "var(--tl-serif)",
  fontSize: "16px",
  lineHeight: 1.45,
  color: "var(--tl-muted)",
};

/**
 * "Before you read" — a prepared reading encounter on Today. Shows the book's
 * OWN first (or, when resuming mid-section, resume-adjacent) sentence(s) as a
 * quiet pull-quote, with one hand-written reading prompt beneath it. Pace and
 * progress stay on Today but become supporting; this block is the invitation in.
 *
 * It carries no AI and no gamification: the excerpt is the local source text and
 * the prompt is a fixed, hand-written lens chosen on the backend. States:
 *   completed   → the reader finished; let the note be enough.
 *   resume      → the thread the paragraph is carrying forward.
 *   new         → the section's opening, read for one of the prompts.
 *   unavailable → no readable text yet; a calm "section is ready" line.
 */
export default function TodayTeaser({ teaser, completed }: Props) {
  if (completed) {
    return (
      <div style={wrapStyle} role="note" aria-label="Before you read">
        <span style={kickerStyle}>
          <TLIcon name="check" size={13} /> Before you read
        </span>
        <p style={fallbackStyle}>
          You've finished today's section. Let the note be enough.
        </p>
      </div>
    );
  }

  if (!teaser) {
    return (
      <div style={wrapStyle} role="note" aria-label="Before you read">
        <span style={kickerStyle}>
          <TLIcon name="book" size={13} /> Before you read
        </span>
        <p style={fallbackStyle}>
          Today's section is ready. Read for one sentence worth keeping.
        </p>
      </div>
    );
  }

  return (
    <div style={wrapStyle} role="note" aria-label="Before you read">
      <span style={kickerStyle}>
        <TLIcon name="book" size={13} />{" "}
        {teaser.is_resume_excerpt ? "Where you left off" : "Before you read"}
      </span>
      <p style={excerptStyle}>{teaser.excerpt}</p>
      <p style={promptStyle}>{teaser.prompt}</p>
    </div>
  );
}

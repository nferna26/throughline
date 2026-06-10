import TLIcon from "./TLIcon";
import type { TodayTeaser as Teaser } from "../types";

interface Props {
  /** The resume teaser from the backend (the reader stopped mid-section). The
   *  caller renders this ONLY for a resume excerpt — a fresh section's opening is
   *  never pre-printed, since the reader meets it the instant they tap Start. */
  teaser: Teaser;
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

/**
 * "Where you left off" — the resume thread on Today. When the reader stopped
 * mid-section, this shows the book's OWN resume-adjacent sentence(s) as a quiet
 * pull-quote, with one hand-written prompt beneath, so re-entry feels like
 * picking a thought back up rather than restarting.
 *
 * It is deliberately resume-only (CORE-1049): a fresh section's opening earns
 * nothing pre-printed — it's the very text the reader meets on tapping Start.
 * It carries no AI and no gamification: the excerpt is the local source text and
 * the prompt is a fixed, hand-written lens chosen on the backend.
 */
export default function TodayTeaser({ teaser }: Props) {
  return (
    <div style={wrapStyle} role="note" aria-label="Where you left off">
      <span style={kickerStyle}>
        <TLIcon name="book" size={13} /> Where you left off
      </span>
      <p style={excerptStyle}>{teaser.excerpt}</p>
      <p style={promptStyle}>{teaser.prompt}</p>
    </div>
  );
}

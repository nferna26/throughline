// Lucide-style line icons, 20-grid, 1.6 stroke, currentColor.
// Ported verbatim from the Claude Design handoff (lib/tl-icons.jsx) so the
// overhaul carries no icon dependency. Replaces the old emoji glyphs.

const PATHS: Record<string, string> = {
  book: "M4 4.5A1.5 1.5 0 0 1 5.5 3H16v14H5.5A1.5 1.5 0 0 0 4 18.5zM16 17v0M4 18.5A1.5 1.5 0 0 0 5.5 20H16",
  settings: "M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z M16.2 12.2a1.3 1.3 0 0 0 .26 1.43l.05.05a1.55 1.55 0 1 1-2.2 2.2l-.05-.05a1.3 1.3 0 0 0-2.2.92v.13a1.55 1.55 0 1 1-3.1 0v-.07a1.3 1.3 0 0 0-2.24-.9l-.05.05a1.55 1.55 0 1 1-2.2-2.2l.05-.05a1.3 1.3 0 0 0-.92-2.2H3.7a1.55 1.55 0 1 1 0-3.1h.07a1.3 1.3 0 0 0 .9-2.24l-.05-.05a1.55 1.55 0 1 1 2.2-2.2l.05.05a1.3 1.3 0 0 0 1.43.26h.06a1.3 1.3 0 0 0 .79-1.19V3.7a1.55 1.55 0 1 1 3.1 0v.07a1.3 1.3 0 0 0 2.24.9l.05-.05a1.55 1.55 0 1 1 2.2 2.2l-.05.05a1.3 1.3 0 0 0-.26 1.43v.06a1.3 1.3 0 0 0 1.19.79h.13a1.55 1.55 0 1 1 0 3.1h-.07a1.3 1.3 0 0 0-1.19.79z",
  moon: "M16.5 11.2A6 6 0 0 1 8.8 3.5a6 6 0 1 0 7.7 7.7z",
  sun: "M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 1.8v1.6M10 16.6v1.6M3.6 3.6l1.1 1.1M15.3 15.3l1.1 1.1M1.8 10h1.6M16.6 10h1.6M3.6 16.4l1.1-1.1M15.3 4.7l1.1-1.1",
  chevronDown: "M5.5 8l4.5 4.5L14.5 8",
  chevronLeft: "M12 5l-5 5 5 5",
  chevronRight: "M8 5l5 5-5 5",
  arrowRight: "M4 10h12M11 5l5 5-5 5",
  plus: "M10 4.5v11M4.5 10h11",
  minus: "M4.5 10h11",
  check: "M4 10.5l4 4 8-9",
  x: "M5 5l10 10M15 5L5 15",
  type: "M5 6V4.8h10V6M10 4.8V16M7.5 16h5",
  columns: "M3.5 4.5h13v11h-13zM10 4.5v11",
  note: "M5 3.2h7l4 4v9.6H5zM12 3.2V7h4",
  quote: "M7.5 6.2C5.8 6.8 4.8 8.2 4.8 10v3.8h4V10H6.6c0-1.2.5-2 1.6-2.4zM14.5 6.2c-1.7.6-2.7 2-2.7 3.8v3.8h4V10h-2.2c0-1.2.5-2 1.6-2.4z",
  help: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8.1 7.8a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.9-1.9 1.9M10 14.2v0",
  folder: "M3.5 5.5A1.5 1.5 0 0 1 5 4h3l1.5 1.8H15a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 15 16H5a1.5 1.5 0 0 1-1.5-1.5z",
  shield: "M10 2.8 4.5 5v4.2c0 3.4 2.3 5.9 5.5 7 3.2-1.1 5.5-3.6 5.5-7V5z M7.8 10l1.6 1.6 3-3.4",
  clock: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6v4l2.6 1.6",
  pace: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 10l3-2.2M10 10v0",
  upload: "M10 13V3.5M6.2 7.3 10 3.5l3.8 3.8M4.5 13.5v1.5A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5",
  sparkle: "M10 3.5l1.6 4.2L16 9.3l-4.4 1.6L10 15l-1.6-4.1L4 9.3l4.4-1.6zM15.5 13.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5L13.4 15l1.5-.6z",
  behind: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5v4M10 13.2v0",
  pencil: "M13.5 4.2 15.8 6.5 7 15.3l-3 0.8 0.8-3zM12 5.7l2.3 2.3",
  flag: "M5 16V3.5M5 4.2h8.5L11.7 7l1.8 2.8H5",
  refresh: "M15.5 6.5A6 6 0 1 0 16 10M15.5 3.5v3h-3",
  // Added for Discover (the handoff's discover.jsx references these but its icon
  // set omits them); authored here in the same 20-grid / 1.6-stroke style.
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM16.5 16.5 12.7 12.7",
  globe: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM3 10h14M10 3c2.2 2.1 2.2 11.9 0 14M10 3c-2.2 2.1-2.2 11.9 0 14",
  download: "M10 3.5v8M6.7 8.2 10 11.5l3.3-3.3M4.5 13.5v1.5A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5",
  arrowDown: "M10 4.5v10M6.2 10.8 10 14.5l3.8-3.7",
  // Plans view (frontispiece + back-matter) — pause/resume/archive/replace/undo.
  pause: "M7.5 4.8v10.4M12.5 4.8v10.4",
  play: "M6.5 4.8l9 5.2-9 5.2z",
  archive: "M3.8 4.5h12.4v3.2H3.8zM5 7.7v7.8h10V7.7M8 11h4",
  swap: "M5 7.5h10l-3-3M15 12.5H5l3 3",
  undo: "M7.5 8.5H13a3.5 3.5 0 0 1 0 7H8.5M7.5 8.5l3-3M7.5 8.5l3 3",
};

import type { CSSProperties } from "react";

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

export default function TLIcon({ name, size = 20, strokeWidth = 1.6, className, style }: Props) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      <path d={d} />
    </svg>
  );
}

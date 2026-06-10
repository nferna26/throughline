// The Throughline "T" — the brand's monochrome in-app mark.
// Two rounded rects (crossbar + elongated stem) on the 1024 art grid from the
// design handoff (throughline-mark-mono.svg). Single `currentColor` shape, no
// ground/badge/container: it inherits text color so it reads forest-green
// (#2f4e3a) on light UI and sage (#a7c5b1) on dark, matching --tl-ink.

import type { CSSProperties } from "react";

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Decorative by default — the mark sits beside the "Throughline" wordmark, so
   * it's hidden from assistive tech to avoid announcing the name twice. Set to
   * false (and the consumer should not supply its own label) only when the mark
   * stands alone and needs to carry the brand name itself.
   */
  "aria-hidden"?: boolean;
}

export default function ThroughlineMark({
  size = 20,
  className,
  style,
  "aria-hidden": ariaHidden = true,
}: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="currentColor"
      className={className}
      style={{ flexShrink: 0, ...style }}
      {...(ariaHidden ? { "aria-hidden": true } : { role: "img", "aria-label": "Throughline" })}
    >
      <rect x="322" y="240" width="380" height="82" rx="41" />
      <rect x="472" y="240" width="80" height="556" rx="40" />
    </svg>
  );
}

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanyCredits } from "../types";

/**
 * Company-mode "low allowance" strip for the margin tutor card footer. Quiet by
 * design: it is ABSENT entirely until the included AI runs low, then it shows the
 * card's one legitimate warning — a thin --warn track + "Running low — about N
 * left", sitting just above the privacy microline. The actual switch happens at
 * the cap (the three-door screen); this only informs, never blocks.
 */
export type FuelTone = "quiet" | "nudge" | "low";

/** Thresholds are on the USED fraction: quiet < 75%, nudge ≥ 75%, low ≥ 90%. */
export function fuelTone(usedFraction: number): FuelTone {
  if (usedFraction >= 0.9) return "low";
  if (usedFraction >= 0.75) return "nudge";
  return "quiet";
}

export default function TutorFuel({ provider }: { provider: string | null }) {
  const [credits, setCredits] = useState<CompanyCredits | null>(null);

  useEffect(() => {
    if (provider !== "company") return;
    invoke<CompanyCredits>("cmd_company_credits")
      .then(setCredits)
      .catch(() => {}); // gauge is best-effort; the server stays authoritative
  }, [provider]);

  if (provider !== "company" || !credits || credits.status !== "active") return null;

  const remaining = Math.max(0, Math.min(1, credits.remaining_fraction));
  const tone = fuelTone(1 - remaining);
  // Only-when-low: nothing renders until the allowance is actually running low.
  if (tone === "quiet") return null;

  const pct = Math.round(remaining * 100);
  const left = Math.max(0, Math.round(credits.approx_questions_left));

  return (
    <div className="tl-tutorfuel" role="status" aria-label={`Throughline AI running low — about ${left} left`}>
      <span className="tl-fuel-bar" aria-hidden="true">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="tl-fuel-label">Running low — about {left} left</span>
    </div>
  );
}

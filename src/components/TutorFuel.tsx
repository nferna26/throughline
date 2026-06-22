import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanyCredits } from "../types";

/**
 * Company-mode "low allowance" strip for the margin tutor card footer. Quiet by
 * design: it is ABSENT entirely until the included AI runs low, then it shows ONE
 * calm note pointing to the free fallback (own key or a local model). No number,
 * no percent, no depleting bar (the no-counter rule). The actual switch happens at
 * the cap (the handoff screen); this only informs, never blocks.
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
  // HARD RULE: no number, no percent, no bar. The fraction stays internal and is
  // used only to decide whether to show this note at all; the note itself is a
  // calm pointer to the free fallback, never a depleting gauge.
  if (tone === "quiet") return null;

  return (
    <div className="tl-tutorfuel tl-tutorfuel-low" role="status">
      <span className="tl-fuel-label">
        Included tutoring is running low. It keeps working with your own key or a local model, free.
      </span>
    </div>
  );
}

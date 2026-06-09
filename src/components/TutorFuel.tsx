import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanyCredits } from "../types";

/**
 * Company-mode "tutor fuel" strip for the margin tutor card. Quiet by design:
 * below 75% used it is just a thin bar; at 75%+ it adds a gentle nudge, at 90%+
 * a clearer one — both pointing at the free path (BYO key / local model), never
 * blocking, never naming a dollar amount. The actual switch happens at the cap
 * (the three-door screen), so the nudges inform without stranding paid allowance.
 */
export type FuelTone = "quiet" | "nudge" | "low";

/** Thresholds are on the USED fraction: quiet < 75%, nudge ≥ 75%, low ≥ 90%. */
export function fuelTone(usedFraction: number): FuelTone {
  if (usedFraction >= 0.9) return "low";
  if (usedFraction >= 0.75) return "nudge";
  return "quiet";
}

export const FUEL_NUDGE_75 =
  "About a quarter of your included AI left. When it runs out, you can keep going free with your own key or a local model.";
export const FUEL_NUDGE_90 =
  "Your included AI is almost done. Keep going free afterward — your own key or LM Studio on this Mac, about two minutes to set up.";

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
  const pct = Math.round(remaining * 100);

  return (
    <div
      className={`tl-tutorfuel ${tone}`}
      role="status"
      aria-label={`Throughline AI: about ${pct}% left`}
    >
      <span className="tl-fuel-bar" aria-hidden="true">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      {tone !== "quiet" && (
        <p className="tl-tutorfuel-note">{tone === "low" ? FUEL_NUDGE_90 : FUEL_NUDGE_75}</p>
      )}
    </div>
  );
}

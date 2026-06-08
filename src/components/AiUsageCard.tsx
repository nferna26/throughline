import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UsageSummary } from "../types";

const fmt = (micros: number) =>
  `$${(micros / 1_000_000).toFixed(micros > 0 && micros < 1_000_000 ? 4 : 2)}`;

/**
 * Settings "AI usage" card (Epic B4): spend so far (all-time + this month, from
 * recorded token usage at catalogued prices) and an optional monthly spend cap
 * that stops cloud tutoring once month-to-date spend reaches it (0 = off).
 */
export default function AiUsageCard() {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [capInput, setCapInput] = useState("");

  const load = () =>
    invoke<UsageSummary>("cmd_get_usage_summary")
      .then((s) => {
        setU(s);
        setCapInput(s.spend_cap_cents > 0 ? String(s.spend_cap_cents / 100) : "");
      })
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const saveCap = async () => {
    const dollars = parseFloat(capInput);
    const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    await invoke("cmd_set_monthly_spend_cap", { cents });
    load();
  };

  return (
    <div className="tl-set-group">
      <span className="glabel">AI usage</span>
      <div className="tl-set-card">
        <div className="tl-set-row">
          <div className="lhs">
            <div className="name">Spend so far</div>
            <div className="desc">
              Estimated from token usage at catalogued prices (as of {u?.pricing_verified_at ?? "—"}).
              With your own key you pay your provider directly.
            </div>
          </div>
          <div className="tl-usage-figures">
            <div>
              <strong>{u ? fmt(u.total_cost_micros) : "—"}</strong>
              <span>all time</span>
            </div>
            <div>
              <strong>{u ? fmt(u.month_cost_micros) : "—"}</strong>
              <span>this month</span>
            </div>
            <div>
              <strong>{u?.total_calls ?? 0}</strong>
              <span>calls</span>
            </div>
          </div>
        </div>
        {u && u.by_provider.length > 0 && (
          <div className="tl-usage-breakdown">
            {u.by_provider.map((r) => (
              <span key={r.key} className="tl-price-chip">
                {r.key}: {fmt(r.cost_micros)} · {r.calls}
              </span>
            ))}
          </div>
        )}
        <div className="tl-set-row col">
          <div className="lhs">
            <div className="name">Monthly spend cap</div>
            <div className="desc">
              Stop cloud tutoring once this month's estimated spend reaches this. Blank or 0 = no cap.
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--tl-2)", alignItems: "center" }}>
            <span>$</span>
            <input
              className="tl-input"
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              placeholder="no cap"
              aria-label="Monthly AI spend cap in dollars"
              style={{ maxWidth: 120 }}
            />
            <button
              className="tl-btn tl-btn-ghost"
              style={{ padding: "8px 12px", fontSize: 13 }}
              onClick={saveCap}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

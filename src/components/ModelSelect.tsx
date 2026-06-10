import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelInfo } from "../types";

/**
 * Cloud model picker: a dropdown of the provider's catalogue (cmd_model_catalog)
 * with a price chip beside the selected model, so the reader chooses with cost in
 * view. The chip speaks plainly — "$X / $Y per million words" (the going-rate
 * approximation; never "Mtok"/"tokens", per the experience bar's ban on plumbing
 * words). A hand-typed model that isn't catalogued is preserved as "(custom)".
 * Local (LM Studio) keeps its own detected-models UI in Settings — this is cloud-only.
 */
export default function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  useEffect(() => {
    let alive = true;
    // Wrap in Promise.resolve so a non-promise / synchronous throw from the IPC
    // layer (e.g. a stubbed backend in tests) can never break the component.
    Promise.resolve()
      .then(() => invoke<ModelInfo[]>("cmd_model_catalog", { provider }))
      .then((c) => alive && setCatalog(Array.isArray(c) ? c : []))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, [provider]);

  // Default to the provider's best (first/"default") model when nothing is chosen.
  useEffect(() => {
    if (catalog.length > 0 && !value) onChange(catalog[0].id);
  }, [catalog, value, onChange]);

  const known = catalog.some((m) => m.id === value);
  const sel = catalog.find((m) => m.id === value);

  return (
    <div className="tl-modelselect">
      <select
        className="tl-select"
        aria-label="AI model"
        value={known ? value : value ? "__custom__" : ""}
        onChange={(e) => {
          if (e.target.value && e.target.value !== "__custom__") onChange(e.target.value);
        }}
      >
        {catalog.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {value && !known && <option value="__custom__">{value} (custom)</option>}
      </select>
      {sel && (
        <span
          className="tl-price-chip"
          aria-label={`Costs ${sel.input_per_mtok} dollars per million for what you send and ${sel.output_per_mtok} per million for what it writes back`}
        >
          ${sel.input_per_mtok} / ${sel.output_per_mtok} <span className="unit">per million words</span>
        </span>
      )}
    </div>
  );
}

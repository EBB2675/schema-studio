import React, { useMemo, useState } from "react";
import { SUPPORTED_DTYPES, type QuantityFormData } from "./quantityShared";

type Props = {
  enabled: boolean;
  targetClass: string | null;
  onSubmit: (data: QuantityFormData) => Promise<void>;
  submitting: boolean;
  error: string | null;
  blockedReason?: string | null;
};

export default function AddQuantityForm({ enabled, targetClass, onSubmit, submitting, error, blockedReason }: Props) {
  const [quantityName, setQuantityName] = useState("");
  const [dtype, setDtype] = useState(SUPPORTED_DTYPES[0]);
  const [docstring, setDocstring] = useState("");

  const disabledReason = useMemo(() => {
    if (blockedReason) return blockedReason;
    if (!enabled) return "Enable editable mode to add quantities";
    if (!targetClass) return "Select a class node to target";
    return null;
  }, [enabled, targetClass, blockedReason]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabledReason) return;
    await onSubmit({ quantityName: quantityName.trim(), dtype, docstring: docstring.trim() });
  };

  const canSubmit = quantityName.trim().length > 0 && !submitting && !disabledReason;

  return (
    <form onSubmit={handleSubmit} className="panel" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div>
        <div className="label" style={{ marginBottom: 2 }}>Target class</div>
        <div style={{ fontWeight: 600 }}>{targetClass ?? "—"}</div>
      </div>

      <div>
        <label className="label" htmlFor="quantityName">Quantity name</label>
        <input
          id="quantityName"
          className="input"
          value={quantityName}
          onChange={(e) => setQuantityName(e.target.value)}
          placeholder="e.g. new_quantity"
          disabled={!!disabledReason}
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="dtype">Type</label>
        <select
          id="dtype"
          className="select"
          value={dtype}
          onChange={(e) => setDtype(e.target.value)}
          disabled={!!disabledReason}
        >
          {SUPPORTED_DTYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="docstring">Docstring (optional)</label>
        <textarea
          id="docstring"
          className="input"
          style={{ minHeight: 60, resize: "vertical" }}
          value={docstring}
          onChange={(e) => setDocstring(e.target.value)}
          placeholder="Describe the quantity"
          disabled={!!disabledReason}
        />
      </div>

      {error && (
        <div style={{ color: "#b91c1c", fontSize: 13 }}>
          {error}
        </div>
      )}

      {disabledReason && (
        <div style={{ color: "#6b7280", fontSize: 13 }}>
          {disabledReason}
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" type="submit" disabled={!canSubmit}>
          {submitting ? "Adding…" : "Add quantity"}
        </button>
      </div>
    </form>
  );
}


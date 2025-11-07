import React from "react";
import { useSelection, type QtyMeta } from "../store/selection";

function QtyRow({ q, onClick }: { q: QtyMeta; onClick: () => void }) {
  const meta: string[] = [];
  if (q.dtype) meta.push(q.dtype);
  if (q.shape && q.shape !== "[]") meta.push(q.shape);
  if (q.card) meta.push(`[${q.card}]`);
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: 8,
        border: "1px solid #e5e7eb",
        background: "#fff",
        cursor: "pointer"
      }}
    >
      <div style={{ flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" }}>
        <div style={{ fontSize: 13 }}>{q.name}</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{meta.join("  ")}</div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.6 }}>View</div>
    </button>
  );
}

export default function DocPanel() {
  const { selected, setSelected } = useSelection();

  const showQuantity = (q: QtyMeta) => {
    setSelected({
      id: q.id,
      kind: "quantity",
      name: q.name,
      doc: q.doc || "",
      path: q.path,
      line: q.line,
      dtype: q.dtype,
      shape: q.shape,
      card: q.card,
      owner: q.owner
    });
  };

  return (
    <aside
      style={{
        width: 360,
        borderLeft: "1px solid #e5e7eb",
        padding: 16,
        overflow: "auto",
        height: "100vh",
        boxSizing: "border-box",
        background: "#fff"
      }}
    >
      {!selected ? (
        <div style={{ opacity: 0.6, fontSize: 13 }}>Select a class to see its docstring and quantities.</div>
      ) : selected.kind === "class" ? (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.7, marginBottom: 6 }}>
            class
          </div>
          <h2 style={{ fontSize: 18, margin: "0 0 8px 0" }}>{selected.name}</h2>
          {(selected.path || selected.line) && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
              {selected.path}{selected.line ? `:${selected.line}` : ""}
            </div>
          )}
          <pre style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 16 }}>
            {selected.doc || "No docstring available."}
          </pre>

          <div style={{ fontSize: 12, fontWeight: 600, margin: "8px 0 6px" }}>
            Quantities {selected.quantities ? `(${selected.quantities.length})` : "(0)"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(selected.quantities ?? []).map((q) => (
              <QtyRow key={q.id} q={q} onClick={() => showQuantity(q)} />
            ))}
            {(!selected.quantities || selected.quantities.length === 0) && (
              <div style={{ fontSize: 12, opacity: 0.6 }}>No quantities found.</div>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.7, marginBottom: 6 }}>
            quantity
          </div>
          <h2 style={{ fontSize: 18, margin: "0 0 8px 0" }}>{selected.name}</h2>
          {(selected.path || selected.line) && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
              {selected.path}{selected.line ? `:${selected.line}` : ""}
            </div>
          )}
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
            {[selected.dtype, selected.shape && selected.shape !== "[]"
              ? selected.shape
              : null, selected.card ? `[${selected.card}]` : null]
              .filter(Boolean).join("  ")}
          </div>
          <pre style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {selected.doc || "No docstring available."}
          </pre>
        </>
      )}
    </aside>
  );
}

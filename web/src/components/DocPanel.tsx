import { useSelection, type QtyMeta } from "../store/selection";

function QtyRow({ q, onClick }: { q: QtyMeta; onClick: () => void }) {
  const meta: string[] = [];
  if (q.dtype) meta.push(q.dtype);
  if (q.shape && q.shape !== "[]") meta.push(q.shape);
  if (q.card) meta.push(`[${q.card}]`);
  return (
    <button className="qty-row" onClick={onClick}>
      <div style={{ flex: 1 }} className="qty-mono">
        <div style={{ fontSize: 13 }}>{q.name}</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{meta.join("  ")}</div>
      </div>
      <div className="tag" style={{ borderColor: "rgba(124, 58, 237, 0.4)", color: "#c7d2fe" }}>View</div>
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
    <div className="doc-shell">
      {!selected ? (
        <div className="doc-empty">Select a class to see its docstring and quantities.</div>
      ) : selected.kind === "class" ? (
        <>
          <div className="doc-header">
            <div className="meta-label">Class</div>
            {selected.path ? (
              <div className="code-badge">
                <span>{selected.path}{selected.line ? `:${selected.line}` : ""}</span>
              </div>
            ) : null}
          </div>
          <h2 className="doc-title">{selected.name}</h2>
          <pre className="doc-docstring">{selected.doc || "No docstring available."}</pre>

          <div className="doc-subtitle">
            <span>Quantities</span>
            <span className="qty-count">{selected.quantities ? selected.quantities.length : 0}</span>
          </div>
          <div className="doc-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
          <div className="doc-header">
            <div className="meta-label">Quantity</div>
            {(selected.path || selected.line) && (
              <div className="code-badge">
                {selected.path}{selected.line ? `:${selected.line}` : ""}
              </div>
            )}
          </div>
          <h2 className="doc-title">{selected.name}</h2>
          <div className="doc-meta">
            {[selected.dtype, selected.shape && selected.shape !== "[]"
              ? selected.shape
              : null, selected.card ? `[${selected.card}]` : null]
              .filter(Boolean).join("  ")}
          </div>
          <pre className="doc-docstring">{selected.doc || "No docstring available."}</pre>
        </>
      )}
    </div>
  );
}

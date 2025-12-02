import { useEffect, useMemo, useState } from "react";
import { useSelection, type QtyMeta } from "../store/selection";
import { SUPPORTED_DTYPES, type QuantityFormData } from "./quantityShared";

type Props = {
  editableMode: boolean;
  blockedReason?: string | null;
  actionError?: string | null;
  onEditQuantity: (id: string, updates: QuantityFormData) => void;
  onRemoveQuantity: (id: string) => void;
  clearActionError: () => void;
};

function QtyRow({ q, onClick, onEdit, onRemove, editableMode, disabled }: { q: QtyMeta; onClick: () => void; onEdit: () => void; onRemove: () => void; editableMode: boolean; disabled: boolean }) {
  const meta: string[] = [];
  if (q.dtype) meta.push(q.dtype);
  if (q.shape && q.shape !== "[]") meta.push(q.shape);
  if (q.card) meta.push(`[${q.card}]`);
  const handleClick = () => {
    if (editableMode && !disabled) {
      onEdit();
      onClick();
      return;
    }
    onClick();
  };
  return (
    <div className="qty-row" style={{ gap: 8 }}>
      <button className="qty-row" type="button" onClick={handleClick} style={{ flex: 1 }}>
        <div style={{ flex: 1 }} className="qty-mono">
          <div style={{ fontSize: 13 }}>{q.name}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{meta.join("  ")}</div>
        </div>
        <div className="tag" style={{ borderColor: "rgba(124, 58, 237, 0.4)", color: "#c7d2fe" }}>View</div>
      </button>

      {editableMode && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn secondary" type="button" style={{ padding: "6px 10px" }} onClick={onEdit} disabled={disabled}>
            Edit
          </button>
          <button className="btn secondary" type="button" style={{ padding: "6px 10px" }} onClick={onRemove} disabled={disabled}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

export default function DocPanel({ editableMode, onEditQuantity, onRemoveQuantity, blockedReason, actionError, clearActionError }: Props) {
  const { selected, setSelected } = useSelection();
  const [editing, setEditing] = useState<QtyMeta | null>(null);
  const [formName, setFormName] = useState("");
  const [formDtype, setFormDtype] = useState(SUPPORTED_DTYPES[0]);
  const [formDoc, setFormDoc] = useState("");

  useEffect(() => {
    // Preserve the edit session when switching from a class to one of its quantities.
    if (selected?.kind !== "quantity") {
      setEditing(null);
    }
    clearActionError();
  }, [selected, clearActionError]);

  useEffect(() => {
    if (!editing) return;
    setFormName(editing.name);
    setFormDtype(editing.dtype || SUPPORTED_DTYPES[0]);
    setFormDoc(editing.doc || "");
  }, [editing]);

  const disableActions = useMemo(() => !!blockedReason || !editableMode, [blockedReason, editableMode]);

  const commitEdit = () => {
    if (!editing) return;
    onEditQuantity(editing.id, { quantityName: formName, dtype: formDtype, docstring: formDoc });
  };

  const confirmRemove = (id: string) => {
    if (!editableMode || disableActions) return;
    if (confirm("Remove this quantity from the current diagram?")) {
      onRemoveQuantity(id);
      setEditing(null);
    }
  };

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

  const renderEditPanel = () => (
    <div className="panel" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="doc-subtitle" style={{ margin: 0 }}>Edit quantity</div>
      <div>
        <label className="label" htmlFor="edit-name">Name</label>
        <input
          id="edit-name"
          className="input"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          disabled={disableActions}
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-dtype">Type</label>
        <select
          id="edit-dtype"
          className="select"
          value={formDtype}
          onChange={(e) => setFormDtype(e.target.value)}
          disabled={disableActions}
        >
          {SUPPORTED_DTYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="edit-doc">Docstring</label>
        <textarea
          id="edit-doc"
          className="input"
          style={{ minHeight: 80, resize: "vertical" }}
          value={formDoc}
          onChange={(e) => setFormDoc(e.target.value)}
          disabled={disableActions}
        />
      </div>

      {actionError && <div style={{ color: "#b91c1c", fontSize: 13 }}>{actionError}</div>}
      {blockedReason && <div style={{ color: "#6b7280", fontSize: 13 }}>{blockedReason}</div>}

      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <button className="btn secondary" type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <div className="row" style={{ gap: 6 }}>
          {editing ? (
            <button className="btn secondary" type="button" onClick={() => confirmRemove(editing.id)} disabled={disableActions}>
              Remove
            </button>
          ) : null}
          <button className="btn" type="button" onClick={commitEdit} disabled={disableActions || !formName.trim()}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );

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
              <QtyRow
                key={q.id}
                q={q}
                onClick={() => showQuantity(q)}
                onEdit={() => setEditing(q)}
                onRemove={() => confirmRemove(q.id)}
                editableMode={editableMode}
                disabled={disableActions}
              />
            ))}
            {(!selected.quantities || selected.quantities.length === 0) && (
              <div style={{ fontSize: 12, opacity: 0.6 }}>No quantities found.</div>
            )}
          </div>

          {editableMode && (
            editing ? (
              renderEditPanel()
            ) : (
              <div className="panel" style={{ marginTop: 10 }}>
                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  {blockedReason || "Pick a quantity to edit or remove it from the current diagram."}
                </div>
              </div>
            )
          )}
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

          {editableMode && selected.owner ? (
            editing ? (
              renderEditPanel()
            ) : (
              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => setEditing({ ...selected, owner: selected.owner || "", id: selected.id })} disabled={disableActions}>
                  Edit this quantity
                </button>
              </div>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import QuantityEditPanel from "./QuantityEditPanel";
import { useSelection, type QtyMeta, type Selected } from "../store/selection";

type Props = {
  editableMode: boolean;
  blockedReason?: string | null;
  actionError?: string | null;
  onRemoveQuantity: (id: string) => void;
  onEditQuantity: (id: string, updates: { quantityName: string; dtype: string; docstring: string }) => void;
  onEditClass: (id: string, updates: { docstring: string }) => void;
  clearActionError: () => void;
};

function QtyRow({ q, onClick, onEdit, onRemove, editableMode, disabled }: { q: QtyMeta; onClick: () => void; onEdit: () => void; onRemove: () => void; editableMode: boolean; disabled: boolean }) {
  const meta: string[] = [];
  if (q.dtype) meta.push(q.dtype);
  if (q.shape && q.shape !== "[]") meta.push(q.shape);
  if (q.card) meta.push(`[${q.card}]`);
  if (q.inherited) {
    meta.push(`Inherited from ${q.inheritedFromName || q.inheritedFromId || "parent"}`);
  }

  const diffLabel =
    q.diff?.state === "added"
      ? "Added"
      : q.diff?.state === "removed"
        ? "Removed"
        : q.diff?.state === "changed"
          ? "Changed"
          : null;

  const diffClass =
    q.diff?.state === "added"
      ? "pill"
      : q.diff?.state === "removed"
        ? "pill muted"
        : q.diff?.state === "changed"
          ? "pill warning"
          : null;

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
        {diffLabel ? <span className={diffClass || "pill"}>{diffLabel}</span> : null}
        <div className={`tag ${q.inherited ? "inherited" : "view"}`}>{q.inherited ? "Inherited" : "View"}</div>
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

export default function DocPanel({
  editableMode,
  onRemoveQuantity,
  onEditQuantity,
  onEditClass,
  blockedReason,
  actionError,
  clearActionError,
}: Props) {
  const { selected, setSelected } = useSelection();
  const [classContext, setClassContext] = useState<Selected | null>(null);
  const [editingClassDoc, setEditingClassDoc] = useState(false);
  const [classDocDraft, setClassDocDraft] = useState("");

  useEffect(() => {
    clearActionError();
  }, [selected, clearActionError]);

  useEffect(() => {
    if (selected?.kind === "class") {
      setClassContext(selected);
      setClassDocDraft(selected.doc || "");
      setEditingClassDoc(false);
    }
  }, [selected]);

  const disableActions = useMemo(() => !!blockedReason || !editableMode, [blockedReason, editableMode]);

  const confirmRemove = (id: string) => {
    if (!editableMode || disableActions) return;
    if (confirm("Remove this quantity from the current diagram?")) {
      onRemoveQuantity(id);
    }
  };

  const showQuantity = (q: QtyMeta) => {
    if (selected?.kind === "class") {
      setClassContext(selected);
    }
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
      owner: q.owner,
      inherited: q.inherited ?? false,
      inheritedFromId: q.inheritedFromId ?? null,
      inheritedFromName: q.inheritedFromName ?? null,
      sourceId: q.sourceId ?? null,
      diff: q.diff
    });
  };

  const goBackToClass = () => {
    if (classContext) {
      setSelected(classContext);
    } else {
      setSelected(null);
    }
  };

  const commitClassDoc = () => {
    if (selected?.kind !== "class" || disableActions) return;
    onEditClass(selected.id, { docstring: classDocDraft });
    setEditingClassDoc(false);
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
          <div style={{ marginBottom: 14 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div className="meta-label">Docstring</div>
              {editableMode ? (
                <button
                  className="btn secondary"
                  type="button"
                  aria-label={editingClassDoc ? "Cancel class docstring edit" : "Edit class docstring"}
                  style={{ padding: "6px 10px" }}
                  onClick={() => setEditingClassDoc((prev) => !prev)}
                  disabled={disableActions}
                >
                  {editingClassDoc ? "Cancel" : "Edit"}
                </button>
              ) : null}
            </div>
            {editingClassDoc ? (
              <div className="action-stack" style={{ gap: 8 }}>
                <textarea
                  className="input"
                  aria-label="Class docstring"
                  style={{ minHeight: 100, resize: "vertical" }}
                  value={classDocDraft}
                  onChange={(e) => setClassDocDraft(e.target.value)}
                  disabled={disableActions}
                />
                {actionError ? <div style={{ color: "#b91c1c", fontSize: 13 }}>{actionError}</div> : null}
                {blockedReason ? <div style={{ color: "#6b7280", fontSize: 13 }}>{blockedReason}</div> : null}
                <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn" type="button" onClick={commitClassDoc} disabled={disableActions}>
                    Save changes
                  </button>
                </div>
              </div>
            ) : (
              <pre className="doc-docstring">{selected.doc || "No docstring available."}</pre>
            )}
          </div>

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
                onEdit={() => showQuantity(q)}
                onRemove={() => confirmRemove(q.id)}
                editableMode={editableMode}
                disabled={disableActions || !!q.inherited}
              />
            ))}
            {(!selected.quantities || selected.quantities.length === 0) && (
              <div style={{ fontSize: 12, opacity: 0.6 }}>No quantities found.</div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="doc-header" style={{ justifyContent: "space-between", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="btn secondary" type="button" onClick={goBackToClass} disabled={!classContext}>
                ← Back
              </button>
              <div>
                <div className="meta-label">Quantity</div>
                <h2 className="doc-title" style={{ margin: "4px 0" }}>{selected.name}</h2>
              </div>
            </div>
            {(selected.path || selected.line) && (
              <div className="code-badge">
                {selected.path}{selected.line ? `:${selected.line}` : ""}
              </div>
            )}
          </div>
          <div className="doc-meta">
            {[selected.dtype, selected.shape && selected.shape !== "[]"
              ? selected.shape
              : null, selected.card ? `[${selected.card}]` : null]
              .filter(Boolean).join("  ")}
          </div>
          {selected.inherited ? (
            <div className="small" style={{ marginTop: 6 }}>
              Inherited from {selected.inheritedFromName || selected.inheritedFromId || "parent"}.
            </div>
          ) : null}
          <pre className="doc-docstring">{selected.doc || "No docstring available."}</pre>

          <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--panel-border)" }}>
            {selected.diff ? (
              <div className="doc-card" style={{ marginBottom: 12, background: "rgba(234, 179, 8, 0.05)" }}>
                <div className="meta-label" style={{ marginBottom: 6 }}>
                  Diff
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div>
                    <strong>Status:</strong> {selected.diff.state}
                  </div>
                  {selected.diff.before ? (
                    <div style={{ fontSize: 12 }}>
                      <strong>Before:</strong> {[selected.diff.before.dtype, selected.diff.before.shape && selected.diff.before.shape !== "[]" ? selected.diff.before.shape : null, selected.diff.before.card ? `[${selected.diff.before.card}]` : null].filter(Boolean).join("  ") || "no metadata"}
                    </div>
                  ) : null}
                  {selected.diff.after ? (
                    <div style={{ fontSize: 12 }}>
                      <strong>After:</strong> {[selected.diff.after.dtype, selected.diff.after.shape && selected.diff.after.shape !== "[]" ? selected.diff.after.shape : null, selected.diff.after.card ? `[${selected.diff.after.card}]` : null].filter(Boolean).join("  ") || "no metadata"}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            <QuantityEditPanel
              editableMode={editableMode}
              blockedReason={blockedReason}
              actionError={actionError}
              clearActionError={clearActionError}
              onEditQuantity={onEditQuantity}
              onRemoveQuantity={onRemoveQuantity}
            />
          </div>
        </>
      )}
    </div>
  );
}

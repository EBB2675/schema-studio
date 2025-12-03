import { useEffect, useMemo, useState } from "react";
import { useSelection } from "../store/selection";
import { SUPPORTED_DTYPES, type QuantityFormData } from "./quantityShared";

type Props = {
  editableMode: boolean;
  blockedReason?: string | null;
  actionError?: string | null;
  clearActionError: () => void;
  onEditQuantity: (id: string, updates: QuantityFormData) => void;
  onRemoveQuantity: (id: string) => void;
};

export default function QuantityEditPanel({
  editableMode,
  blockedReason,
  actionError,
  clearActionError,
  onEditQuantity,
  onRemoveQuantity,
}: Props) {
  const { selected } = useSelection();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDtype, setFormDtype] = useState<string>(SUPPORTED_DTYPES[0]);
  const [formDoc, setFormDoc] = useState("");

  const disableActions = useMemo(() => !!blockedReason || !editableMode, [blockedReason, editableMode]);

  useEffect(() => {
    clearActionError();
    if (selected?.kind === "quantity" && selected.owner) {
      setEditingId(selected.id);
      setFormName(selected.name);
      setFormDtype(selected.dtype || SUPPORTED_DTYPES[0]);
      setFormDoc(selected.doc || "");
    } else {
      setEditingId(null);
    }
  }, [selected, clearActionError]);

  const commitEdit = () => {
    if (!editingId) return;
    onEditQuantity(editingId, { quantityName: formName, dtype: formDtype, docstring: formDoc });
  };

  const confirmRemove = () => {
    if (!editingId || !editableMode || disableActions) return;
    if (confirm("Remove this quantity from the current diagram?")) {
      onRemoveQuantity(editingId);
    }
  };

  const showSelectionHint = () => {
    if (!editableMode) {
      return "Enable editable mode to modify quantities.";
    }
    if (blockedReason) {
      return blockedReason;
    }
    return "Select a quantity in the documentation panel to edit or remove it.";
  };

  return (
    <div className="action-stack" style={{ gap: 12 }}>
      {!editingId ? (
        <div style={{ color: "#6b7280", fontSize: 13 }}>{showSelectionHint()}</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div className="doc-subtitle" style={{ margin: 0 }}>Edit quantity</div>
            {(selected?.path || selected?.line) && (
              <div className="code-badge" style={{ background: "rgba(255,255,255,0.02)" }}>
                <span>{selected?.path}{selected?.line ? `:${selected.line}` : ""}</span>
              </div>
            )}
          </div>

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
            <button className="btn secondary" type="button" onClick={confirmRemove} disabled={disableActions}>
              Remove
            </button>
            <button className="btn" type="button" onClick={commitEdit} disabled={disableActions || !formName.trim()}>
              Save changes
            </button>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useSelection } from "../store/selection";
import { NOMAD_EDIT_RULES, VOCAB_TERM, dtypeNameFor, type EditRules, type QuantityFormData } from "./quantityShared";

type Props = {
  editRules?: EditRules;
  editableMode: boolean;
  blockedReason?: string | null;
  actionError?: string | null;
  clearActionError: () => void;
  onEditQuantity: (id: string, updates: QuantityFormData) => void | Promise<void>;
  onRemoveQuantity: (id: string) => void | Promise<void>;
};

export default function QuantityEditPanel({
  editRules = NOMAD_EDIT_RULES,
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
  // "" keeps the current type (also when it is not one the user can pick, like a reference).
  const [formDtype, setFormDtype] = useState<string>("");
  const [formRange, setFormRange] = useState("");
  const [formMandatory, setFormMandatory] = useState(false);
  const [formDoc, setFormDoc] = useState("");
  const isTerm = selected?.kind === "quantity" && selected.dtype === VOCAB_TERM;
  const needsRange = editRules.dtypes.find((dtype) => dtype.name === formDtype)?.needs_range ?? false;
  const inheritedBlockedReason =
    selected?.kind === "quantity" && selected.inherited
      ? `This quantity is inherited from ${selected.inheritedFromName || selected.inheritedFromId || "a parent class"} and is read-only here.`
      : null;

  const disableActions = useMemo(
    () => !!blockedReason || !editableMode || !!inheritedBlockedReason,
    [blockedReason, editableMode, inheritedBlockedReason]
  );

  useEffect(() => {
    clearActionError();
    if (selected?.kind === "quantity" && selected.owner) {
      setEditingId(selected.id);
      setFormName(selected.name);
      setFormDtype(dtypeNameFor(editRules, selected.dtype));
      setFormRange("");
      setFormMandatory(Boolean(selected.details?.mandatory));
      setFormDoc(selected.doc || "");
    } else {
      setEditingId(null);
    }
  }, [selected, clearActionError, editRules]);

  const commitEdit = () => {
    if (!editingId) return;
    void onEditQuantity(editingId, {
      quantityName: formName,
      dtype: formDtype,
      docstring: formDoc,
      range: needsRange ? formRange : undefined,
      mandatory: editRules.codes ? formMandatory : undefined,
    });
  };

  const confirmRemove = () => {
    if (!editingId || !editableMode || disableActions) return;
    if (confirm("Remove this quantity from the current diagram?")) {
      void onRemoveQuantity(editingId);
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
              disabled={disableActions || isTerm}
              title={isTerm ? "A vocabulary term is named by its code" : undefined}
            />
          </div>

          {isTerm ? null : (
            <div>
              <label className="label" htmlFor="edit-dtype">Type</label>
              <select
                id="edit-dtype"
                className="select"
                value={formDtype}
                onChange={(e) => setFormDtype(e.target.value)}
                disabled={disableActions}
              >
                {formDtype === "" ? <option value="">{selected?.kind === "quantity" ? selected.dtype || "unchanged" : "unchanged"}</option> : null}
                {editRules.dtypes.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {!isTerm && needsRange ? (
            <div>
              <label className="label" htmlFor="edit-range">Target (class id)</label>
              <input
                id="edit-range"
                className="input"
                value={formRange}
                onChange={(e) => setFormRange(e.target.value)}
                placeholder={formDtype === "CONTROLLEDVOCABULARY" ? "vocabulary class" : "object type class"}
                disabled={disableActions}
              />
            </div>
          ) : null}

          {editRules.codes && !isTerm ? (
            <label className="row" style={{ alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={formMandatory}
                onChange={(e) => setFormMandatory(e.target.checked)}
                disabled={disableActions}
              />
              Mandatory
            </label>
          ) : null}

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
          {inheritedBlockedReason && <div style={{ color: "#6b7280", fontSize: 13 }}>{inheritedBlockedReason}</div>}

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

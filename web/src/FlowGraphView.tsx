import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useNodesInitialized, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { toPng } from "html-to-image";
import type { GraphExportHandle, GraphViewProps } from "./GraphView";
import type { QuantityNode, UmlClassNode } from "./types/uml";
import { useSelection } from "./store/selection";
import { canvasEdges } from "./utils/canvasEdges";
import { canvasPositionKey, createCanvasPositionStore } from "./utils/canvasPositions";
import { placeNewNodes, type PlacedBox } from "./utils/canvasPlacement";
import { NOMAD_EDIT_RULES, VOCAB_TERM, dtypeNameFor, type QuantityFormData } from "./components/quantityShared";
import "@xyflow/react/dist/style.css";
import "./flow-editor.css";

export type FlowGraphProps = GraphViewProps & {
  mobile?: boolean;
  positionStorageKey?: string;
  onRenameClass: (id: string, name: string) => Promise<string>;
  onEditQuantity: (id: string, data: QuantityFormData) => Promise<boolean>;
};
type CardNode = Node<{ cls: UmlClassNode }, "schemaClass">;
const EditorContext = createContext<FlowGraphProps | null>(null);
const touchEditing = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
function useEditor() { return useContext(EditorContext)!; }
const qtySelection = (q: QuantityNode) => ({ ...q, owner: q.ownerId, doc: q.doc ?? "", path: q.path ?? undefined, line: q.line ?? undefined });
function selectClass(cls: UmlClassNode, props: FlowGraphProps) {
  props.onSelectClass?.(cls);
  useSelection.getState().setSelected({ id: cls.id, kind: "class", name: cls.name, doc: cls.doc ?? "", quantities: cls.quantities.map(qtySelection), details: cls.details });
}

export function InlineName({ name, onSave, onClose }: { name: string; onSave: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return;
    if (!value.trim()) { setError("Enter a name."); return; }
    if (value.trim() === name) { onClose(); return; }
    saving.current = true;
    setBusy(true);
    try { await onSave(value.trim()); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="nodrag nowheel flow-inline" onClick={e => e.stopPropagation()}>
    <input aria-label="Class name" autoFocus value={value} disabled={busy} onFocus={e => e.target.select()} onChange={e => setValue(e.target.value)} onBlur={() => void save()} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); void save(); }
      if (e.key === "Escape" && !busy) { e.preventDefault(); onClose(); }
    }} />
    {busy && <small role="status">Saving…</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function QuantityForm({ cls, quantity, props, onClose }: { cls: UmlClassNode; quantity?: QuantityNode; props: FlowGraphProps; onClose: () => void }) {
  const rules = props.editRules ?? NOMAD_EDIT_RULES;
  const term = quantity ? quantity.dtype === VOCAB_TERM : rules.codes && cls.quantities.some(q => q.dtype === VOCAB_TERM);
  const [draft, setDraft] = useState<QuantityFormData>({ quantityName: quantity?.name ?? "", dtype: quantity ? dtypeNameFor(rules, quantity.dtype) : rules.dtypes[0]?.name ?? "", docstring: quantity?.doc ?? "", code: "", label: "", range: "", mandatory: Boolean(quantity?.details?.mandatory) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const needsRange = rules.dtypes.find(d => d.name === draft.dtype)?.needs_range;
  const update = (key: keyof QuantityFormData, value: string | boolean) => setDraft(d => ({ ...d, [key]: value }));
  return <form className="flow-form nodrag nowheel" aria-label={quantity ? "Edit quantity" : "Add quantity"} onClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape" && !busy) onClose(); }} onSubmit={async e => {
    e.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      if (quantity) {
        const ok = await props.onEditQuantity(quantity.id, draft);
        if (!ok) { setError("Could not save. Check the schema rules and the details panel."); return; }
      } else await props.onCreateQuantity?.(cls.id, draft);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { saving.current = false; setBusy(false); }
  }}>
    <strong>{quantity ? "Edit" : "Add"} {term ? "term" : "quantity"}</strong>
    <fieldset disabled={busy}>
      {rules.codes && !quantity && <label>Code<input autoFocus required value={draft.code} onChange={e => update("code", e.target.value)} /></label>}
      <label>Name<input autoFocus={!rules.codes || !!quantity} required={!rules.codes || !!quantity} disabled={!!quantity && term} value={draft.quantityName} onChange={e => update("quantityName", e.target.value)} /></label>
      {!term && <label>Type<select aria-label="Type" value={draft.dtype} onChange={e => update("dtype", e.target.value)}>
        {quantity && !draft.dtype && <option value="">{quantity.dtype || "Keep current type"}</option>}
        {rules.dtypes.map(d => <option key={d.name}>{d.name}</option>)}
      </select></label>}
      {needsRange && <label>Target class<input placeholder={quantity ? "Leave blank to keep current target" : "Class ID"} required={!quantity} list={`targets-${cls.id}`} value={draft.range} onChange={e => update("range", e.target.value)} /><datalist id={`targets-${cls.id}`}>{props.umlState?.classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</datalist></label>}
      {rules.codes && !quantity && <label>Label<input value={draft.label} onChange={e => update("label", e.target.value)} /></label>}
      {rules.codes && !term && <label className="flow-check"><input type="checkbox" checked={draft.mandatory} onChange={e => update("mandatory", e.target.checked)} /> Mandatory</label>}
      <label>Description<textarea rows={3} value={draft.docstring} onChange={e => update("docstring", e.target.value)} /></label>
    </fieldset>
    {error && <div role="alert">{error}</div>}
    <div className="flow-form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
  </form>;
}

function MobileEditSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="flow-mobile-dialog nodrag nowheel" aria-label={title} onClick={e => e.stopPropagation()} onCancel={e => {
    e.preventDefault();
    if (!dialog.current?.querySelector("fieldset:disabled")) onClose();
  }}>
    {children}
  </dialog>;
}

function ClassCard({ data, selected }: NodeProps<CardNode>) {
  const props = useEditor();
  const { cls } = data;
  const flow = useReactFlow();
  const [rename, setRename] = useState(false);
  const [editing, setEditing] = useState<QuantityNode | "new" | null>(null);
  // Bring the form into view, including cards near the bottom of the canvas.
  useEffect(() => {
    if (!rename && (!editing || props.mobile)) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { void flow.fitView({ nodes: [{ id: cls.id }], padding: 0.3, maxZoom: 1, duration: 180 }); });
    });
    return () => cancelAnimationFrame(frame);
  }, [rename, editing, cls.id, flow, props.mobile]);
  const expanded = props.expandedClassIds?.includes(cls.id);
  const [expandError, setExpandError] = useState("");
  const direction = props.layoutDirection ?? "UP";
  const source = { UP: Position.Top, DOWN: Position.Bottom, LEFT: Position.Left, RIGHT: Position.Right }[direction];
  const target = { UP: Position.Bottom, DOWN: Position.Top, LEFT: Position.Right, RIGHT: Position.Left }[direction];
  const editable = props.editableMode;
  return <article className={`flow-class ${selected ? "is-selected" : ""}`}>
    <Handle type="target" position={target} isConnectable={false} />
    <header className="flow-class-header" onDoubleClick={() => { if (editable) setRename(true); }}>
      <span className="flow-class-kind">{props.editRules?.codes ? "OBJECT TYPE" : "CLASS"}</span>
      {rename && editable ? <InlineName name={cls.name} onSave={name => props.onRenameClass(cls.id, name)} onClose={() => setRename(false)} /> :
        <button className="flow-title nodrag" onClick={() => { if (editable && touchEditing()) setRename(true); }} title={editable ? "Double-click to rename · Enter to edit" : cls.name} onKeyDown={e => { if (e.key === "Enter" && editable) { e.preventDefault(); setRename(true); } }}>{cls.name}</button>}
      <span className="flow-module" title={cls.module ?? ""}>{cls.module?.split(".").pop()}</span>
    </header>
    {!props.compact && <div className="flow-quantities">{cls.quantities.map(q => <button key={q.id} className={`flow-quantity nodrag ${q.inherited ? "is-inherited" : ""}`} title={q.inherited ? `Inherited from ${q.inheritedFromName || "parent"}` : "Double-click to edit · Enter to edit"} onClick={e => {
      e.stopPropagation(); useSelection.getState().setSelected({ ...qtySelection(q), kind: "quantity" });
      if (editable && !q.inherited && touchEditing()) setEditing(q);
    }} onDoubleClick={e => { e.stopPropagation(); if (editable && !q.inherited) setEditing(q); }} onKeyDown={e => { if (e.key === "Enter" && editable && !q.inherited) { e.preventDefault(); setEditing(q); } }}>
      <span>{q.name}</span><code>{q.inherited ? "inherited" : q.dtype?.replace(/^m_\w+\((.+)\)$/, "$1")}</code>
    </button>)}{!cls.quantities.length && <div className="flow-empty">No quantities yet</div>}</div>}
    {editing && editable ? props.mobile ? <MobileEditSheet title={editing === "new" ? "Add quantity" : "Edit quantity"} onClose={() => setEditing(null)}><QuantityForm key={typeof editing === "string" ? editing : editing.id} cls={cls} quantity={editing === "new" ? undefined : editing} props={props} onClose={() => setEditing(null)} /></MobileEditSheet> : <QuantityForm key={typeof editing === "string" ? editing : editing.id} cls={cls} quantity={editing === "new" ? undefined : editing} props={props} onClose={() => setEditing(null)} /> : editable && <button className="flow-add nodrag" onClick={e => { e.stopPropagation(); selectClass(cls, props); setEditing("new"); }}>+ Add {props.editRules?.codes && cls.quantities.some(q => q.dtype === VOCAB_TERM) ? "term" : "quantity"}</button>}
    {(expanded || (cls.subclasses ?? 0) > 0) && <button className="flow-expand nodrag" onClick={async e => { e.stopPropagation(); try { await props.onToggleSubclasses?.(cls.id); setExpandError(""); } catch { setExpandError("Could not load subclasses."); } }}>{expanded ? "− Hide subclasses" : `+ Show subclasses${cls.subclasses ? ` (${cls.subclasses})` : ""}`}</button>}
    {expandError && <small role="alert">{expandError}</small>}
    <Handle type="source" position={source} isConnectable={false} />
  </article>;
}
const nodeTypes = { schemaClass: ClassCard };

function NewClassForm({ props, onClose }: { props: FlowGraphProps; onClose: () => void }) {
  const [name, setName] = useState("");
  const [parentId, setParent] = useState(props.selectedClassId ?? "");
  const [relation, setRelation] = useState<"inherits" | "hasSubSection">("inherits");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  return <form className="flow-form flow-new-class" aria-label="Add class" onSubmit={async e => {
    e.preventDefault(); if (saving.current) return; saving.current = true; setBusy(true);
    try { await props.onCreateClass?.({ name: name.trim(), parentId: parentId || null, relation }); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not add class."); }
    finally { saving.current = false; setBusy(false); }
  }}>
    <strong>Add class</strong><fieldset disabled={busy}>
      <label>{props.editRules?.codes ? "Code" : "Name"}<input autoFocus required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Parent<select value={parentId} onChange={e => setParent(e.target.value)}><option value="">No parent</option>{props.umlState?.classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {parentId && !props.editRules?.codes && <label>Relationship<select value={relation} onChange={e => setRelation(e.target.value as typeof relation)}><option value="inherits">Inherits from parent</option><option value="hasSubSection">Subsection of parent</option></select></label>}
    </fieldset>{error && <div role="alert">{error}</div>}
    <div className="flow-form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || !name.trim()}>{busy ? "Adding…" : "Add class"}</button></div>
  </form>;
}

function FlowCanvas(props: FlowGraphProps) {
  const flow = useReactFlow<CardNode>();
  const nodesInitialized = useNodesInitialized();
  const container = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [addingClass, setAddingClass] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [positionStore] = useState(() => createCanvasPositionStore(props.positionStorageKey!));
  const positions = useRef(positionStore.positions);
  const [positionError, setPositionError] = useState(false);
  const latest = useRef(props); latest.current = props;
  const layoutGeneration = useRef(0);
  const laidOut = useRef("");
  const handleRef = useRef<GraphExportHandle | null>(null);
  const classes = useMemo(() => (props.umlState?.classes ?? []).filter(c => props.showBaseSections || !props.baseNamespaces?.length || props.pinnedClassIds?.includes(c.id) || props.baseNamespaces.some(ns => (c.module || c.id) === ns || (c.module || c.id).startsWith(`${ns}.`))), [props.umlState, props.showBaseSections, props.baseNamespaces, props.pinnedClassIds]);
  const edges = useMemo(() => {
    const ids = new Set(classes.map(c => c.id));
    return canvasEdges((props.umlState?.edges ?? []).filter(e => ids.has(e.source) && ids.has(e.target))).filter(e => props.showInheritance !== false || e.type !== "inherits").map((e, i) => ({
      id: `${e.source}|${e.target}|${e.type}|${i}`, source: e.source, target: e.target, type: "smoothstep", label: e.type === "inherits" ? "inherits" : e.card || "subsection",
      markerEnd: { type: e.type === "inherits" ? MarkerType.Arrow : MarkerType.ArrowClosed, color: "#8793b4" }, style: { stroke: "#8793b4", strokeWidth: 1.5, strokeDasharray: e.type === "inherits" ? "5 5" : undefined },
    }));
  }, [classes, props.umlState, props.showInheritance]);

  useEffect(() => {
    setNodes(previous => {
      const visible = new Set(classes.map(c => c.id));
      const boxes = new Map<string, PlacedBox>();
      previous.filter(n => visible.has(n.id)).forEach(n => {
        const w = n.measured?.width ?? 290;
        const h = n.measured?.height ?? 145 + n.data.cls.quantities.length * 34;
        boxes.set(n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2, w, h });
      });
      // Include saved boxes in collision checks before placing newly visible classes.
      classes.forEach(cls => {
        const at = positions.current.get(cls.id);
        if (!at || boxes.has(cls.id)) return;
        const w = 290;
        const h = props.compact ? 135 : (touchEditing() ? 210 + cls.quantities.length * 44 : 145 + cls.quantities.length * 34);
        boxes.set(cls.id, { x: at.x + w / 2, y: at.y + h / 2, w, h });
      });
      const added = classes.filter(c => !boxes.has(c.id) && !positions.current.has(c.id)).map(c => ({ id: c.id, w: 290, h: props.compact ? 135 : (touchEditing() ? 210 + c.quantities.length * 44 : 145 + c.quantities.length * 34) }));
      const placed = placeNewNodes(boxes, added, props.umlState?.edges ?? [], new Map(), props.layoutDirection);
      return classes.map((cls, i) => {
        const existing = previous.find(n => n.id === cls.id);
        const at = placed.get(cls.id);
        const size = added.find(n => n.id === cls.id);
        const position = existing?.position ?? positions.current.get(cls.id) ?? (at && size ? { x: at.x - size.w / 2, y: at.y - size.h / 2 } : { x: (i % 4) * 350, y: Math.floor(i / 4) * 380 });
        return { ...existing, id: cls.id, type: "schemaClass", data: { cls }, selected: props.selectedClassId === cls.id, position };
      });
    });
  }, [classes, props.selectedClassId, props.umlState, props.compact, props.layoutDirection]);

  useEffect(() => {
    const handle: GraphExportHandle = {
      refit: () => { void flow.fitView({ padding: 0.25, duration: 250 }); },
      focusNode: (name, options) => {
        const node = flow.getNodes().find(n => n.id.toLowerCase() === name.toLowerCase() || n.data.cls.name.toLowerCase() === name.toLowerCase());
        if (!node) return false;
        selectClass(node.data.cls, latest.current);
        if (options?.moveViewport !== false) void flow.fitView({ nodes: [node], maxZoom: 1, padding: 0.6, duration: 250 });
        return true;
      },
      toPng: async () => {
        const viewport = container.current?.querySelector<HTMLElement>(".react-flow__viewport");
        if (!viewport) return null;
        const bounds = flow.getNodesBounds(flow.getNodes());
        return toPng(viewport, { backgroundColor: getComputedStyle(container.current!).getPropertyValue("--graph-bg").trim(), width: bounds.width + 80, height: bounds.height + 80, style: { transform: `translate(${-bounds.x + 40}px, ${-bounds.y + 40}px)` }, filter: element => !(element instanceof Element && element.classList.contains("react-flow__handle")) });
      },
    };
    handleRef.current = handle; props.onReady?.(handle);
    return () => { props.onReady?.(null); handleRef.current = null; };
  }, [flow, props.onReady]);

  // Layout only on document/direction changes or an explicit request. Saves keep positions.
  useEffect(() => {
    const key = `${props.layoutKey}|${props.layoutDirection}|${layoutVersion}`;
    if (!classes.length || !nodesInitialized || laidOut.current === key) return;
    const run = ++layoutGeneration.current;
    const startingPositions = new Map(flow.getNodes().map(n => [n.id, { ...n.position }]));
    let cancelled = false;
    if (layoutVersion === 0 && classes.some(cls => positionStore.restoredIds.has(cls.id))) {
      laidOut.current = key;
      requestAnimationFrame(() => {
        if (cancelled) return;
        void flow.fitView({ padding: 0.25 });
        if (handleRef.current) latest.current.onLayoutReady?.(handleRef.current);
      });
      return () => { cancelled = true; };
    }
    const elk = new ELK();
    void elk.layout({ id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": props.layoutDirection ?? "UP", "elk.spacing.nodeNode": "70", "elk.layered.spacing.nodeNodeBetweenLayers": "100" }, children: classes.map(c => ({ id: c.id, width: 290, height: flow.getNode(c.id)?.measured?.height ?? (props.compact ? 135 : (touchEditing() ? 210 + c.quantities.length * 44 : 145 + c.quantities.length * 34)) })), edges: edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })) }).then(result => {
      if (cancelled || run !== layoutGeneration.current) return;
      laidOut.current = key;
      const targets = new Map(result.children?.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
      setNodes(current => current.map(n => {
        const before = startingPositions.get(n.id);
        if (n.dragging || (before && (n.position.x !== before.x || n.position.y !== before.y))) return n;
        const position = targets.get(n.id) ?? n.position; positions.current.set(n.id, position); return { ...n, position };
      }));
      requestAnimationFrame(() => { if (!cancelled) { void flow.fitView({ padding: 0.25 }); if (handleRef.current) latest.current.onLayoutReady?.(handleRef.current); } });
      setLayoutError("");
    }).catch(() => { if (!cancelled) setLayoutError("Auto-layout failed. You can still drag cards or retry Arrange."); });
    return () => { cancelled = true; };
  }, [classes, edges, props.layoutKey, props.layoutDirection, props.compact, layoutVersion, flow, nodesInitialized, positionStore]);

  // Save final layouts and keyboard moves, retaining hidden/collapsed nodes for later.
  // Drag-stop below also flushes immediately, before a navigation or reload can unmount us.
  useEffect(() => {
    if (!nodesInitialized || !laidOut.current || nodes.some(node => node.dragging)) return;
    nodes.forEach(node => positions.current.set(node.id, { ...node.position }));
    setPositionError(!positionStore.save());
  }, [nodes, nodesInitialized, positionStore]);

  const context = { ...props, onRenameClass: async (id: string, name: string) => {
    const position = flow.getNode(id)?.position;
    const newId = await props.onRenameClass(id, name);
    if (position) {
      // Retain the old ID too, so undoing a rename restores its position.
      positions.current.set(newId, { ...position });
      setPositionError(!positionStore.save());
    }
    return newId;
  } };
  return <EditorContext.Provider value={context}><div ref={container} className="flow-editor">
    <ReactFlow<CardNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(previous => {
      const updated = applyNodeChanges(changes, previous); updated.forEach(n => positions.current.set(n.id, n.position)); return updated;
    })} onNodeDragStop={(_, node, moved) => {
      [...moved, node].forEach(n => positions.current.set(n.id, { ...n.position }));
      setPositionError(!positionStore.save());
    }} onNodeClick={(_, node) => selectClass(node.data.cls, props)} onPaneClick={() => { props.onClearSelection?.(); useSelection.getState().setSelected(null); }} nodesConnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={0.05} maxZoom={2} colorMode={props.theme ?? "light"} fitView>
      {positionError && <Panel position="bottom-center" className="flow-position-error" role="status">Could not save box positions in this browser.</Panel>}
      <Background gap={24} size={1} /><Controls showInteractive={false} position="bottom-left" />
      <Panel position="top-right" className="flow-actions"><span className="flow-badge">New editor</span><button onClick={() => setLayoutVersion(v => v + 1)}>Arrange</button>{props.editableMode && <button className="flow-primary" onClick={() => setAddingClass(v => !v)}>+ Add class</button>}{addingClass && props.editableMode && (props.mobile ? <MobileEditSheet title="Add class" onClose={() => setAddingClass(false)}><NewClassForm props={props} onClose={() => setAddingClass(false)} /></MobileEditSheet> : <NewClassForm props={props} onClose={() => setAddingClass(false)} />)}</Panel>
      <Panel position="bottom-center" className="flow-hint">{layoutError || (props.editableMode ? (touchEditing() ? "Tap to edit · Drag to move · Pinch to zoom" : "Double-click to edit · Drag to move · Scroll to zoom") : "Select a class to explore · Switch to Edit to make changes")}</Panel>
    </ReactFlow>
  </div></EditorContext.Provider>;
}
export default function FlowGraphView(props: FlowGraphProps) {
  const key = props.positionStorageKey ?? canvasPositionKey(props.editRules?.name ?? "default", props.umlState?.package ?? "", props.layoutDirection ?? "UP");
  return <ReactFlowProvider key={key}><FlowCanvas {...props} positionStorageKey={key} /></ReactFlowProvider>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import elk from "elkjs/lib/elk.bundled.js";
import cytoscapeElk from "cytoscape-elk";
import type { Core, NodeSingular } from "cytoscape";
import { useSelection, type QtyMeta, type QtySnapshot } from "./store/selection";
import { NOMAD_EDIT_RULES, VOCAB_TERM, type EditRules, type QuantityFormData } from "./components/quantityShared";
import type { ApiEdge, ApiNode } from "./types/api";
import type { QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";
import { fqidFromParts } from "./utils/identifier";
import { canvasEdges } from "./utils/canvasEdges";
import { placeNewNodes, type PlacedBox, type Point } from "./utils/canvasPlacement";
import { DEFAULT_LAYOUT_DIRECTION, type LayoutDirection } from "./utils/layoutDirection";

type QtyDiffState = "added" | "removed" | "changed" | undefined;

// Lower value makes mouse-wheel zoom less aggressive.
const CANVAS_WHEEL_SENSITIVITY = 0.35;

cytoscapeElk(cytoscape, elk);

type RawNode = ApiNode;
type RawEdge = ApiEdge;

export type GraphExportHandle = {
  toPng: () => string | null;
  // Selects a class; moveViewport: false leaves pan and zoom as they are.
  focusNode: (name: string, options?: { moveViewport?: boolean }) => boolean;
  refit: () => void;
};

type DiffNodes = { added: ApiNode[]; removed: ApiNode[]; changed: { id: string }[] };
type DiffEdges = { added: ApiEdge[]; removed: ApiEdge[] };
type CardBox = { x: number; y: number; w: number; h: number };

type Props = {
  nodes: RawNode[];
  edges: RawEdge[];
  diff?: {
    nodes: DiffNodes;
    edges: DiffEdges;
  } | null;
  onReady?: (handle: GraphExportHandle | null) => void;
  // A new value means a new graph: the canvas lays it out and fits it once. Other
  // changes keep the classes where they are and place only the ones that join.
  layoutKey?: string | number;
  // Called after that layout and fit, but not after a layout for a new layoutDirection.
  onLayoutReady?: (handle: GraphExportHandle) => void;
  showQuantityMetadata?: boolean;
  showInheritance?: boolean;
  theme?: "dark" | "light";
  // A change lays the canvas out again and fits it.
  layoutDirection?: LayoutDirection;
  umlState?: UmlGraphState | null;
  baseNamespaces?: string[];
  showBaseSections?: boolean;
  pinnedClassIds?: string[];
  selectedClassId?: string | null;
  onSelectClass?: (cls: UmlClassNode) => void;
  onCreateQuantity?: (classId: string, data: QuantityFormData) => Promise<void>;
  onCreateClass?: (data: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection"; card?: string }) => Promise<void>;
  creatingQuantityFor?: string | null;
  creatingClass?: boolean;
  onClearSelection?: () => void;
  editableMode?: boolean;
  // What the schema lets the user add (types; bam-masterdata codes).
  editRules?: EditRules;
  // Classes whose subclasses are shown, and the +/- on a card that shows or hides them.
  expandedClassIds?: string[];
  onToggleSubclasses?: (classId: string) => void | Promise<void>;
};

const cleanType = (t?: string | null) => {
  if (!t) return "";
  const m = t.match(/^m_[a-zA-Z0-9_]+\((.+)\)$/);
  if (m) return m[1];
  if (t.startsWith("m_")) return t.replace(/^m_/, "");
  return t;
};

const editableCardWidth = (box: CardBox) => Math.max(box.w + 24, 200);

const sameCardBox = (prev: CardBox | undefined, next: CardBox | undefined) =>
  prev !== undefined && next !== undefined &&
  prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h;

const sameCardBoxMap = (prev: Record<string, CardBox>, next: Record<string, CardBox>) => {
  const ids = Object.keys(prev);
  if (ids.length !== Object.keys(next).length) return false;
  return ids.every((id) => sameCardBox(prev[id], next[id]));
};

const connectionPoints = (source: CardBox, target: CardBox) => {
  const sx = source.x + source.w / 2;
  const sy = source.y + source.h / 2;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  const dx = tx - sx;
  const dy = ty - sy;

  if (dx === 0 && dy === 0) {
    return { x1: sx, y1: sy, x2: tx, y2: ty };
  }

  const sourceScale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : source.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : source.h / 2 / Math.abs(dy)
  );
  const targetScale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : target.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : target.h / 2 / Math.abs(dy)
  );

  return {
    x1: sx + dx * sourceScale,
    y1: sy + dy * sourceScale,
    x2: tx - dx * targetScale,
    y2: ty - dy * targetScale,
  };
};

type Palette = { composition: string; compositionLabelBg: string; inheritance: string };

const stylesheet = (palette: Palette) => [
  {
    selector: "node[kind='uml_class']",
    style: {
      shape: "round-rectangle",
      "background-color": "#f5f7fa",
      "border-color": "#0f172a",
      "border-width": 1.5,
      color: "#0f172a",
      label: "data(label)",
      "text-wrap": "wrap",
      "text-max-width": "280px",
      "font-size": 12,
      "font-family": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      padding: "8px",
      "text-halign": "center",
      "text-valign": "center",
      width: "label",
      height: "label",
      "shadow-blur": 12,
      "shadow-color": "#94a3b8",
      "shadow-offset-x": 2,
      "shadow-offset-y": 4
    } as Record<string, string | number>
  },
  {
    selector: "edge[relationship='composition']",
    style: {
      "line-color": palette.composition,
      width: 2,
      "curve-style": "segments",
      "source-arrow-shape": "diamond",
      "source-arrow-color": palette.composition,
      "target-arrow-shape": "triangle",
      "target-arrow-color": palette.composition,
      "arrow-scale": 1.1,
      label: "data(card)",
      "font-size": 10,
      "text-rotation": "autorotate",
      "text-margin-y": -6,
      "text-background-color": palette.compositionLabelBg,
      "text-background-opacity": 1,
      "text-background-padding": "2px",
      color: palette.composition
    } as Record<string, string | number>
  },
  {
    selector: "edge[relationship='inheritance']",
    style: {
      "line-color": palette.inheritance,
      width: 2,
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "target-arrow-color": palette.inheritance,
      "arrow-scale": 1.1,
      "target-arrow-fill": "hollow",
      "line-style": "dashed",
      "line-dash-pattern": [10, 8]
    }
  },
  { selector: ".hidden", style: { display: "none" } },
  { selector: ":selected", style: { "border-width": 3, "border-color": "#2563eb" } },
  { selector: ".diff-added",   style: { "border-color": "#16a34a", "border-width": 4 } },
  { selector: ".diff-removed", style: { "border-color": "#dc2626", "border-width": 4 } },
  { selector: ".diff-changed", style: { "border-color": "#ca8a04", "border-width": 4 } },
  { selector: "edge.diff-added",   style: { "line-color": "#16a34a", "target-arrow-color": "#16a34a", "source-arrow-color": "#16a34a", width: 3 } },
  { selector: "edge.diff-removed", style: { "line-color": "#dc2626", "target-arrow-color": "#dc2626", "source-arrow-color": "#dc2626", width: 3, "line-style": "dashed" } }
] as unknown as cytoscape.StylesheetJson;

const fullLayout = (direction: LayoutDirection) => ({
  name: "elk",
  nodeDimensionsIncludeLabels: true,
  elk: {
    algorithm: "layered",
    "elk.direction": direction,
    "elk.layered.spacing.nodeNodeBetweenLayers": 90,
    "elk.spacing.nodeNode": 26,
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.mergeEdges": true,
    "elk.edgeRouting": "ORTHOGONAL"
  }
}) as unknown as cytoscape.LayoutOptions;

const FIT_PADDING = 32;
const NOT_LAID_OUT = Symbol("not laid out");
// A fit never zooms in further than this, so a canvas with a class or two stays readable.
const FIT_MAX_ZOOM = 1.2;

const fitView = (cy: Core) => {
  cy.resize();
  cy.fit(undefined, FIT_PADDING);
  if (cy.zoom() > FIT_MAX_ZOOM) {
    cy.zoom(FIT_MAX_ZOOM);
    cy.center();
  }
};

type CanvasNodeData = {
  id: string;
  label: string;
  rawName: string;
  kind: "uml_class";
  module: string;
  doc: string;
  path: string;
  line?: number;
};
type CanvasEdgeData = { id: string; source: string; target: string; type: string; relationship: string; card: string };

const sameData = (current: Record<string, unknown>, next: Record<string, unknown>) =>
  Object.keys(next).every((key) => current[key] === next[key]);

// Edge ids name the link itself, so an edge keeps its id when other edges come or go.
// The same link drawn twice (two subsections of one class) is told apart by a counter.
const keyEdges = (edges: RawEdge[]) => {
  const seen = new Map<string, number>();
  return edges.map((edge) => {
    const base = `${edge.type}:${edge.source}->${edge.target}${edge.card ? `[${edge.card}]` : ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { id: count ? `${base}#${count}` : base, edge };
  });
};

const nodeBox = (node: NodeSingular): CardBox => {
  const box = node.boundingBox({ includeLabels: true });
  return { x: box.x1, y: box.y1, w: box.w, h: box.h };
};

// The space a class takes, as the wider of its canvas node and its Edit mode card.
const placedBox = (node: NodeSingular): PlacedBox => {
  const box = nodeBox(node);
  const { x, y } = node.position();
  return { x, y, w: editableCardWidth(box), h: box.h };
};

function umlLabel(
  name: string,
  attrs: { name: string; dtype?: string; shape?: string | null; card?: string | null; diff?: QtyDiffState }[],
  showMetadata: boolean
) {
  const attrLines = attrs.map(a => {
    const parts = [] as string[];
    if (a.diff === "added") parts.push("🟢 ");
    if (a.diff === "removed") parts.push("🔴 ");
    if (a.diff === "changed") parts.push("🟠 ");

    parts.push(a.name);
    const dt = showMetadata ? cleanType(a.dtype) : "";
    if (dt) parts.push(`: ${dt}`);
    if (showMetadata && a.shape && a.shape !== "[]") parts.push(` ${a.shape}`);
    return parts.join("");
  });
  return [name, "────────────", ...attrLines].join("\n");
}

export default function GraphView({
  nodes,
  edges,
  diff,
  onReady,
  layoutKey,
  onLayoutReady,
  showQuantityMetadata = true,
  showInheritance = true,
  theme = "dark",
  layoutDirection = DEFAULT_LAYOUT_DIRECTION,
  umlState,
  baseNamespaces = [],
  showBaseSections = false,
  pinnedClassIds = [],
  selectedClassId,
  onSelectClass,
  onCreateQuantity,
  onCreateClass,
  creatingQuantityFor,
  creatingClass,
  onClearSelection,
  editableMode = false,
  editRules = NOMAD_EDIT_RULES,
  expandedClassIds,
  onToggleSubclasses,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [cardBoxes, setCardBoxes] = useState<Record<string, CardBox>>({});
  const [viewport, setViewport] = useState<{ pan: { x: number; y: number }; zoom: number }>({
    pan: { x: 0, y: 0 },
    zoom: 1,
  });
  const [activeQuantityTarget, setActiveQuantityTarget] = useState<string | null>(null);
  const [togglingClassId, setTogglingClassId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; nodeX: number; nodeY: number } | null>(null);
  const emptyQuantityDraft = useMemo<Required<QuantityFormData>>(
    () => ({ quantityName: "", dtype: editRules.dtypes[0]?.name ?? "", docstring: "", code: "", label: "", range: "", mandatory: false }),
    [editRules]
  );
  const [quantityDraft, setQuantityDraft] = useState<Required<QuantityFormData>>(emptyQuantityDraft);
  const [showClassForm, setShowClassForm] = useState<boolean>(false);
  const [classDraft, setClassDraft] = useState<{ name: string; parentId: string; docstring: string; relation: "inherits" | "hasSubSection"; card: string }>({
    name: "",
    parentId: "",
    docstring: "",
    relation: "inherits",
    card: "",
  });
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [classError, setClassError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const setSelected = useMemo(() => useSelection.getState().setSelected, []);

  const palette = useMemo(() => {
    const isDark = theme === "dark";
    return {
      composition: isDark ? "#cbd5f5" : "#475569",
      compositionLabelBg: isDark ? "rgba(15, 23, 42, 0.72)" : "#f5f7fa",
      inheritance: isDark ? "#e2e8f0" : "#0f172a",
    };
  }, [theme]);

  const namespaceFilters = useMemo(
    () => baseNamespaces.map((ns) => ns.trim()).filter(Boolean),
    [baseNamespaces]
  );
  const pinnedClassIdSet = useMemo(() => new Set(pinnedClassIds), [pinnedClassIds]);
  const allClassCards = useMemo(() => umlState?.classes ?? [], [umlState]);
  const classCards = useMemo(() => {
    if (!allClassCards.length) return [];
    if (showBaseSections || !namespaceFilters.length) return allClassCards;

    return allClassCards.filter((cls) => {
      if (pinnedClassIdSet.has(cls.id)) return true;
      const moduleName = cls.module || cls.id;
      return namespaceFilters.some((ns) => moduleName === ns || moduleName.startsWith(`${ns}.`));
    });
  }, [allClassCards, namespaceFilters, pinnedClassIdSet, showBaseSections]);
  const visibleClassIds = useMemo(() => new Set(classCards.map((cls) => cls.id)), [classCards]);
  const editingEnabled = useMemo(() => Boolean(onCreateQuantity && onCreateClass && umlState), [onCreateClass, onCreateQuantity, umlState]);
  const showEditingUi = editingEnabled && editableMode;

  const toQtyMeta = useCallback(
    (q: QuantityNode): QtyMeta => ({
      id: q.id,
      name: q.name,
      dtype: q.dtype,
      shape: q.shape ?? undefined,
      card: q.card ?? undefined,
      doc: q.doc ?? undefined,
      path: q.path ?? undefined,
      line: typeof q.line === "number" ? q.line : undefined,
      owner: q.ownerId,
      inherited: q.inherited ?? false,
      inheritedFromId: q.inheritedFromId ?? null,
      inheritedFromName: q.inheritedFromName ?? null,
      sourceId: q.sourceId ?? null,
      details: q.details ?? null,
    }),
    []
  );

  const publishClassSelection = useCallback(
    (cls: UmlClassNode) => {
      const payloadQuantities = cls.quantities.map(toQtyMeta);
      onSelectClass?.(cls);
      setSelected({
        id: cls.id,
        fqid: fqidFromParts(cls.module, cls.name, cls.id),
        kind: "class",
        name: cls.name,
        doc: cls.doc || "",
        path: cls.path || undefined,
        line: typeof cls.line === "number" ? cls.line : undefined,
        quantities: payloadQuantities,
        details: cls.details ?? null,
      });
      setActiveQuantityTarget(null);
    },
    [onSelectClass, setSelected, toQtyMeta]
  );


  const handleSelectClass = useCallback(
    (classId: string) => {
      const cls = classCards.find((c) => c.id === classId);
      if (!cls) return;
      publishClassSelection(cls);
    },
    [classCards, publishClassSelection]
  );


  const openQuantityFormFor = useCallback(
    (classId: string) => {
      setActiveQuantityTarget(classId);
      setInlineError(null);
      setQuantityDraft(emptyQuantityDraft);
    if (classId !== selectedClassId) {
      handleSelectClass(classId);
    }
    },
    [emptyQuantityDraft, handleSelectClass, selectedClassId]
  );

  const handleQuantitySubmit = useCallback(
    async (cls: UmlClassNode) => {
      if (!onCreateQuantity) return;
      const trimmed = quantityDraft.quantityName.trim();
      if (editRules.codes ? !quantityDraft.code.trim() : !trimmed) {
        setInlineError(editRules.codes ? "Code is required" : "Quantity name is required");
        return;
      }
      try {
        await onCreateQuantity(cls.id, {
          ...quantityDraft,
          quantityName: trimmed,
          code: quantityDraft.code.trim(),
          docstring: quantityDraft.docstring.trim(),
        });
        setInlineError(null);
        setActiveQuantityTarget(null);
        setQuantityDraft(emptyQuantityDraft);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to add quantity";
        setInlineError(message);
      }
    },
    [editRules, emptyQuantityDraft, onCreateQuantity, quantityDraft]
  );

  const handleClassSubmit = useCallback(async () => {
    if (!onCreateClass) return;
    const trimmed = classDraft.name.trim();
    if (!trimmed) {
      setClassError("Class name is required");
      return;
    }
    try {
      await onCreateClass({
        name: trimmed,
        parentId: classDraft.parentId || null,
        docstring: classDraft.docstring.trim() || undefined,
        relation: classDraft.relation,
        card: classDraft.relation === "hasSubSection" ? classDraft.card.trim() || undefined : undefined,
      });
      setClassError(null);
      setShowClassForm(false);
      setClassDraft({ name: "", parentId: "", docstring: "", relation: "inherits", card: "" });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to add class";
      setClassError(message);
    }
  }, [classDraft, onCreateClass]);

  const quantityDiffs = useMemo(() => {
    const map = new Map<
      string,
      { state: "added" | "removed" | "changed"; before?: RawNode; after?: RawNode }
    >();

    if (!diff) return map;

    diff.nodes?.added?.forEach((n) => {
      if (n?.kind === "quantity" && n.id) {
        map.set(n.id, { state: "added", after: n });
      }
    });

    diff.nodes?.removed?.forEach((n) => {
      if (n?.kind === "quantity" && n.id) {
        map.set(n.id, { state: "removed", before: n });
      }
    });

    diff.nodes?.changed?.forEach((entry) => {
      const before = (entry as { before?: RawNode | null }).before ?? undefined;
      const after = (entry as { after?: RawNode | null }).after ?? undefined;
      const id = entry?.id;
      const isQuantity = before?.kind === "quantity" || after?.kind === "quantity";
      if (isQuantity && id) {
        map.set(id, { state: "changed", before, after });
      }
    });

    return map;
  }, [diff]);

  const graphNodes = useMemo(() => {
    const base = [...nodes];
    if (diff?.nodes?.removed?.length) {
      diff.nodes.removed.forEach((n) => {
        if (!n?.id || (n?.kind !== "section" && n?.kind !== "quantity")) return;
        base.push(n as RawNode);
      });
    }
    return base;
  }, [nodes, diff]);

  const resolvedEdges = useMemo<RawEdge[]>(() => {
    if (umlState?.edges?.length) {
      return umlState.edges
        .filter((e) => {
          if (e.type === "hasQuantity") {
            return visibleClassIds.has(e.source);
          }
          return visibleClassIds.has(e.source) && visibleClassIds.has(e.target);
        })
        .filter((e) => e.type === "hasSubSection" || e.type === "inherits" || e.type === "hasQuantity")
        .map((e) => ({
          source: e.source,
          target: e.target,
          type: e.type as RawEdge["type"],
          card: e.card ?? undefined,
        }));
    }
    return edges;
  }, [edges, umlState, visibleClassIds]);

  // Build:
  // - sectionsMap: id -> section node
  // - attrsMap: section id -> display lines for UML
  // - quantitiesByOwner: section id -> QtyMeta[]  (for DocPanel)
  const { sectionsMap, attrsMap, umlEdges, quantitiesByOwner } = useMemo(() => {
    const sections = new Map<string, RawNode>();
    const attrs = new Map<
      string,
      { name: string; dtype?: string; shape?: string | null; card?: string | null; diff?: QtyDiffState }[]
    >();
    const qByOwner = new Map<string, QtyMeta[]>();

    const buildSnapshot = (n?: RawNode | null): QtySnapshot | undefined => {
      if (!n) return undefined;
      return {
        name: n.label,
        dtype: n.dtype ?? n.data_type ?? n.type ?? undefined,
        shape: n.shape ?? undefined,
        card: n.card ?? undefined,
        doc: n.doc ?? undefined,
      };
    };

    for (const n of graphNodes) {
      if (n.kind === "section") {
        sections.set(n.id, n);
        attrs.set(n.id, attrs.get(n.id) ?? []);
        qByOwner.set(n.id, qByOwner.get(n.id) ?? []);
      }
    }

    for (const q of graphNodes) {
      if (q.kind !== "quantity" || !q.owner) continue;

      const diffInfo = quantityDiffs.get(q.id);

      // For UML card display
      const list = attrs.get(q.owner) ?? [];
      list.push({
        name: q.label,
        dtype: q.dtype ?? q.data_type ?? q.type ?? undefined,
        shape: q.shape ?? undefined,
        card: q.card ?? undefined,
        diff: diffInfo?.state,
      });
      attrs.set(q.owner, list);

      // For panel
      const metaList = qByOwner.get(q.owner) ?? [];
      metaList.push({
        id: q.id,
        name: q.label,
        dtype: q.dtype ?? q.data_type ?? q.type ?? undefined,
        shape: q.shape ?? undefined,
        card: q.card ?? undefined,
        doc: q.doc ?? undefined,
        path: q.path ?? undefined,
        line: typeof q.line === "number" ? q.line : undefined,
        owner: q.owner,
        details: q.details ?? null,
        diff: diffInfo
          ? {
              state: diffInfo.state,
              before: buildSnapshot(diffInfo.before),
              after: buildSnapshot(diffInfo.after),
            }
          : undefined,
      });
      qByOwner.set(q.owner, metaList);
    }

    if (umlState) {
      const sourceSections = new Map(sections);
      sections.clear();
      attrs.clear();
      qByOwner.clear();
      classCards.forEach((cls) => {
        const source = sourceSections.get(cls.id);
        sections.set(
          cls.id,
          ({
            id: cls.id,
            kind: "section",
            label: cls.name,
            module: cls.module ?? source?.module ?? undefined,
            doc: cls.doc ?? source?.doc ?? undefined,
            path: cls.path ?? source?.path ?? undefined,
            line: typeof cls.line === "number" ? cls.line : source?.line,
            details: cls.details ?? source?.details ?? null,
          } as RawNode)
        );

        // Cards show only the quantities a class declares; inherited ones stay in the docs panel.
        attrs.set(
          cls.id,
          cls.quantities.filter((q) => !q.inherited).map((q) => ({
            name: q.name,
            dtype: q.dtype,
            shape: q.shape ?? undefined,
            card: q.card ?? undefined,
            diff: undefined,
          }))
        );
        qByOwner.set(
          cls.id,
          cls.quantities.map((q) => toQtyMeta(q))
        );
      });
    }

    // Also surface removed quantities so they appear in the DocPanel list
    for (const [qid, diffInfo] of quantityDiffs.entries()) {
      if (diffInfo.state !== "removed") continue;
      const owner = diffInfo.before?.owner;
      if (!owner || !sections.has(owner)) continue;

      const metaList = qByOwner.get(owner) ?? [];
      metaList.push({
        id: qid,
        name: diffInfo.before?.label || qid.split(".").pop() || qid,
        dtype:
          diffInfo.before?.dtype ?? diffInfo.before?.data_type ?? diffInfo.before?.type ?? undefined,
        shape: diffInfo.before?.shape ?? undefined,
        card: diffInfo.before?.card ?? undefined,
        doc: diffInfo.before?.doc ?? undefined,
        owner,
        diff: {
          state: "removed",
          before: buildSnapshot(diffInfo.before),
        },
      });
      qByOwner.set(owner, metaList);
    }

    const baseEdges = canvasEdges(resolvedEdges);
    if (diff?.edges?.removed?.length) {
      const removedEdges: RawEdge[] = [];
      diff.edges.removed.forEach((e) => {
        if (!e?.source || !e?.target) return;
        const type = (e.type as RawEdge["type"]) ?? "hasSubSection";
        removedEdges.push({
          source: e.source,
          target: e.target,
          type,
          card: e.card ?? undefined
        });
      });
      // Removed edges are thinned out against the graph as it was before the change.
      const edgeKey = (e: RawEdge) => `${e.source}|${e.target}|${e.type}`;
      const added = new Set((diff.edges.added ?? []).map(edgeKey));
      const before = [...resolvedEdges.filter((e) => !added.has(edgeKey(e))), ...removedEdges];
      const keptBefore = new Set(canvasEdges(before).map(edgeKey));
      baseEdges.push(...removedEdges.filter((e) => keptBefore.has(edgeKey(e))));
    }

    const umlEdges = baseEdges.filter((e) => {
      if (e.type === "hasSubSection") return true;
      if (e.type === "inherits") return showInheritance;
      return false;
    });

    return { sectionsMap: sections, attrsMap: attrs, umlEdges, quantitiesByOwner: qByOwner };
  }, [graphNodes, resolvedEdges, quantityDiffs, diff, showInheritance, classCards, toQtyMeta, umlState]);

  const keyedEdges = useMemo(() => keyEdges(umlEdges), [umlEdges]);

  // What the canvas should hold; the reconcile effect below brings Cytoscape to it.
  const canvasElements = useMemo(() => {
    const nodes: CanvasNodeData[] = [];
    for (const [secId, sec] of sectionsMap.entries()) {
      nodes.push({
        id: secId,
        label: umlLabel(sec.label, attrsMap.get(secId) ?? [], showQuantityMetadata),
        rawName: sec.label,
        kind: "uml_class",
        module: sec.module ?? "",
        doc: sec.doc ?? "",
        path: sec.path ?? "",
        line: typeof sec.line === "number" ? sec.line : undefined
      });
    }
    const edges: CanvasEdgeData[] = keyedEdges
      .filter(({ edge }) => sectionsMap.has(edge.source) && sectionsMap.has(edge.target))
      .map(({ id, edge }) => ({
        id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        relationship: edge.type === "inherits" ? "inheritance" : "composition",
        card: edge.card ?? ""
      }));
    return { nodes, edges };
  }, [sectionsMap, attrsMap, keyedEdges, showQuantityMetadata]);

  // The canvas lives as long as this component; its handlers read the latest props through this ref.
  const latestRef = useRef({ onReady, onLayoutReady, publishClassSelection, quantitiesByOwner, sectionsMap });
  useEffect(() => {
    latestRef.current = { onReady, onLayoutReady, publishClassSelection, quantitiesByOwner, sectionsMap };
  });
  const handleRef = useRef<GraphExportHandle | null>(null);
  const layoutRef = useRef<cytoscape.Layouts | null>(null);
  // Bumped by every full layout; a layout that finishes after a newer one started is ignored.
  const layoutRunRef = useRef(0);
  // Whether the running full layout calls onLayoutReady when it ends; a layout that
  // replaces it before then takes this over.
  const layoutNotifiesRef = useRef(false);
  // Bumped whenever the view must stay put, which cancels a fit still waiting to happen.
  const fitTicketRef = useRef(0);
  const laidOutKeyRef = useRef<unknown>(NOT_LAID_OUT);
  const laidOutDirectionRef = useRef<LayoutDirection | null>(null);
  // Where classes were when they left the canvas, so they come back to the same spot.
  const leftAtRef = useRef(new Map<string, Point>());

  // Full geometry synchronization: measure every node's model-space bounding
  // box and rebuild the card-box map. Only needed when the graph geometry
  // actually changes (layout, classes added or relabelled), never on pan or zoom.
  const syncAllCardBoxes = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const boxes: Record<string, CardBox> = {};
    cy.nodes().forEach((n) => {
      boxes[n.id()] = nodeBox(n);
    });
    setCardBoxes((prev) => (sameCardBoxMap(prev, boxes) ? prev : boxes));
  }, []);

  // Creates the canvas once. Data, style and size changes update it in place.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cy = cytoscape({
      container,
      elements: [],
      minZoom: 0.2,
      maxZoom: 3.5,
      wheelSensitivity: CANVAS_WHEEL_SENSITIVITY,
    });
    cyRef.current = cy;
    laidOutKeyRef.current = NOT_LAID_OUT;
    leftAtRef.current = new Map();

    const focusNode = (name: string, options: { moveViewport?: boolean } = {}) => {
      const normalized = name.toLowerCase();
      const target = cy
        .nodes()
        .filter((n) => {
          const id = `${n.id()}`.toLowerCase();
          const raw = `${n.data("rawName") ?? ""}`.toLowerCase();
          const label = `${n.data("label") ?? ""}`.toLowerCase();
          return id === normalized || raw === normalized || label === normalized;
        })
        .first();

      if (!target || target.empty()) return false;

      const d = target.data();
      const { quantitiesByOwner, sectionsMap, publishClassSelection } = latestRef.current;
      const qList = quantitiesByOwner.get(d.id) || [];

      const quantities: QuantityNode[] = qList.map((q) => ({
        id: q.id,
        name: q.name,
        dtype: q.dtype,
        shape: q.shape ?? null,
        card: q.card ?? null,
        doc: q.doc ?? null,
        path: q.path ?? null,
        line: typeof q.line === "number" ? q.line : null,
        ownerId: q.owner,
        inherited: q.inherited ?? false,
        inheritedFromId: q.inheritedFromId ?? null,
        inheritedFromName: q.inheritedFromName ?? null,
        sourceId: q.sourceId ?? null,
        details: q.details ?? null,
      }));

      publishClassSelection({
        id: d.id,
        name: d.rawName || d.id,
        doc: d.doc || "",
        module: d.module || "",
        path: d.path || "",
        line: typeof d.line === "number" ? d.line : null,
        quantities,
        details: sectionsMap.get(d.id)?.details ?? null,
      });

      if (options.moveViewport !== false) {
        cy.animate(
          {
            center: { eles: target },
            zoom: Math.min(1.2, cy.maxZoom()),
          },
          { duration: 240, easing: "ease-in-out" }
        );
      }

      cy.$(":selected").unselect();
      target.select();
      return true;
    };

    // Selection → DocPanel + UnderTheHoodPanel
    cy.on("tap", "node", (evt) => {
      focusNode(evt.target.data("rawName") || evt.target.id());
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) useSelection.getState().setSelected(null);
    });

    let viewportRaf: number | null = null;

    // Viewport synchronization: the overlay wrapper is translated/scaled to
    // follow Cytoscape pan/zoom. Node model positions and model-space bounding
    // boxes do not change when the user pans or zooms, so this path stays cheap
    // and must never re-measure node geometry.
    const applyViewport = () => {
      const pan = cy.pan();
      const zoom = cy.zoom();
      setViewport((prev) =>
        prev.pan.x === pan.x && prev.pan.y === pan.y && prev.zoom === zoom
          ? prev
          : { pan: { x: pan.x, y: pan.y }, zoom }
      );
    };

    // A single interaction (wheel input, cy.animate()) can emit several
    // pan/zoom events per frame; coalesce them into one state update.
    const scheduleViewportSync = () => {
      if (viewportRaf !== null) return;
      viewportRaf = requestAnimationFrame(() => {
        viewportRaf = null;
        applyViewport();
      });
    };

    applyViewport();
    cy.on("pan zoom", scheduleViewportSync);
    cy.on("layoutstop", syncAllCardBoxes);

    // A class dragged on the canvas itself: its +/- follows it.
    cy.on("drag", "node", (evt) => {
      const node = evt.target as NodeSingular;
      const next = nodeBox(node);
      setCardBoxes((prev) => (sameCardBox(prev[node.id()], next) ? prev : { ...prev, [node.id()]: next }));
    });

    // A resized panel changes the canvas size only; pan and zoom stay.
    const resizeObserver = new ResizeObserver(() => cy.resize());
    resizeObserver.observe(container);

    const handle: GraphExportHandle = {
      toPng: () =>
        cy.png({
          full: true,
          scale: 2,
          bg: "#ffffff"
        }) ?? null,
      focusNode,
      refit: () => {
        fitTicketRef.current += 1;
        fitView(cy);
      },
    };
    handleRef.current = handle;
    latestRef.current.onReady?.(handle);

    return () => {
      resizeObserver.disconnect();
      if (viewportRaf !== null) cancelAnimationFrame(viewportRaf);
      layoutRef.current?.stop();
      layoutRef.current = null;
      handleRef.current = null;
      latestRef.current.onReady?.(null);
      cy.destroy();
      if (cyRef.current === cy) cyRef.current = null;
    };
  }, [syncAllCardBoxes]);

  useEffect(() => {
    cyRef.current?.style(stylesheet(palette));
  }, [palette]);

  // Brings the canvas to canvasElements: classes and edges that left are removed, those
  // that joined are added, the rest stay where they are. Only a new layoutKey or
  // layoutDirection, or a canvas that was empty, gets a full layout and fit.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const newGraph = laidOutKeyRef.current !== layoutKey;
    const newDirection = laidOutDirectionRef.current !== layoutDirection;
    if (newGraph || newDirection) leftAtRef.current = new Map();
    const leftAt = leftAtRef.current;
    const wantedNodes = new Set(canvasElements.nodes.map((n) => n.id));
    const wantedEdges = new Set(canvasElements.edges.map((e) => e.id));
    const hadNodes = cy.nodes().length > 0;
    const added: string[] = [];

    cy.batch(() => {
      cy.edges().forEach((e) => {
        if (!wantedEdges.has(e.id())) e.remove();
      });
      cy.nodes().forEach((n) => {
        if (wantedNodes.has(n.id())) return;
        leftAt.set(n.id(), { ...n.position() });
        n.remove();
      });
      for (const data of canvasElements.nodes) {
        const node = cy.getElementById(data.id);
        if (node.empty()) {
          cy.add({ group: "nodes", data, position: { x: 0, y: 0 } });
          added.push(data.id);
        } else if (!sameData(node.data(), data)) {
          node.data(data);
        }
      }
      for (const data of canvasElements.edges) {
        const edge = cy.getElementById(data.id);
        if (edge.empty()) cy.add({ group: "edges", data });
        else if (!sameData(edge.data(), data)) edge.data(data);
      }
    });

    const diffClasses = "diff-added diff-removed diff-changed";
    cy.nodes().removeClass(diffClasses);
    cy.edges().removeClass(diffClasses);
    if (diff) {
      const addedIds   = new Set(diff.nodes?.added?.map((n) => n.id));
      const removedIds = new Set(diff.nodes?.removed?.map((n) => n.id));
      const changedIds = new Set(diff.nodes?.changed?.map((c) => c.id));

      cy.nodes().forEach((n) => {
        const id = n.id();
        if (addedIds.has(id))   n.addClass("diff-added");
        if (removedIds.has(id)) n.addClass("diff-removed");
        if (changedIds.has(id)) n.addClass("diff-changed");
      });

      const edgeKey = (e: ApiEdge) => `${e.source}|${e.target}|${e.type ?? ""}`;
      const addedE   = new Set(diff.edges?.added?.map(edgeKey));
      const removedE = new Set(diff.edges?.removed?.map(edgeKey));

      cy.edges().forEach(e => {
        const k = `${e.data("source")}|${e.data("target")}|${e.data("type") || ""}`;
        if (addedE.has(k))   e.addClass("diff-added");
        if (removedE.has(k)) e.addClass("diff-removed");
      });
    }

    laidOutKeyRef.current = layoutKey;
    laidOutDirectionRef.current = layoutDirection;
    syncAllCardBoxes();

    // Classes that come while the first layout still runs join that layout rather than
    // being placed beside classes that have not got their place yet.
    const layoutRunning = layoutRef.current !== null;
    if ((newGraph || newDirection || !hadNodes || layoutRunning) && cy.nodes().length > 0) {
      // A new direction for the same graph moves the classes, not the selection.
      const notifies = newGraph || !hadNodes || (layoutRunning && layoutNotifiesRef.current);
      layoutNotifiesRef.current = notifies;
      layoutRef.current?.stop();
      const run = ++layoutRunRef.current;
      const fitTicket = ++fitTicketRef.current;
      // ELK cannot be stopped: a layout that is no longer the latest finishes anyway,
      // so its positions are turned into no-ops here.
      const layout = cy.layout({
        ...fullLayout(layoutDirection),
        transform: (node: NodeSingular, position: Point) => (run === layoutRunRef.current ? position : node.position()),
      } as cytoscape.LayoutOptions);
      layoutRef.current = layout;
      layout.one("layoutstop", () => {
        if (run !== layoutRunRef.current || cyRef.current !== cy) return;
        layoutRef.current = null;
        syncAllCardBoxes();
        // Anything that happened since the layout started (an expansion, an explicit fit) keeps its view.
        if (fitTicket !== fitTicketRef.current) return;
        fitView(cy);
        // The container may still settle in the next frame; fit once more unless something moved on.
        requestAnimationFrame(() => {
          if (fitTicket === fitTicketRef.current && cyRef.current === cy) fitView(cy);
        });
        if (handleRef.current && notifies) latestRef.current.onLayoutReady?.(handleRef.current);
      });
      layout.run();
      return;
    }

    fitTicketRef.current += 1;
    if (added.length) {
      const addedSet = new Set(added);
      const existing = new Map<string, PlacedBox>();
      cy.nodes().forEach((n) => {
        if (!addedSet.has(n.id())) existing.set(n.id(), placedBox(n));
      });
      const joining = added.map((id) => {
        const { w, h } = placedBox(cy.getElementById(id) as NodeSingular);
        return { id, w, h };
      });
      const positions = placeNewNodes(existing, joining, canvasElements.edges, leftAt, layoutDirection);
      cy.batch(() => {
        positions.forEach((position, id) => {
          cy.getElementById(id).position(position);
          leftAt.delete(id);
        });
      });
    }
    syncAllCardBoxes();
  }, [canvasElements, diff, layoutKey, layoutDirection, syncAllCardBoxes]);

  const cardViews = useMemo(
    () =>
      classCards.map((cls) => ({
        cls,
        box: cardBoxes[cls.id],
      })),
    [cardBoxes, classCards]
  );

  const editableEdgeViews = useMemo(() => {
    const displayBoxes = new Map<string, CardBox>();
    cardViews.forEach(({ cls, box }) => {
      if (!box) return;
      displayBoxes.set(cls.id, { ...box, w: editableCardWidth(box) });
    });

    return keyedEdges
      .map(({ id, edge }) => {
        const source = displayBoxes.get(edge.source);
        const target = displayBoxes.get(edge.target);
        if (!source || !target) return null;
        return {
          key: id,
          edge,
          points: connectionPoints(source, target),
        };
      })
      .filter((view): view is {
        key: string;
        edge: RawEdge;
        points: { x1: number; y1: number; x2: number; y2: number };
      } => Boolean(view));
  }, [cardViews, keyedEdges]);

  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const cy = cyRef.current;
      if (!cy) return;
      const node = cy.getElementById(state.id);
      if (!node || node.empty()) return;
      const dx = (e.clientX - state.startX) / viewport.zoom;
      const dy = (e.clientY - state.startY) / viewport.zoom;
      node.position({ x: state.nodeX + dx, y: state.nodeY + dy });

      // Only the dragged node's model position changed: update just its card
      // box instead of re-measuring every node in the graph.
      const box = node.boundingBox({ includeLabels: true });
      const next: CardBox = { x: box.x1, y: box.y1, w: box.w, h: box.h };
      setCardBoxes((prev) =>
        sameCardBox(prev[state.id], next) ? prev : { ...prev, [state.id]: next }
      );
    },
    [viewport.zoom]
  );

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setDraggingId(null);
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }, [onDragMove]);

  const startDrag = useCallback(
    (clsId: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".uml-inline-form") || target.closest(".uml-plus") || target.closest(".canvas-toolbar") || target.closest(".canvas-form")) {
        return;
      }
      const cy = cyRef.current;
      if (!cy) return;
      const node = cy.getElementById(clsId);
      if (!node || node.empty()) return;
      e.preventDefault();
      const pos = node.position();
      dragRef.current = { id: clsId, startX: e.clientX, startY: e.clientY, nodeX: pos.x, nodeY: pos.y };
      setDraggingId(clsId);
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", onDragEnd);
    },
    [onDragEnd, onDragMove]
  );

  useEffect(() => {
    return () => onDragEnd();
  }, [onDragEnd]);

  const inlinePortal = useMemo(() => {
    if (!activeQuantityTarget || !overlayRef.current) return null;
    const targetCard = cardViews.find((c) => c.cls.id === activeQuantityTarget);
    const box = targetCard?.box;
    if (!box) return null;
    const overlayRect = overlayRef.current.getBoundingClientRect();
    const left = overlayRect.left + viewport.pan.x + box.x * viewport.zoom + box.w * viewport.zoom + 12;
    const top = overlayRect.top + viewport.pan.y + box.y * viewport.zoom + 10;
    return { cls: targetCard.cls, pos: { top, left } };
  }, [activeQuantityTarget, cardViews, viewport]);

  const expandedClassIdSet = useMemo(() => new Set(expandedClassIds ?? []), [expandedClassIds]);
  // Subclasses hang below a card, linked by inheritance arrows, so the toggle needs those arrows shown.
  const subclassToggle = (cls: UmlClassNode) => {
    if (!onToggleSubclasses || !showInheritance) return null;
    const expanded = expandedClassIdSet.has(cls.id);
    const count = cls.subclasses ?? 0;
    if (!expanded && count === 0) return null;
    return (
      <button
        type="button"
        className={`uml-subclass-toggle${expanded ? " is-expanded" : ""}`}
        title={expanded ? "Hide subclasses" : `Show ${count} ${count === 1 ? "subclass" : "subclasses"}`}
        aria-label={expanded ? `Hide subclasses of ${cls.name}` : `Show subclasses of ${cls.name}`}
        aria-expanded={expanded}
        disabled={togglingClassId !== null}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={async (e) => {
          e.stopPropagation();
          setTogglingClassId(cls.id);
          try {
            await onToggleSubclasses(cls.id);
          } finally {
            setTogglingClassId(null);
          }
        }}
      >
        {expanded ? "−" : "+"}
      </button>
    );
  };

  return (
    <div className="graph" style={{ position: "relative" }}>
      <div className={`cy-canvas${showEditingUi ? " is-hidden" : ""}`} ref={containerRef} />
      {!showEditingUi && onToggleSubclasses ? (
        <div
          className="uml-toggle-layer"
          style={{
            transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})`,
          }}
        >
          {cardViews.map(({ cls, box }) => {
            const toggle = box ? subclassToggle(cls) : null;
            if (!toggle || !box) return null;
            return (
              <div key={cls.id} className="uml-toggle-anchor" style={{ left: box.x + box.w / 2, top: box.y + box.h }}>
                {toggle}
              </div>
            );
          })}
        </div>
      ) : null}
      {showEditingUi && (
        <div
          className="uml-overlay"
          ref={overlayRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelected(null);
              setActiveQuantityTarget(null);
              onClearSelection?.();
            }
          }}
        >
          <div className="canvas-toolbar">
            <button className="btn" type="button" onClick={() => setShowClassForm((v) => !v)}>
              {showClassForm ? "Close add class" : "Add class"}
            </button>
              {showClassForm && (
                <div className="canvas-form" onClick={(e) => e.stopPropagation()}>
                  <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
                    <div className="label" style={{ margin: 0 }}>New class</div>
                    <button className="btn secondary" type="button" onClick={() => setShowClassForm(false)}>
                    Cancel
                  </button>
                </div>
                <label className="label" htmlFor="new-class-name">{editRules.codes ? "Code" : "Name"}</label>
                <input
                  id="new-class-name"
                  className="input"
                  value={classDraft.name}
                  onChange={(e) => setClassDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={editRules.codes ? "e.g. PARENT_CODE.NEW_TYPE" : "e.g. NewSection"}
                />
                <label className="label" htmlFor="new-class-parent">Parent class</label>
                <select
                  id="new-class-parent"
                  className="select"
                  value={classDraft.parentId}
                  onChange={(e) =>
                    setClassDraft((prev) => ({
                      ...prev,
                      parentId: e.target.value,
                      card: e.target.value ? prev.card : "",
                    }))
                  }
                >
                  <option value="">No parent</option>
                  {classCards.map((cls) => (
                    <option key={cls.id} value={cls.id}>
                      {cls.name}
                    </option>
                  ))}
                </select>
                <label className="label" htmlFor="new-class-relation">Relationship</label>
                <select
                  id="new-class-relation"
                  className="select"
                  value={classDraft.relation}
                  onChange={(e) =>
                    setClassDraft((prev) => ({
                      ...prev,
                      relation: e.target.value as "inherits" | "hasSubSection",
                      card: e.target.value === "hasSubSection" ? prev.card : "",
                    }))
                  }
                  disabled={!classDraft.parentId}
                  title={classDraft.parentId ? "Choose how this class links to its parent" : "Select a parent to set relationship"}
                >
                  <option value="inherits">Inheritance (is-a)</option>
                  {editRules.codes ? null : <option value="hasSubSection">Subsection (has-a)</option>}
                </select>
                {classDraft.parentId && classDraft.relation === "hasSubSection" ? (
                  <>
                    <div className="row" style={{ alignItems: "center", gap: 8 }}>
                      <input
                        id="new-class-repeated"
                        type="checkbox"
                        checked={classDraft.card === "0..*"}
                        onChange={(e) =>
                          setClassDraft((prev) => ({
                            ...prev,
                            card: e.target.checked ? "0..*" : "",
                          }))
                        }
                      />
                      <label className="label" htmlFor="new-class-repeated" style={{ margin: 0 }}>
                        Repeated subsection
                      </label>
                    </div>
                    <label className="label" htmlFor="new-class-card">Cardinality</label>
                    <input
                      id="new-class-card"
                      className="input"
                      value={classDraft.card}
                      onChange={(e) => setClassDraft((prev) => ({ ...prev, card: e.target.value }))}
                      placeholder="0..*"
                    />
                  </>
                ) : null}
                <label className="label" htmlFor="new-class-doc">Docstring</label>
                <textarea
                  id="new-class-doc"
                  className="input"
                  style={{ minHeight: 60, resize: "vertical" }}
                  value={classDraft.docstring}
                  onChange={(e) => setClassDraft((prev) => ({ ...prev, docstring: e.target.value }))}
                  placeholder="Optional description"
                />
                {classError ? <div className="inline-error">{classError}</div> : null}
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button className="btn" type="button" onClick={handleClassSubmit} disabled={creatingClass}>
                    {creatingClass ? "Adding…" : "Add class"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})`,
              transformOrigin: "top left",
              pointerEvents: "none"
            }}
          >
            <svg
              aria-hidden="true"
              className="uml-edit-edges"
              style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none", zIndex: 1 }}
            >
              <defs>
                <marker
                  id="edit-composition-arrow"
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="5"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={palette.composition} />
                </marker>
                <marker
                  id="edit-composition-diamond"
                  markerWidth="12"
                  markerHeight="12"
                  refX="2"
                  refY="6"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M 2 6 L 6 2 L 10 6 L 6 10 z" fill={palette.composition} stroke={palette.composition} />
                </marker>
                <marker
                  id="edit-inheritance-arrow"
                  markerWidth="12"
                  markerHeight="12"
                  refX="10"
                  refY="6"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M 1 1 L 11 6 L 1 11 z" fill="none" stroke={palette.inheritance} strokeWidth="1.5" />
                </marker>
              </defs>
              {editableEdgeViews.map(({ key, edge, points }) => {
                const isInheritance = edge.type === "inherits";
                const midX = (points.x1 + points.x2) / 2;
                const midY = (points.y1 + points.y2) / 2;
                return (
                  <g key={key}>
                    <line
                      x1={points.x1}
                      y1={points.y1}
                      x2={points.x2}
                      y2={points.y2}
                      stroke={isInheritance ? palette.inheritance : palette.composition}
                      strokeWidth={2}
                      strokeDasharray={isInheritance ? "10 8" : undefined}
                      markerStart={isInheritance ? undefined : "url(#edit-composition-diamond)"}
                      markerEnd={isInheritance ? "url(#edit-inheritance-arrow)" : "url(#edit-composition-arrow)"}
                    />
                    {!isInheritance && edge.card ? (
                      <text
                        x={midX}
                        y={midY - 6}
                        fill={palette.composition}
                        fontSize={10}
                        textAnchor="middle"
                      >
                        {edge.card}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
            {cardViews.map(({ cls, box }) => {
              if (!box) return null;
              const isSelected = selectedClassId === cls.id;
              const hasInline = activeQuantityTarget === cls.id;
              const zIndex = hasInline ? 1200 : isSelected ? 900 : 200;
              const moduleLabel = cls.module ? (cls.module.split(".").pop() || cls.module) : null;
              const toggle = subclassToggle(cls);
              return (
                <div
                  key={cls.id}
                  className={`uml-card ${isSelected ? "is-selected" : ""} ${hasInline ? "has-inline" : ""} ${draggingId === cls.id ? "dragging" : ""}`}
                  style={{
                    transform: `translate(${box.x}px, ${box.y}px)`,
                    width: editableCardWidth(box),
                    minWidth: 200,
                    zIndex,
                    pointerEvents: "auto",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (selectedClassId !== cls.id) {
                      setActiveQuantityTarget(null);
                      handleSelectClass(cls.id);
                    }
                  }}
                  onMouseDown={(e) => startDrag(cls.id, e)}
                >
                  <div className="uml-card-header">
                    <div>
                      <div className="uml-card-title">{cls.name}</div>
                      {moduleLabel ? <div className="uml-card-sub" title={cls.module || ""}>{moduleLabel}</div> : null}
                    </div>
                    {editingEnabled && isSelected ? (
                      <button
                        className="uml-plus"
                        type="button"
                        title="Add quantity"
                        onClick={(e) => {
                          e.stopPropagation();
                          openQuantityFormFor(cls.id);
                        }}
                      >
                        +
                      </button>
                    ) : null}
                  </div>
                  <div className="uml-qty-list">
                    {cls.quantities.filter((q) => !q.inherited).map((q) => {
                      const metaParts = [
                        q.dtype,
                        q.shape && q.shape !== "[]" ? q.shape : null,
                        q.card ? `[${q.card}]` : null,
                      ]
                        .filter(Boolean)
                        .join("  ");
                      return (
                        <div key={q.id} className="uml-qty">
                          <div className="uml-qty-name">{q.name}</div>
                          <div className="uml-qty-meta">{metaParts}</div>
                        </div>
                      );
                    })}
                  </div>
                  {toggle ? <div className="uml-toggle-anchor">{toggle}</div> : null}

                </div>
              );
            })}
          </div>

          {editingEnabled && inlinePortal ? (
            <div
              className="uml-inline-portal"
              style={{ position: "fixed", top: inlinePortal.pos.top, left: inlinePortal.pos.left, zIndex: 5000, pointerEvents: "auto" }}
              onClick={(e) => e.stopPropagation()}
            >
              <form
                className="uml-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleQuantitySubmit(inlinePortal.cls);
                }}
              >
                {(() => {
                  const isVocabulary = editRules.codes && inlinePortal.cls.quantities.some((q) => q.dtype === VOCAB_TERM);
                  const needsRange = editRules.dtypes.find((d) => d.name === quantityDraft.dtype)?.needs_range;
                  const wantsVocabulary = quantityDraft.dtype === "CONTROLLEDVOCABULARY";
                  const rangeChoices = (umlState?.classes ?? []).filter(
                    (c) => c.quantities.some((q) => q.dtype === VOCAB_TERM) === wantsVocabulary
                  );
                  return (
                    <>
                      <div className="label" style={{ marginBottom: 6 }}>
                        {isVocabulary ? "New term" : editRules.codes ? "New property" : "New quantity"}
                      </div>
                      {editRules.codes ? (
                        <>
                          <input
                            className="input"
                            placeholder="CODE"
                            value={quantityDraft.code}
                            onChange={(e) => setQuantityDraft((prev) => ({ ...prev, code: e.target.value }))}
                          />
                          <input
                            className="input"
                            placeholder="Label (optional)"
                            value={quantityDraft.label}
                            onChange={(e) => setQuantityDraft((prev) => ({ ...prev, label: e.target.value }))}
                          />
                        </>
                      ) : (
                        <input
                          className="input"
                          placeholder="name"
                          value={quantityDraft.quantityName}
                          onChange={(e) => setQuantityDraft((prev) => ({ ...prev, quantityName: e.target.value }))}
                        />
                      )}
                      {isVocabulary ? null : (
                        <select
                          className="select"
                          value={quantityDraft.dtype}
                          onChange={(e) => setQuantityDraft((prev) => ({ ...prev, dtype: e.target.value, range: "" }))}
                        >
                          {editRules.dtypes.map((t) => (
                            <option key={t.name} value={t.name}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {!isVocabulary && needsRange ? (
                        <select
                          className="select"
                          value={quantityDraft.range}
                          onChange={(e) => setQuantityDraft((prev) => ({ ...prev, range: e.target.value }))}
                        >
                          <option value="">{wantsVocabulary ? "Vocabulary…" : "Object type…"}</option>
                          {rangeChoices.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {editRules.codes && !isVocabulary ? (
                        <label className="row" style={{ alignItems: "center", gap: 6, fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={quantityDraft.mandatory}
                            onChange={(e) => setQuantityDraft((prev) => ({ ...prev, mandatory: e.target.checked }))}
                          />
                          Mandatory
                        </label>
                      ) : null}
                    </>
                  );
                })()}
                <textarea
                  className="input"
                  placeholder="Docstring (optional)"
                  style={{ minHeight: 60, resize: "vertical" }}
                  value={quantityDraft.docstring}
                  onChange={(e) => setQuantityDraft((prev) => ({ ...prev, docstring: e.target.value }))}
                />
                {inlineError ? <div className="inline-error">{inlineError}</div> : null}
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveQuantityTarget(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn"
                    type="submit"
                    disabled={creatingQuantityFor === inlinePortal.cls.id}
                  >
                    {creatingQuantityFor === inlinePortal.cls.id ? "Adding…" : "Add"}
                  </button>
                </div>
              </form>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

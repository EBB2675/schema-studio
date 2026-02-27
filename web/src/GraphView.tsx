import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import elk from "elkjs/lib/elk.bundled.js";
import cytoscapeElk from "cytoscape-elk";
import type { Core, ElementDefinition } from "cytoscape";
import { useSelection, type QtyMeta, type QtySnapshot } from "./store/selection";
import { SUPPORTED_DTYPES } from "./components/quantityShared";
import type { ApiEdge, ApiNode } from "./types/api";
import type { QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";
import { fqidFromParts } from "./utils/identifier";

type QtyDiffState = "added" | "removed" | "changed" | undefined;

cytoscapeElk(cytoscape, elk);

type RawNode = ApiNode;
type RawEdge = ApiEdge;

export type GraphExportHandle = {
  toPng: () => string | null;
  focusNode: (name: string) => boolean;
  refit: () => void;
};

type DiffNodes = { added: ApiNode[]; removed: ApiNode[]; changed: { id: string }[] };
type DiffEdges = { added: ApiEdge[]; removed: ApiEdge[] };

type Props = {
  nodes: RawNode[];
  edges: RawEdge[];
  diff?: {
    nodes: DiffNodes;
    edges: DiffEdges;
  } | null;
  onReady?: (handle: GraphExportHandle | null) => void;
  showQuantityMetadata?: boolean;
  showInheritance?: boolean;
  theme?: "dark" | "light";
  umlState?: UmlGraphState | null;
  baseNamespaces?: string[];
  showBaseSections?: boolean;
  selectedClassId?: string | null;
  onSelectClass?: (cls: UmlClassNode) => void;
  onCreateQuantity?: (classId: string, data: { quantityName: string; dtype: string; docstring: string }) => Promise<void>;
  onCreateClass?: (data: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection" }) => Promise<void>;
  creatingQuantityFor?: string | null;
  creatingClass?: boolean;
  onClearSelection?: () => void;
  editableMode?: boolean;
};

const cleanType = (t?: string | null) => {
  if (!t) return "";
  const m = t.match(/^m_[a-zA-Z0-9_]+\((.+)\)$/);
  if (m) return m[1];
  if (t.startsWith("m_")) return t.replace(/^m_/, "");
  return t;
};

function umlLabel(
  name: string,
  attrs: { name: string; dtype?: string; shape?: string | null; card?: string | null; diff?: QtyDiffState }[],
  methods: string[],
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
    if (a.card) parts.push(` [${a.card}]`);
    return parts.join("");
  });
  const methodLines = methods.map(s => s + "()");

  const lines = [name, "────────────", ...attrLines];
  if (methods.length) lines.push("────────────", ...methodLines);
  return lines.join("\n");
}

export default function GraphView({
  nodes,
  edges,
  diff,
  onReady,
  showQuantityMetadata = true,
  showInheritance = true,
  theme = "dark",
  umlState,
  baseNamespaces = [],
  showBaseSections = false,
  selectedClassId,
  onSelectClass,
  onCreateQuantity,
  onCreateClass,
  creatingQuantityFor,
  creatingClass,
  onClearSelection,
  editableMode = false
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [cardBoxes, setCardBoxes] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const [viewport, setViewport] = useState<{ pan: { x: number; y: number }; zoom: number }>({
    pan: { x: 0, y: 0 },
    zoom: 1,
  });
  const [activeQuantityTarget, setActiveQuantityTarget] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; nodeX: number; nodeY: number } | null>(null);
  const [quantityDraft, setQuantityDraft] = useState<{ quantityName: string; dtype: string; docstring: string }>({
    quantityName: "",
    dtype: SUPPORTED_DTYPES[0],
    docstring: "",
  });
  const [showClassForm, setShowClassForm] = useState<boolean>(false);
  const [classDraft, setClassDraft] = useState<{ name: string; parentId: string; docstring: string; relation: "inherits" | "hasSubSection" }>({
    name: "",
    parentId: "",
    docstring: "",
    relation: "inherits",
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
  const allClassCards = useMemo(() => umlState?.classes ?? [], [umlState]);
  const classCards = useMemo(() => {
    if (!allClassCards.length) return [];
    if (showBaseSections || !namespaceFilters.length) return allClassCards;

    return allClassCards.filter((cls) => {
      if (selectedClassId && cls.id === selectedClassId) return true;
      const moduleName = cls.module || cls.id;
      return namespaceFilters.some((ns) => moduleName === ns || moduleName.startsWith(`${ns}.`));
    });
  }, [allClassCards, namespaceFilters, selectedClassId, showBaseSections]);
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
      setQuantityDraft({
        quantityName: "",
        dtype: SUPPORTED_DTYPES[0],
        docstring: "",
      });
    if (classId !== selectedClassId) {
      handleSelectClass(classId);
    }
    },
    [handleSelectClass, selectedClassId]
  );

  const handleQuantitySubmit = useCallback(
    async (cls: UmlClassNode) => {
      if (!onCreateQuantity) return;
      const trimmed = quantityDraft.quantityName.trim();
      if (!trimmed) {
        setInlineError("Quantity name is required");
        return;
      }
      try {
        await onCreateQuantity(cls.id, {
          quantityName: trimmed,
          dtype: quantityDraft.dtype,
          docstring: quantityDraft.docstring.trim(),
        });
        setInlineError(null);
        setActiveQuantityTarget(null);
        setQuantityDraft({ quantityName: "", dtype: SUPPORTED_DTYPES[0], docstring: "" });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to add quantity";
        setInlineError(message);
      }
    },
    [onCreateQuantity, quantityDraft]
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
      });
      setClassError(null);
      setShowClassForm(false);
      setClassDraft({ name: "", parentId: "", docstring: "", relation: "inherits" });
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
  // - methodsMap: section id -> methods
  // - quantitiesByOwner: section id -> QtyMeta[]  (for DocPanel)
  const { sectionsMap, attrsMap, methodsMap, umlEdges, quantitiesByOwner } = useMemo(() => {
    const sections = new Map<string, RawNode>();
    const attrs = new Map<
      string,
      { name: string; dtype?: string; shape?: string | null; card?: string | null; diff?: QtyDiffState }[]
    >();
    const methods = new Map<string, string[]>();
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
        methods.set(n.id, (n.methods ?? []) as string[]);
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

    if (classCards.length > 0) {
      const sourceSections = new Map(sections);
      const sourceMethods = new Map(methods);
      sections.clear();
      methods.clear();
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
          } as RawNode)
        );
        methods.set(cls.id, sourceMethods.get(cls.id) ?? []);

        attrs.set(
          cls.id,
          cls.quantities.map((q) => ({
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

    const baseEdges = [...resolvedEdges];
    if (diff?.edges?.removed?.length) {
      diff.edges.removed.forEach((e) => {
        if (!e?.source || !e?.target) return;
        const type = (e.type as RawEdge["type"]) ?? "hasSubSection";
        baseEdges.push({
          source: e.source,
          target: e.target,
          type,
          card: e.card ?? undefined
        });
      });
    }

    const umlEdges = baseEdges.filter((e) => {
      if (e.type === "hasSubSection") return true;
      if (e.type === "inherits") return showInheritance;
      return false;
    });

    return { sectionsMap: sections, attrsMap: attrs, methodsMap: methods, umlEdges, quantitiesByOwner: qByOwner };
  }, [graphNodes, resolvedEdges, quantityDiffs, diff, showInheritance, classCards, toQtyMeta]);

  useEffect(() => {
    if (!containerRef.current) return;
    cyRef.current?.destroy();
    cyRef.current = null;
    onReady?.(null);

    const elements: ElementDefinition[] = [];

    for (const [secId, sec] of sectionsMap.entries()) {
      const attrs = attrsMap.get(secId) ?? [];
      const methods = methodsMap.get(secId) ?? [];
      elements.push({
        data: {
          id: secId,
          label: umlLabel(sec.label, attrs, methods, showQuantityMetadata),
          rawName: sec.label,
          kind: "uml_class",
          module: sec.module ?? "",
          doc: sec.doc ?? "",
          path: sec.path ?? "",
          line: typeof sec.line === "number" ? sec.line : undefined
        }
      });
    }

    umlEdges.forEach((e, i) => {
      if (!sectionsMap.has(e.source) || !sectionsMap.has(e.target)) return;
      const relationship = e.type === "inherits" ? "inheritance" : "composition";
      elements.push({
        data: {
          id: `assoc:${relationship}:${i}:${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: e.type,
          relationship,
          card: e.card ?? ""
        }
      });
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3.5,
      wheelSensitivity: 1.05,
      style: [
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
      ],
      layout: {
        name: "elk",
        nodeDimensionsIncludeLabels: true,
        elk: {
          algorithm: "layered",
          "elk.direction": "RIGHT",
          "elk.layered.spacing.nodeNodeBetweenLayers": 90,
          "elk.spacing.nodeNode": 26,
          "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
          "elk.layered.mergeEdges": true,
          "elk.edgeRouting": "ORTHOGONAL"
        }
      } as unknown as cytoscape.LayoutOptions
    });

    let refitTimeout: number | null = null;

    const refitToContent = () => {
      cy.resize();
      cy.fit(undefined, 32);
    };

    const scheduleRefit = () => {
      refitToContent();
      requestAnimationFrame(refitToContent);
      if (refitTimeout) window.clearTimeout(refitTimeout);
      refitTimeout = window.setTimeout(refitToContent, 140);
    };

    let handlePublished = false;

    const publishHandle = () => {
      if (handlePublished) return;
      handlePublished = true;
      onReady?.({
        toPng: () =>
          cyRef.current?.png({
            full: true,
            scale: 2,
            bg: "#ffffff"
          }) ?? null,
        focusNode,
        refit: () => scheduleRefit(),
      });
    };

    cy.one("layoutstop", () => {
      scheduleRefit();
      publishHandle();
    });

    const resizeObserver = new ResizeObserver(() => scheduleRefit());
    resizeObserver.observe(containerRef.current);

    const focusNode = (name: string) => {
      const cy = cyRef.current;
      if (!cy) return false;

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
      }));

      publishClassSelection({
        id: d.id,
        name: d.rawName || d.id,
        doc: d.doc || "",
        module: d.module || "",
        path: d.path || "",
        line: typeof d.line === "number" ? d.line : null,
        quantities,
      });

      cy.animate(
        {
          center: { eles: target },
          zoom: Math.min(1.2, cy.maxZoom()),
        },
        { duration: 240, easing: "ease-in-out" }
      );

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

    cyRef.current = cy;

    cy.ready(() => {
      // In rare cases ELK may not fire layoutstop (e.g., empty graphs);
      // ensure the view centers and the handle is published once the core is ready.
      scheduleRefit();
      publishHandle();
    });

    // Diff highlights (unchanged)
    if (diff) {
      const addedIds   = new Set(diff.nodes?.added?.map((n) => n.id));
      const removedIds = new Set(diff.nodes?.removed?.map((n) => n.id));
      const changedIds = new Set(diff.nodes?.changed?.map((c) => c.id));

      cy.$("node").forEach((n) => {
        const id = n.id();
        if (addedIds.has(id))   n.addClass("diff-added");
        if (removedIds.has(id)) n.addClass("diff-removed");
        if (changedIds.has(id)) n.addClass("diff-changed");
      });

      const edgeKey = (e: ApiEdge) => `${e.source}|${e.target}|${e.type ?? ""}`;
      const addedE   = new Set(diff.edges?.added?.map(edgeKey));
      const removedE = new Set(diff.edges?.removed?.map(edgeKey));

      cy.$("edge").forEach(e => {
        const k = `${e.data("source")}|${e.data("target")}|${e.data("type") || ""}`;
        if (addedE.has(k))   e.addClass("diff-added");
        if (removedE.has(k)) e.addClass("diff-removed");
      });
    }

    return () => {
      resizeObserver.disconnect();
      if (refitTimeout) window.clearTimeout(refitTimeout);
      onReady?.(null);
      cyRef.current?.destroy();
    };
  }, [sectionsMap, attrsMap, methodsMap, umlEdges, quantitiesByOwner, diff, setSelected, onReady, showQuantityMetadata, palette, publishClassSelection]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    let rafId: number | null = null;

    const updateBoxes = () => {
      const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
      const pan = cy.pan();
      const zoom = cy.zoom();

      cy.nodes().forEach((n) => {
        const box = n.boundingBox({ includeLabels: true });
        boxes[n.id()] = { x: box.x1, y: box.y1, w: box.w, h: box.h };
      });

      setViewport((prev) => {
        const samePan = prev.pan.x === pan.x && prev.pan.y === pan.y;
        const sameZoom = prev.zoom === zoom;
        if (samePan && sameZoom) return prev;
        return { pan, zoom };
      });
      setCardBoxes(boxes);
    };

    const scheduleUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateBoxes();
      });
    };

    updateBoxes();
    cy.on("render", scheduleUpdate);
    cy.on("pan zoom", scheduleUpdate);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      cy.off("render", scheduleUpdate);
      cy.off("pan zoom", scheduleUpdate);
    };
  }, [umlState, theme, umlEdges, graphNodes, showQuantityMetadata, diff]);

  const cardViews = useMemo(
    () =>
      classCards.map((cls) => ({
        cls,
        box: cardBoxes[cls.id],
      })),
    [cardBoxes, classCards]
  );

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
      cy.emit("render");
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

  return (
    <div className="graph" style={{ position: "relative" }}>
      <div className={`cy-canvas${showEditingUi ? " is-hidden" : ""}`} ref={containerRef} />
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
                <label className="label" htmlFor="new-class-name">Name</label>
                <input
                  id="new-class-name"
                  className="input"
                  value={classDraft.name}
                  onChange={(e) => setClassDraft((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. NewSection"
                />
                <label className="label" htmlFor="new-class-parent">Parent class</label>
                <select
                  id="new-class-parent"
                  className="select"
                  value={classDraft.parentId}
                  onChange={(e) => setClassDraft((prev) => ({ ...prev, parentId: e.target.value }))}
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
                    }))
                  }
                  disabled={!classDraft.parentId}
                  title={classDraft.parentId ? "Choose how this class links to its parent" : "Select a parent to set relationship"}
                >
                  <option value="inherits">Inheritance (is-a)</option>
                  <option value="hasSubSection">Subsection (has-a)</option>
                </select>
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
            {cardViews.map(({ cls, box }) => {
              if (!box) return null;
              const isSelected = selectedClassId === cls.id;
              const hasInline = activeQuantityTarget === cls.id;
              const zIndex = hasInline ? 1200 : isSelected ? 900 : 200;
              const moduleLabel = cls.module ? (cls.module.split(".").pop() || cls.module) : null;
              return (
                <div
                  key={cls.id}
                  className={`uml-card ${isSelected ? "is-selected" : ""} ${hasInline ? "has-inline" : ""} ${draggingId === cls.id ? "dragging" : ""}`}
                  style={{
                    transform: `translate(${box.x}px, ${box.y}px)`,
                    width: Math.max(box.w + 24, 200),
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
                    {cls.quantities.map((q) => {
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
                <div className="label" style={{ marginBottom: 6 }}>New quantity</div>
                <input
                  className="input"
                  placeholder="name"
                  value={quantityDraft.quantityName}
                  onChange={(e) => setQuantityDraft((prev) => ({ ...prev, quantityName: e.target.value }))}
                />
                <select
                  className="select"
                  value={quantityDraft.dtype}
                  onChange={(e) => setQuantityDraft((prev) => ({ ...prev, dtype: e.target.value }))}
                >
                  {SUPPORTED_DTYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
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

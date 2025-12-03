import { useEffect, useMemo, useRef } from "react";
import cytoscape from "cytoscape";
import elk from "elkjs/lib/elk.bundled.js";
import cytoscapeElk from "cytoscape-elk";
import type { Core, ElementDefinition } from "cytoscape";
import { useSelection, type QtyMeta, type QtySnapshot } from "./store/selection";

type QtyDiffState = QtyMeta["diff"] extends { state: infer S } ? S : undefined;

cytoscapeElk(cytoscape, elk as any);

type RawNode = {
  id: string;
  kind: "section" | "quantity";
  label: string;
  module?: string;
  dtype?: string | null;
  data_type?: string | null;
  type?: string | null;
  shape?: string | null;
  card?: string | null;
  owner?: string | null;
  doc?: string | null;
  methods?: string[] | null;
  path?: string | null;
  line?: number | null;
};

type RawEdge = {
  source: string;
  target: string;
  type: "hasQuantity" | "hasSubSection";
  card?: string | null;
};

export type GraphExportHandle = {
  toPng: () => string | null;
};

type Props = {
  nodes: RawNode[];
  edges: RawEdge[];
  diff?: {
    nodes: { added: any[]; removed: any[]; changed: { id: string }[] };
    edges: {
      added: { source: string; target: string; type?: string }[];
      removed: { source: string; target: string; type?: string }[];
    };
  } | null;
  onReady?: (handle: GraphExportHandle | null) => void;
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
  methods: string[]
) {
  const MAX_A = 18;
  const MAX_M = 14;
  const shownA = attrs.slice(0, MAX_A);
  const shownM = methods.slice(0, MAX_M);

  const attrLines = shownA.map(a => {
    const parts = [] as string[];
    if (a.diff === "added") parts.push("🟢 ");
    if (a.diff === "removed") parts.push("🔴 ");
    if (a.diff === "changed") parts.push("🟠 ");

    parts.push(a.name);
    const dt = cleanType(a.dtype);
    if (dt) parts.push(`: ${dt}`);
    if (a.shape && a.shape !== "[]") parts.push(` ${a.shape}`);
    if (a.card) parts.push(` [${a.card}]`);
    return parts.join("");
  });
  const moreA = attrs.length > MAX_A ? [`… (+${attrs.length - MAX_A} more)`] : [];

  const methodLines = shownM.map(s => s + "()");
  const moreM = methods.length > MAX_M ? [`… (+${methods.length - MAX_M} more)`] : [];

  const lines = [name, "────────────", ...attrLines, ...moreA];
  if (methods.length) lines.push("────────────", ...methodLines, ...moreM);
  return lines.join("\n");
}

export default function GraphView({ nodes, edges, diff, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const setSelected = useMemo(() => useSelection.getState().setSelected, []);

  const quantityDiffs = useMemo(() => {
    const map = new Map<
      string,
      { state: "added" | "removed" | "changed"; before?: RawNode; after?: RawNode }
    >();

    if (!diff) return map;

    diff.nodes?.added?.forEach((n: any) => {
      if (n?.kind === "quantity" && n.id) {
        map.set(n.id, { state: "added", after: n });
      }
    });

    diff.nodes?.removed?.forEach((n: any) => {
      if (n?.kind === "quantity" && n.id) {
        map.set(n.id, { state: "removed", before: n });
      }
    });

    diff.nodes?.changed?.forEach((entry: any) => {
      const before = entry?.before;
      const after = entry?.after;
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
      diff.nodes.removed.forEach((n: any) => {
        if (!n?.id || (n?.kind !== "section" && n?.kind !== "quantity")) return;
        base.push(n as RawNode);
      });
    }
    return base;
  }, [nodes, diff]);

  // Build:
  // - sectionsMap: id -> section node
  // - attrsMap: section id -> display lines for UML
  // - methodsMap: section id -> methods
  // - quantitiesByOwner: section id -> QtyMeta[]  (for DocPanel)
  const { sectionsMap, attrsMap, methodsMap, compEdges, quantitiesByOwner } = useMemo(() => {
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
        dtype: n.dtype ?? (n as any).data_type ?? (n as any).type ?? undefined,
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
          diffInfo.before?.dtype ?? (diffInfo.before as any)?.data_type ?? (diffInfo.before as any)?.type ?? undefined,
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

    const baseEdges = [...edges];
    if (diff?.edges?.removed?.length) {
      diff.edges.removed.forEach((e: any) => {
        if (!e?.source || !e?.target) return;
        baseEdges.push({
          source: e.source,
          target: e.target,
          type: (e.type as any) ?? "hasSubSection",
          card: e.card ?? undefined
        });
      });
    }

    const subs = baseEdges.filter(e => e.type === "hasSubSection");
    return { sectionsMap: sections, attrsMap: attrs, methodsMap: methods, compEdges: subs, quantitiesByOwner: qByOwner };
  }, [graphNodes, edges, quantityDiffs, diff]);

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
          label: umlLabel(sec.label, attrs, methods),
          rawName: sec.label,
          kind: "uml_class",
          module: sec.module ?? "",
          doc: sec.doc ?? "",
          path: sec.path ?? "",
          line: typeof sec.line === "number" ? sec.line : undefined
        }
      });
    }

    compEdges.forEach((e, i) => {
      if (!sectionsMap.has(e.source) || !sectionsMap.has(e.target)) return;
      elements.push({
        data: {
          id: `assoc:${i}:${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: "composition",
          card: e.card ?? ""
        }
      });
    });

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3.5,
      wheelSensitivity: 0.2,
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
          } as any
        },
        {
          selector: "edge[type='composition']",
          style: {
            "line-color": "#475569",
            width: 2,
            "curve-style": "segments",
            "source-arrow-shape": "diamond",
            "source-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#475569",
            "arrow-scale": 1.1,
            label: "data(card)",
            "font-size": 10,
            "text-rotation": "autorotate",
            "text-margin-y": -6,
            "text-background-color": "#f5f7fa",
            "text-background-opacity": 1,
            "text-background-padding": "2px"
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
      } as any
    });

    // Selection → DocPanel + UnderTheHoodPanel
    cy.on("tap", "node", (evt) => {
      const d = evt.target.data();
      const qList = quantitiesByOwner.get(d.id) || [];

      // fully-qualified section name for /usage
      // e.g. module="nomad_simulations.schema_packages.model_method", rawName="DFT"
      const fqid =
        d.module && (d.rawName || d.id)
          ? `${d.module}.${d.rawName || d.id}`
          : d.id;

      useSelection.getState().setSelected({
        id: d.id,                    
        fqid,                       
        kind: "class",
        name: d.rawName || d.id,
        doc: d.doc || "",
        path: d.path || "",
        line: typeof d.line === "number" ? d.line : undefined,
        quantities: qList,
      });
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) useSelection.getState().setSelected(null);
    });

    cyRef.current = cy;

    onReady?.({
      toPng: () =>
        cyRef.current?.png({
          full: true,
          scale: 2,
          bg: "#ffffff"
        }) ?? null
    });

    // Diff highlights (unchanged)
    if (diff) {
      const addedIds   = new Set(diff.nodes?.added?.map((n: any) => n.id));
      const removedIds = new Set(diff.nodes?.removed?.map((n: any) => n.id));
      const changedIds = new Set(diff.nodes?.changed?.map((c: any) => c.id));

      cy.$("node").forEach((n) => {
        const id = n.id();
        if (addedIds.has(id))   n.addClass("diff-added");
        if (removedIds.has(id)) n.addClass("diff-removed");
        if (changedIds.has(id)) n.addClass("diff-changed");
      });

      const edgeKey = (e: any) => `${e.source}|${e.target}|${e.type ?? ""}`;
      const addedE   = new Set(diff.edges?.added?.map(edgeKey));
      const removedE = new Set(diff.edges?.removed?.map(edgeKey));

      cy.$("edge").forEach(e => {
        const k = `${e.data("source")}|${e.data("target")}|${e.data("type") || ""}`;
        if (addedE.has(k))   e.addClass("diff-added");
        if (removedE.has(k)) e.addClass("diff-removed");
      });
    }

    return () => {
      onReady?.(null);
      cyRef.current?.destroy();
    };
  }, [sectionsMap, attrsMap, methodsMap, compEdges, quantitiesByOwner, diff, setSelected, onReady]);

  return <div className="graph" ref={containerRef} />;
}

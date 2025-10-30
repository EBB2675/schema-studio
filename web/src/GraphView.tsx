import React, { useEffect, useMemo, useRef } from "react";
import cytoscape from "cytoscape";
import elk from "elkjs/lib/elk.bundled.js";
import cytoscapeElk from "cytoscape-elk";
import type { Core, ElementDefinition, NodeSingular, EdgeSingular } from "cytoscape";

cytoscapeElk(cytoscape, elk as any);

type RawNode = {
  id: string;
  kind: "section" | "quantity";
  label: string;
  module?: string;
  dtype?: string | null;
  shape?: string | null;
  card?: string | null;
  owner?: string | null;
  doc?: string | null;
  methods?: string[] | null;
};

type RawEdge = {
  source: string;
  target: string;
  type: "hasQuantity" | "hasSubSection";
  card?: string | null;
};

type Props = { nodes: RawNode[]; edges: RawEdge[] };

// --- helpers ---
const cleanType = (t?: string | null) => {
  if (!t) return "";
  const m = t.match(/^m_[a-zA-Z0-9_]+\((.+)\)$/);
  if (m) return m[1];
  if (t.startsWith("m_")) return t.replace(/^m_/, "");
  return t;
};

function umlLabel(
  name: string,
  attrs: { name: string; dtype?: string; shape?: string | null; card?: string | null }[],
  methods: string[]
) {
  const MAX_A = 18;
  const MAX_M = 14;
  const shownA = attrs.slice(0, MAX_A);
  const shownM = methods.slice(0, MAX_M);

  const attrLines = shownA.map(a => {
    const parts = [a.name];
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
  if (methods.length) {
    lines.push("────────────", ...methodLines, ...moreM);
  }
  return lines.join("\n");
}

export default function GraphView({ nodes, edges }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);

  const { sectionsMap, attrsMap, methodsMap, compEdges } = useMemo(() => {
    const sections = new Map<string, RawNode>();
    const attrs = new Map<string, { name: string; dtype?: string; shape?: string | null; card?: string | null }[]>();
    const methods = new Map<string, string[]>();

    for (const n of nodes) {
      if (n.kind === "section") {
        sections.set(n.id, n);
        attrs.set(n.id, attrs.get(n.id) ?? []);
        methods.set(n.id, (n.methods ?? []) as string[]);
      } else if (n.kind === "quantity" && n.owner) {
        const list = attrs.get(n.owner) ?? [];
        list.push({
          name: n.label,
          dtype: n.dtype ?? undefined,
          shape: n.shape ?? undefined,
          card: n.card ?? undefined
        });
        attrs.set(n.owner, list);
      }
    }

    const subs = edges.filter(e => e.type === "hasSubSection");
    return { sectionsMap: sections, attrsMap: attrs, methodsMap: methods, compEdges: subs };
  }, [nodes, edges]);

  useEffect(() => {
    if (!containerRef.current) return;
    cyRef.current?.destroy();
    cyRef.current = null;

    // --- Build Cytoscape graph ---
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
          module: sec.module ?? ""
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
            "shape": "round-rectangle",
            "background-color": "#f5f7fa",
            "border-color": "#0f172a",
            "border-width": 1.5,
            "color": "#0f172a",
            "label": "data(label)",
            "text-wrap": "wrap",
            "text-max-width": 280,
            "font-size": 12,
            "font-family": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
            "padding": "8px",
            "text-halign": "center",
            "text-valign": "center",
            "width": "label",
            "height": "label",
            "shadow-blur": 12,
            "shadow-color": "#94a3b8",
            "shadow-offset-x": 2,
            "shadow-offset-y": 4
          }
        },
        {
          selector: "edge[type='composition']",
          style: {
            "line-color": "#475569",
            "width": 2,
            "curve-style": "segments",
            "source-arrow-shape": "diamond",
            "source-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#475569",
            "arrow-scale": 1.1,
            "label": "data(card)",
            "font-size": 10,
            "text-rotation": "autorotate",
            "text-margin-y": -6,
            "text-background-color": "#f5f7fa",
            "text-background-opacity": 1,
            "text-background-padding": 2
          }
        },
        { selector: ".hidden", style: { "display": "none" } },
        { selector: ":selected", style: { "border-width": 3, "border-color": "#2563eb" } }
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

    cyRef.current = cy;

    // --- Build indegree map for composition edges ---
    const indeg = new Map<string, number>();
    cy.$("node").forEach(n => indeg.set(n.id(), 0));
    cy.$("edge[type='composition']").forEach((e: EdgeSingular) => {
      const t = e.target().id();
      indeg.set(t, (indeg.get(t) ?? 0) + 1);
    });

    // --- Initial collapsed state ---
    cy.$("edge[type='composition']").addClass("hidden");

    // Hide only leaves (no children, but indegree > 0)
    cy.$("node").forEach((n: NodeSingular) => {
      const hasKids = n.outgoers().edges().filter(e => e.data("type") === "composition").length > 0;
      const isNonRoot = (indeg.get(n.id()) ?? 0) > 0;
      if (isNonRoot && !hasKids) n.addClass("hidden");
    });

    // Add ▸ to nodes that have children
    cy.$("node").forEach((n: NodeSingular) => {
      const hasKids = n.outgoers().edges().filter(e => e.data("type") === "composition").length > 0;
      if (!hasKids) return;
      const id = n.id();
      const rawName: string = n.data("rawName") || "";
      const attrs = attrsMap.get(id) ?? [];
      const methods = methodsMap.get(id) ?? [];
      n.data("label", umlLabel(`▸ ${rawName}`, attrs, methods));
    });

    // --- Helpers ---
    const relayout = () => {
      cy.layout({
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
      } as any).run();
    };

    const setIndicator = (node: NodeSingular, open: boolean) => {
      const id = node.id();
      const rawName: string = node.data("rawName") || "";
      const attrs = attrsMap.get(id) ?? [];
      const methods = methodsMap.get(id) ?? [];
      const prefix = open ? "▾ " : "▸ ";
      node.data("label", umlLabel(prefix + rawName, attrs, methods));
    };

    const expand = (node: NodeSingular) => {
      const outEdges = node.outgoers().edges().filter(e => e.data("type") === "composition");
      const children = outEdges.targets();
      if (outEdges.length === 0) return;
      outEdges.removeClass("hidden");
      children.removeClass("hidden");
      setIndicator(node, true);
    };

    const collapse = (node: NodeSingular) => {
      const outEdges = node.outgoers().edges().filter(e => e.data("type") === "composition");
      const children = outEdges.targets();
      children.forEach((c: NodeSingular) => collapse(c));
      outEdges.addClass("hidden");
      children.addClass("hidden");
      setIndicator(node, false);
    };

    // --- Click handler ---
    cy.on("tap", "node", (evt) => {
      const n = evt.target as NodeSingular;
      const outEdges = n.outgoers().edges().filter(e => e.data("type") === "composition");
      if (outEdges.length === 0) return;

      const children = outEdges.targets();
      const edgesHidden = outEdges.filter(".hidden").length > 0;
      const kidsHidden  = children.filter(".hidden").length > 0;
      const isCollapsed = edgesHidden || kidsHidden;

      if (isCollapsed) expand(n);
      else collapse(n);

      relayout();
    });

    return () => { cyRef.current?.destroy(); };
  }, [sectionsMap, attrsMap, methodsMap, compEdges]);

  return <div className="graph" ref={containerRef} />;
}

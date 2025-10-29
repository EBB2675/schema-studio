import React, { useEffect, useMemo, useRef } from "react";
import cytoscape from "cytoscape";
import elk from "elkjs/lib/elk.bundled.js";
import cytoscapeElk from "cytoscape-elk";
import type { Core, ElementDefinition } from "cytoscape";

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
  // m_str(str) -> str, m_float64(float64) -> float64, m_int(int) -> int, etc.
  const m = t.match(/^m_[a-zA-Z0-9_]+\((.+)\)$/);
  if (m) return m[1];
  // remove leading m_ if plain
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

  // Group quantities by owner section + collect section methods (if provided)
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
        list.push({ name: n.label, dtype: n.dtype ?? undefined, shape: n.shape ?? undefined, card: n.card ?? undefined });
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

    const elements: ElementDefinition[] = [];
    for (const [secId, sec] of sectionsMap.entries()) {
      const attrs = attrsMap.get(secId) ?? [];
      const methods = methodsMap.get(secId) ?? [];
      elements.push({
        data: {
          id: secId,
          label: umlLabel(sec.label, attrs, methods),
          kind: "uml_class",
          module: sec.module ?? "",
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

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.2,
      maxZoom: 3.5,
      wheelSensitivity: 0.2,
      style: [
        // sleek 3D-ish class node
        {
          selector: "node[kind='uml_class']",
          style: {
            "shape": "round-rectangle",
            "background-color": "#f5f7fa",      // light silver
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
            // 3D effect
            "shadow-blur": 12,
            "shadow-color": "#94a3b8",
            "shadow-offset-x": 2,
            "shadow-offset-y": 4
          }
        },
        // composition edge (hasSubSection)
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

    // simple node click info
    cyRef.current.on("tap", "node", (evt) => {
      const n = evt.target;
      const head = String(n.data("label") || "").split("\n")[0];
      const module = n.data("module") || "";
      alert(`${head}${module ? `\n\n${module}` : ""}`);
    });

    return () => { cyRef.current?.destroy(); };
  }, [sectionsMap, attrsMap, methodsMap, compEdges]);

  return <div className="graph" ref={containerRef} />;
}
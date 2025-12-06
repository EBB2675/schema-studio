import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { Core, ElementDefinition, LayoutOptions } from 'cytoscape';
import elk from 'cytoscape-elk';
import { useSelection } from '../store/selection';
import type { GraphPayload, GraphNodeData, GraphEdgeData } from '../types';

cytoscape.use(elk);

async function fetchGraph(): Promise<GraphPayload> {
  // Adjust to backend route if different
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('schema-uml-token') : '';
  const res = await fetch('/api/graph', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`Graph fetch failed: ${res.status}`);
  const payload = (await res.json()) as GraphPayload;

  // Minimal sanity
  payload.nodes.forEach(n => {
    if (!n.id) throw new Error('Node without id encountered');
  });
  payload.edges.forEach(e => {
    if (!e.id) e.id = `${e.source}->${e.target}`;
  });
  return payload;
}

function toCyElements(payload: GraphPayload): ElementDefinition[] {
  const nodeEles: ElementDefinition[] = payload.nodes.map((n: GraphNodeData) => ({
    data: {
      id: n.id,
      name: n.name,
      kind: n.kind,
      doc: n.doc ?? '',
      path: n.path ?? '',
      line: n.line ?? undefined,
    },
    classes: n.kind, // "class" | "quantity" for styling
  }));

  const edgeEles: ElementDefinition[] = payload.edges.map((e: GraphEdgeData) => ({
    data: { id: e.id, source: e.source, target: e.target },
  }));

  return [...nodeEles, ...edgeEles];
}

export default function Graph() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const setSelected = useSelection(s => s.setSelected);

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const payload = await fetchGraph();
      if (!alive) return;
      const elements = toCyElements(payload);

      const cy = cytoscape({
        container: containerRef.current!,
        elements,
        layout: {
          name: 'elk',
          elk: { algorithm: 'layered', 'elk.direction': 'RIGHT' },
        } as LayoutOptions,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#e2e8f0',
              'border-width': 1,
              'border-color': '#94a3b8',
              label: 'data(name)',
              'text-wrap': 'wrap',
              'text-max-width': '160px',
              'font-size': 12,
              padding: '8px',
            },
          },
          {
            selector: 'node.class',
            style: {
              'shape': 'round-rectangle',
              'background-color': '#f1f5f9',
              'border-color': '#64748b',
              'font-weight': 600,
            },
          },
          {
            selector: 'node.quantity',
            style: {
              'shape': 'round-rectangle',
              'background-color': '#eef2ff',
              'border-color': '#6366f1',
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': '#cbd5e1',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': '#cbd5e1',
              'curve-style': 'bezier',
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-color': '#0ea5e9',
              'border-width': 2,
              'background-color': '#dbeafe',
            },
          },
        ],
        wheelSensitivity: 0.2,
      });

      cy.on('tap', 'node', evt => {
        const d = evt.target.data();
        setSelected({
          id: d.id,
          name: d.name,
          kind: d.kind,
          doc: d.doc || '',
          path: d.path || '',
          line: typeof d.line === 'number' ? d.line : undefined,
        });
      });

      cy.on('tap', evt => {
        if (evt.target === cy) {
          setSelected(null);
        }
      });

      cyRef.current = cy;
    };

    init().catch(err => {
      // eslint-disable-next-line no-console
      console.error(err);
    });

    return () => {
      alive = false;
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
  }, [setSelected]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
      }}
    />
  );
}

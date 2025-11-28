export type GraphNodeData = {
  id: string;
  name: string;
  kind: 'class' | 'quantity';
  doc?: string | null;
  path?: string | null;
  line?: number | null;
};

export type GraphEdgeData = {
  id?: string;
  source: string;
  target: string;
};

export type GraphPayload = {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
};

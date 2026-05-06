import type { WorkspaceState } from "./workspace";

export type ApiNode = {
  id: string;
  kind: "section" | "quantity";
  label: string;
  module?: string | null;
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

export type ApiEdge = {
  source: string;
  target: string;
  type: "hasQuantity" | "hasSubSection" | "inherits";
  card?: string | null;
};

export type ApiGraph = {
  package: string;
  root: string | null;
  nodes: ApiNode[];
  edges: ApiEdge[];
  workspace?: WorkspaceState;
  applied_edits?: AppliedEdit[];
};

export type BranchGraphPayload = {
  branch: string;
  sha: string;
  graph: ApiGraph;
};

export type DiffResponse = {
  base: BranchGraphPayload;
  head: BranchGraphPayload;
  diff: {
    nodes: { added: ApiNode[]; removed: ApiNode[]; changed: { id: string; before?: ApiNode; after?: ApiNode }[] };
    edges: { added: ApiEdge[]; removed: ApiEdge[] };
  };
  workspace?: WorkspaceState;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown) => (typeof v === "string" ? v : "");

export type AppliedEdit = {
  id?: string;
  user_id?: string;
  branch?: string;
  package?: string;
  class_name: string;
  quantity_name?: string | null;
  dtype?: string | null;
  docstring?: string | null;
  parent_name?: string | null;
  parent_relation?: string | null;
  card?: string | null;
  edit_type: "class" | "quantity";
  base_sha?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

const ensureAppliedEdit = (value: unknown): AppliedEdit => {
  if (!isRecord(value)) {
    throw new Error("Applied edit is not an object");
  }
  const edit_type = value.edit_type;
  if (edit_type !== "class" && edit_type !== "quantity") {
    throw new Error(`Unexpected edit_type: ${String(edit_type)}`);
  }
  const class_name = asString(value.class_name);
  if (!class_name) {
    throw new Error("Applied edit missing class_name");
  }
  const quantity_name_raw = value.quantity_name;
  if (edit_type === "quantity" && (typeof quantity_name_raw !== "string" || !quantity_name_raw)) {
    throw new Error("Applied quantity edit missing quantity_name");
  }

  return {
    id: asString(value.id) || undefined,
    user_id: asString(value.user_id) || undefined,
    branch: asString(value.branch) || undefined,
    package: asString(value.package) || undefined,
    class_name,
    quantity_name: typeof value.quantity_name === "string" ? value.quantity_name : null,
    dtype: typeof value.dtype === "string" ? value.dtype : null,
    docstring: typeof value.docstring === "string" ? value.docstring : null,
    parent_name: typeof value.parent_name === "string" ? value.parent_name : null,
    parent_relation: typeof value.parent_relation === "string" ? value.parent_relation : null,
    card: typeof value.card === "string" ? value.card : null,
    edit_type,
    base_sha: typeof value.base_sha === "string" ? value.base_sha : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
};

const ensureWorkspace = (value: unknown): WorkspaceState | undefined => {
  if (!isRecord(value)) return undefined;
  const branch = asString(value.branch);
  const pkg = asString(value.package);
  const base_namespace = asString(value.base_namespace);
  if (!branch && !pkg && !base_namespace) return undefined;
  return { branch, package: pkg, base_namespace };
};

const ensureNode = (node: unknown): ApiNode => {
  if (!isRecord(node)) throw new Error("Node is not an object");
  const kind = node.kind;
  if (kind !== "section" && kind !== "quantity") {
    throw new Error(`Unexpected node kind: ${String(kind)}`);
  }
  const id = asString(node.id);
  if (!id) throw new Error("Node is missing id");
  const label = asString(node.label) || id;
  const module = typeof node.module === "string" ? node.module : null;
  const dtype = typeof node.dtype === "string" ? node.dtype : null;
  const dataType = typeof node.data_type === "string" ? node.data_type : null;
  const type = typeof node.type === "string" ? node.type : null;
  const shape = typeof node.shape === "string" ? node.shape : null;
  const card = typeof node.card === "string" ? node.card : null;
  const owner = typeof node.owner === "string" ? node.owner : null;
  const doc = typeof node.doc === "string" ? node.doc : null;
  const path = typeof node.path === "string" ? node.path : null;
  const line = typeof node.line === "number" ? node.line : null;
  return {
    id,
    kind,
    label,
    module,
    dtype,
    data_type: dataType,
    type,
    shape,
    card,
    owner,
    doc,
    methods: Array.isArray(node.methods) ? node.methods.map(asString) : null,
    path,
    line,
  };
};

const ensureEdge = (edge: unknown): ApiEdge => {
  if (!isRecord(edge)) throw new Error("Edge is not an object");
  const source = asString(edge.source);
  const target = asString(edge.target);
  const type = edge.type;
  if (!source || !target) throw new Error("Edge is missing endpoints");
  if (type !== "hasQuantity" && type !== "hasSubSection" && type !== "inherits") {
    throw new Error(`Unexpected edge type: ${String(type)}`);
  }
  return {
    source,
    target,
    type,
    card: typeof edge.card === "string" ? edge.card : null,
  };
};

export const ensureGraphResponse = (payload: unknown): ApiGraph => {
  if (!isRecord(payload)) throw new Error("Graph response is not an object");
  const nodesRaw = payload.nodes;
  const edgesRaw = payload.edges;
  if (!Array.isArray(nodesRaw) || !Array.isArray(edgesRaw)) {
    throw new Error("Graph response missing nodes or edges");
  }
  const pkg = asString(payload.package);
  if (!pkg) throw new Error("Graph response missing package");
  const root = payload.root === null || typeof payload.root === "string" ? payload.root : null;

  return {
    package: pkg,
    root,
    nodes: nodesRaw.map(ensureNode),
    edges: edgesRaw.map(ensureEdge),
    workspace: ensureWorkspace(payload.workspace),
    applied_edits: Array.isArray(payload.applied_edits)
      ? payload.applied_edits.map(ensureAppliedEdit)
      : undefined,
  };
};

const ensureBranchGraphPayload = (value: unknown): BranchGraphPayload => {
  if (!isRecord(value)) throw new Error("Branch payload is not an object");
  const branch = asString(value.branch);
  const sha = asString(value.sha);
  if (!branch || !sha) throw new Error("Branch payload missing branch or sha");
  return {
    branch,
    sha,
    graph: ensureGraphResponse(value.graph),
  };
};

export const ensureDiffResponse = (payload: unknown): DiffResponse => {
  if (!isRecord(payload)) throw new Error("Diff response is not an object");
  const diff = payload.diff;
  if (!isRecord(diff)) throw new Error("Diff response missing diff block");

  const nodes = diff.nodes;
  const edges = diff.edges;
  if (!isRecord(nodes) || !isRecord(edges)) throw new Error("Diff response missing node/edge diffs");

  const addedNodes = Array.isArray(nodes.added) ? nodes.added.map(ensureNode) : [];
  const removedNodes = Array.isArray(nodes.removed) ? nodes.removed.map(ensureNode) : [];
  const changedNodes = Array.isArray(nodes.changed)
    ? nodes.changed.map((c: unknown) => {
        if (!isRecord(c)) {
          return { id: asString((c as Record<string, unknown>)?.id) };
        }
        const id = asString(c.id);
        const result: { id: string; before?: ApiNode; after?: ApiNode } = { id };
        if ("before" in c && c.before != null) {
          result.before = ensureNode(c.before);
        }
        if ("after" in c && c.after != null) {
          result.after = ensureNode(c.after);
        }
        return result;
      })
    : [];

  const addedEdges = Array.isArray(edges.added) ? edges.added.map(ensureEdge) : [];
  const removedEdges = Array.isArray(edges.removed) ? edges.removed.map(ensureEdge) : [];

  return {
    base: ensureBranchGraphPayload(payload.base),
    head: ensureBranchGraphPayload(payload.head),
    diff: {
      nodes: { added: addedNodes, removed: removedNodes, changed: changedNodes },
      edges: { added: addedEdges, removed: removedEdges },
    },
    workspace: ensureWorkspace(payload.workspace),
  };
};

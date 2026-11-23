import type { WorkspaceState } from "./workspace";

// Source facts about a node beyond the graph itself, shown in the doc panel.
// bam-masterdata nodes carry them (openBIS code, label, German texts, ...).
export type NodeDetails = {
  code?: string;
  title?: string;
  titleDe?: string;
  docDe?: string;
  mandatory?: boolean;
  section?: string;
  iri?: string;
  unit?: string;
};

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
  subclasses?: number | null;
  path?: string | null;
  line?: number | null;
  details?: NodeDetails | null;
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
  // Stored edits that did not apply cleanly to this schema (or applied over an upstream change).
  edit_conflicts?: EditConflict[];
  // The edits a POST /schema/edits just stored.
  persisted_edits?: AppliedEdit[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown) => (typeof v === "string" ? v : "");

// A stored schema edit: an operation on the LinkML schema (see api/sources/edits.py).
export type AppliedEdit = {
  id?: string;
  op: string;
  target: string;
  payload: Record<string, unknown>;
  profile?: string;
  package?: string;
  commit?: string | null;
  created_at?: string | null;
};

export type EditConflict = {
  edit: AppliedEdit;
  reason: string;
  detail: string;
  // True when the edit was applied anyway (the source changed what it replaces).
  applied: boolean;
};

const ensureAppliedEdit = (value: unknown): AppliedEdit => {
  if (!isRecord(value)) {
    throw new Error("Applied edit is not an object");
  }
  const op = asString(value.op);
  if (!op) {
    throw new Error("Applied edit missing op");
  }
  const id = typeof value.id === "number" ? String(value.id) : asString(value.id);
  return {
    id: id || undefined,
    op,
    target: asString(value.target),
    payload: isRecord(value.payload) ? value.payload : {},
    profile: asString(value.profile) || undefined,
    package: asString(value.package) || undefined,
    commit: typeof value.commit === "string" ? value.commit : null,
    created_at: typeof value.created_at === "string" ? value.created_at : null,
  };
};

const ensureEditConflict = (value: unknown): EditConflict | null => {
  if (!isRecord(value)) return null;
  try {
    return {
      edit: ensureAppliedEdit(value.edit),
      reason: asString(value.reason),
      detail: asString(value.detail),
      applied: value.applied === true,
    };
  } catch {
    return null;
  }
};

const ensureWorkspace = (value: unknown): WorkspaceState | undefined => {
  if (!isRecord(value)) return undefined;
  const branch = asString(value.branch);
  const pkg = asString(value.package);
  const base_namespace = asString(value.base_namespace);
  if (!branch && !pkg && !base_namespace) return undefined;
  return { branch, package: pkg, base_namespace };
};

const optionalString = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// Only nodes with an openBIS code have details; units alone (NOMAD quantities) are not shown yet.
const ensureDetails = (node: Record<string, unknown>): NodeDetails | null => {
  const code = optionalString(node.code);
  if (!code) return null;
  const details: NodeDetails = {
    code,
    title: optionalString(node.title),
    titleDe: optionalString(node.title_de),
    docDe: optionalString(node.doc_de),
    mandatory: typeof node.mandatory === "boolean" ? node.mandatory : undefined,
    section: optionalString(node.section),
    iri: optionalString(node.iri),
    unit: optionalString(node.unit),
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as NodeDetails;
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
  const subclasses = typeof node.subclasses === "number" ? node.subclasses : null;
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
    subclasses,
    details: ensureDetails(node),
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
    edit_conflicts: Array.isArray(payload.edit_conflicts)
      ? payload.edit_conflicts.map(ensureEditConflict).filter((item): item is EditConflict => item !== null)
      : undefined,
    persisted_edits: Array.isArray(payload.persisted_edits)
      ? payload.persisted_edits.map(ensureAppliedEdit)
      : undefined,
  };
};

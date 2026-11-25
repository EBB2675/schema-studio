import type { ApiEdge, ApiGraph, ApiNode } from "../types/api";
import type { AuditTrailEntry, QuantityNode, UmlClassNode } from "../types/uml";

// Replay local history against a graph snapshot without mutating the baseline.
// Persisted edits are already applied by the Python core and must be excluded by callers.
const removeQuantityFromGraphState = (g: ApiGraph, quantityId: string): ApiGraph => {
  const nodes = (g.nodes || []).filter((n) => n.id !== quantityId);
  const edges = (g.edges || []).filter((e) => e.source !== quantityId && e.target !== quantityId);
  return { ...g, nodes, edges };
};

const addQuantityToGraphState = (g: ApiGraph, quantity: QuantityNode): ApiGraph => {
  const qNode: ApiNode = {
    id: quantity.id,
    kind: "quantity",
    label: quantity.name,
    dtype: quantity.dtype,
    shape: quantity.shape ?? undefined,
    card: quantity.card ?? undefined,
    doc: quantity.doc ?? null,
    owner: quantity.ownerId,
    path: quantity.path ?? undefined,
    line: quantity.line ?? undefined,
  };
  const hasNode = (g.nodes || []).some((n) => n.id === quantity.id);
  const nodes: ApiNode[] = hasNode
    ? (g.nodes || []).map((n) => (n.id === quantity.id ? { ...n, ...qNode } : n))
    : [...(g.nodes || []), qNode];
  const edgeExists = (g.edges || []).some((e) => e.source === quantity.ownerId && e.target === quantity.id);
  const edges: ApiEdge[] = edgeExists
    ? g.edges || []
    : [...(g.edges || []), { source: quantity.ownerId, target: quantity.id, type: "hasQuantity" as const, card: quantity.card ?? null }];
  return { ...g, nodes, edges };
};

const removeClassFromGraphState = (g: ApiGraph, classId: string): ApiGraph => {
  const removedQuantityIds = (g.nodes || []).filter((n) => n.owner === classId).map((n) => n.id);
  const nodes = (g.nodes || []).filter(
    (n) => n.id !== classId && !removedQuantityIds.includes(n.id)
  );
  const edges = (g.edges || []).filter(
    (e) =>
      e.source !== classId &&
      e.target !== classId &&
      !removedQuantityIds.includes(e.source) &&
      !removedQuantityIds.includes(e.target)
  );
  return { ...g, nodes, edges };
};

const editClassInGraphState = (g: ApiGraph, cls: UmlClassNode): ApiGraph => {
  const nodes = (g.nodes || []).map((n) => {
    if (n.kind !== "section" || n.id !== cls.id) return n;
    return { ...n, doc: cls.doc ?? null };
  });
  return { ...g, nodes };
};

const addClassToGraphState = (g: ApiGraph, cls: UmlClassNode): ApiGraph => {
  const nodesWithoutClass = (g.nodes || []).filter((n) => !(n.kind === "section" && n.id === cls.id));
  const sectionNode: ApiNode = {
    id: cls.id,
    kind: "section",
    label: cls.name,
    module: cls.module ?? g.package,
    doc: cls.doc ?? null,
    path: cls.path ?? null,
    line: cls.line ?? null,
  };
  const ownedQuantities = cls.quantities.filter((q) => !q.inherited);
  const qtyNodes: ApiNode[] = ownedQuantities.map((q) => ({
    id: q.id,
    kind: "quantity",
    label: q.name,
    dtype: q.dtype,
    shape: q.shape ?? undefined,
    card: q.card ?? undefined,
    doc: q.doc ?? null,
    owner: q.ownerId,
    path: q.path ?? undefined,
    line: q.line ?? undefined,
  }));
  const qtyEdges: ApiEdge[] = ownedQuantities.map((q) => ({
    source: q.ownerId,
    target: q.id,
    type: "hasQuantity" as const,
    card: q.card ?? null,
  }));
  const relationType: ApiEdge["type"] = cls.parentRelation === "hasSubSection" ? "hasSubSection" : "inherits";
  const parentLinkEdge: ApiEdge[] = cls.parentId
    ? relationType === "inherits"
      ? [{ source: cls.id, target: cls.parentId, type: relationType, card: null }]
      : [{ source: cls.parentId, target: cls.id, type: relationType, card: cls.parentCard ?? null }]
    : [];

  return {
    ...g,
    nodes: [...nodesWithoutClass, sectionNode, ...qtyNodes],
    edges: [
      ...(g.edges || []).filter(
        (e) =>
          !((e.type === "inherits" && e.source === cls.id) || (e.type === "hasSubSection" && e.target === cls.id))
      ),
      ...qtyEdges,
      ...parentLinkEdge
    ],
  };
};

export const applyForwardChange = (current: ApiGraph, change: AuditTrailEntry["change"]): ApiGraph => {
  switch (change.type) {
    case "add-class":
      return addClassToGraphState(current, change.cls);
    case "remove-class":
      return removeClassFromGraphState(current, change.cls.id);
    case "edit-class":
      return editClassInGraphState(current, change.after);
    case "add-quantity":
      return addQuantityToGraphState(current, change.quantity);
    case "remove-quantity":
      return removeQuantityFromGraphState(current, change.quantity.id);
    case "edit-quantity": {
      const withoutBefore = removeQuantityFromGraphState(current, change.before.id);
      return addQuantityToGraphState(withoutBefore, change.after);
    }
    default:
      return current;
  }
};


import type { ApiEdge, ApiGraph, ApiNode } from "../types/api";
import type { QuantityNode, UmlClassNode, UmlEdge, UmlGraphState } from "../types/uml";
import { normalizeId, normalizeLabel, normalizeModule } from "./identifier";

const toBaseQuantityNode = (n: ApiNode): QuantityNode => {
  const id = normalizeId(n.id);
  const ownerId = normalizeId(n.owner);
  const fallbackName = id.split(".").pop() || id;
  return {
    id,
    name: normalizeLabel(n.label, fallbackName),
    dtype: n.dtype ?? n.data_type ?? n.type ?? undefined,
    shape: n.shape ?? null,
    card: n.card ?? null,
    doc: n.doc ?? null,
    path: n.path ?? null,
    line: typeof n.line === "number" ? n.line : null,
    ownerId,
    inherited: false,
    inheritedFromId: null,
    inheritedFromName: null,
    sourceId: id,
  };
};

const asRelation = (value: string): "inherits" | "hasSubSection" | null => {
  if (value === "inherits") return "inherits";
  if (value === "hasSubSection") return "hasSubSection";
  return null;
};

const edgeKey = (edge: Pick<UmlEdge, "source" | "target" | "type">): string =>
  `${edge.source}|${edge.target}|${edge.type}`;

const isLikelyOverride = (child: QuantityNode, parent: QuantityNode): boolean => {
  // Path/line can legitimately differ for flattened inherited quantities.
  // Only treat semantic metadata changes as an explicit override signal.
  if (child.dtype && parent.dtype && child.dtype !== parent.dtype) return true;
  if (child.shape && parent.shape && child.shape !== parent.shape) return true;
  if (child.card && parent.card && child.card !== parent.card) return true;
  return false;
};

const inheritedQuantityFrom = (classId: string, source: QuantityNode, sectionNameById: Map<string, string>): QuantityNode => {
  const sourceId = source.sourceId || source.id;
  const originId = source.inherited ? source.inheritedFromId || source.ownerId : source.ownerId;
  const fallbackOrigin = originId || null;
  const inheritedFromName =
    (fallbackOrigin && sectionNameById.get(fallbackOrigin)) ||
    (fallbackOrigin ? fallbackOrigin.split(".").pop() || fallbackOrigin : null);
  return {
    id: `${classId}::inherited::${sourceId}`,
    name: source.name,
    dtype: source.dtype,
    shape: source.shape ?? null,
    card: source.card ?? null,
    doc: source.doc ?? null,
    path: source.path ?? null,
    line: typeof source.line === "number" ? source.line : null,
    ownerId: classId,
    inherited: true,
    inheritedFromId: fallbackOrigin,
    inheritedFromName,
    sourceId,
  };
};

export const buildUmlStateFromGraph = (g: ApiGraph | null): UmlGraphState | null => {
  if (!g) return null;

  const nodes = g.nodes || [];
  const edges = g.edges || [];

  const normalizedEdges: UmlEdge[] = edges
    .map((e: ApiEdge) => ({
      source: normalizeId(e.source),
      target: normalizeId(e.target),
      type: e.type,
      card: e.card ?? null,
    }))
    .filter((e) => e.source && e.target && e.type);

  const sections = nodes.filter((n) => n.kind === "section");
  const sectionIds = new Set(sections.map((s) => normalizeId(s.id)));
  const sectionNameById = new Map<string, string>();
  sections.forEach((sec) => {
    const id = normalizeId(sec.id);
    sectionNameById.set(id, normalizeLabel(sec.label, id));
  });

  const ownedQuantitiesByClass = new Map<string, QuantityNode[]>();
  nodes
    .filter((n) => n.kind === "quantity")
    .map((q) => toBaseQuantityNode(q))
    .forEach((q) => {
      if (!q.ownerId || !sectionIds.has(q.ownerId)) return;
      const list = ownedQuantitiesByClass.get(q.ownerId) ?? [];
      list.push(q);
      ownedQuantitiesByClass.set(q.ownerId, list);
    });

  const parentsByChild = new Map<string, string[]>();
  const parentInfoByChild = new Map<string, { id: string; relation: "inherits" | "hasSubSection" }>();

  normalizedEdges.forEach((e) => {
    const relation = asRelation(e.type);
    if (!relation) return;
    if (!sectionIds.has(e.source) || !sectionIds.has(e.target)) return;

    const childId = relation === "inherits" ? e.source : e.target;
    const parentId = relation === "inherits" ? e.target : e.source;

    const existing = parentInfoByChild.get(childId);
    if (!existing || (relation === "inherits" && existing.relation !== "inherits")) {
      parentInfoByChild.set(childId, { id: parentId, relation });
    }

    if (relation === "inherits") {
      const parents = parentsByChild.get(childId) ?? [];
      if (!parents.includes(parentId)) {
        parents.push(parentId);
        parentsByChild.set(childId, parents);
      }
    }
  });

  const effectiveQuantitiesMemo = new Map<string, QuantityNode[]>();
  const effectiveSubsectionsMemo = new Map<string, UmlEdge[]>();
  const quantityPath = new Set<string>();
  const subsectionPath = new Set<string>();

  const effectiveQuantitiesFor = (classId: string): QuantityNode[] => {
    const cached = effectiveQuantitiesMemo.get(classId);
    if (cached) return cached;

    const own = (ownedQuantitiesByClass.get(classId) ?? []).map((q) => ({ ...q, ownerId: classId }));
    if (quantityPath.has(classId)) {
      effectiveQuantitiesMemo.set(classId, own);
      return own;
    }

    quantityPath.add(classId);

    const parents = parentsByChild.get(classId) ?? [];
    const inheritedFromParents: QuantityNode[] = [];
    parents.forEach((parentId) => {
      inheritedFromParents.push(...effectiveQuantitiesFor(parentId));
    });

    const parentByName = new Map<string, QuantityNode>();
    inheritedFromParents.forEach((q) => {
      if (!parentByName.has(q.name)) {
        parentByName.set(q.name, q);
      }
    });

    const byName = new Map<string, QuantityNode>();
    own.forEach((q) => {
      const parentMatch = parentByName.get(q.name);
      if (parentMatch && !isLikelyOverride(q, parentMatch)) {
        byName.set(q.name, inheritedQuantityFrom(classId, parentMatch, sectionNameById));
        return;
      }
      byName.set(q.name, q);
    });

    parents.forEach((parentId) => {
      const inheritedFromParent = effectiveQuantitiesFor(parentId);
      inheritedFromParent.forEach((pq) => {
        if (byName.has(pq.name)) return;
        byName.set(pq.name, inheritedQuantityFrom(classId, pq, sectionNameById));
      });
    });

    const effective = Array.from(byName.values());
    quantityPath.delete(classId);
    effectiveQuantitiesMemo.set(classId, effective);
    return effective;
  };

  const directSubsectionsByClass = new Map<string, UmlEdge[]>();
  normalizedEdges.forEach((e) => {
    if (e.type !== "hasSubSection") return;
    if (!sectionIds.has(e.source) || !sectionIds.has(e.target)) return;
    const list = directSubsectionsByClass.get(e.source) ?? [];
    list.push(e);
    directSubsectionsByClass.set(e.source, list);
  });

  const effectiveSubsectionsFor = (classId: string): UmlEdge[] => {
    const cached = effectiveSubsectionsMemo.get(classId);
    if (cached) return cached;

    const own = (directSubsectionsByClass.get(classId) ?? []).map((e) => ({ ...e, source: classId }));
    if (subsectionPath.has(classId)) {
      effectiveSubsectionsMemo.set(classId, own);
      return own;
    }

    subsectionPath.add(classId);

    const byTarget = new Map<string, UmlEdge>();
    own.forEach((edge) => byTarget.set(edge.target, edge));

    const parents = parentsByChild.get(classId) ?? [];
    parents.forEach((parentId) => {
      const inheritedFromParent = effectiveSubsectionsFor(parentId);
      inheritedFromParent.forEach((edge) => {
        if (edge.target === classId) return;
        if (byTarget.has(edge.target)) return;
        byTarget.set(edge.target, {
          source: classId,
          target: edge.target,
          type: "hasSubSection",
          card: edge.card ?? null,
        });
      });
    });

    const effective = Array.from(byTarget.values());
    subsectionPath.delete(classId);
    effectiveSubsectionsMemo.set(classId, effective);
    return effective;
  };

  const classList: UmlClassNode[] = sections.map((sec) => {
    const id = normalizeId(sec.id);
    const parentInfo = parentInfoByChild.get(id);
    return {
      id,
      name: normalizeLabel(sec.label, id),
      doc: sec.doc ?? null,
      module: normalizeModule(sec.module) || sec.module || null,
      path: sec.path ?? null,
      line: typeof sec.line === "number" ? sec.line : null,
      quantities: effectiveQuantitiesFor(id),
      parentId: parentInfo?.id ?? null,
      parentRelation: parentInfo?.relation ?? null,
    };
  });

  const allEdges: UmlEdge[] = [...normalizedEdges];
  const seenEdgeKeys = new Set<string>(allEdges.map(edgeKey));
  classList.forEach((cls) => {
    effectiveSubsectionsFor(cls.id).forEach((edge) => {
      const key = edgeKey(edge);
      if (seenEdgeKeys.has(key)) return;
      seenEdgeKeys.add(key);
      allEdges.push(edge);
    });
  });

  return {
    package: normalizeModule(g.package) || g.package,
    root: g.root ? normalizeLabel(g.root, g.root) : null,
    classes: classList,
    edges: allEdges,
  };
};

type Edge = { source: string; target: string; type: string; card?: string | null };

/**
 * The edges worth drawing on the canvas.
 *
 * The graph links each class to every ancestor; drawn as is, a deep hierarchy
 * gets an arrow from each class to each class above it. An inheritance edge
 * A -> C is left out when A reaches C through another of its parents, so each
 * class points only at its nearest classes on the canvas. A class in between
 * that is not drawn takes no part, so A keeps its edge to C then.
 *
 * Subclasses inherit their bases' subsections, and the graph links each of
 * them to the subsection's class too. A subsection edge A -> T is left out
 * when an ancestor of A on the canvas has the same edge, so it is drawn only
 * from the class that declares it. A subclass that declares the subsection
 * again with another cardinality keeps its edge.
 */
export function canvasEdges<E extends Edge>(edges: E[]): E[] {
  const parents = new Map<string, Set<string>>();
  edges.forEach((e) => {
    if (e.type !== "inherits" || e.source === e.target) return;
    const set = parents.get(e.source) ?? new Set<string>();
    set.add(e.target);
    parents.set(e.source, set);
  });

  const ancestorsMemo = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const known = ancestorsMemo.get(id);
    if (known) return known;
    const found = new Set<string>();
    ancestorsMemo.set(id, found); // guards against cycles
    parents.get(id)?.forEach((parent) => {
      found.add(parent);
      ancestors(parent).forEach((a) => found.add(a));
    });
    return found;
  };

  const subsectionKey = (source: string, e: E) => `${source}|${e.target}|${e.card ?? ""}`;
  const subsections = new Set(
    edges.filter((e) => e.type === "hasSubSection").map((e) => subsectionKey(e.source, e))
  );

  return edges.filter((e) => {
    if (e.type === "hasSubSection") {
      return ![...ancestors(e.source)].some((a) => subsections.has(subsectionKey(a, e)));
    }
    if (e.type !== "inherits") return true;
    const others = [...(parents.get(e.source) ?? [])].filter((p) => p !== e.target);
    return !others.some((p) => ancestors(p).has(e.target));
  });
}

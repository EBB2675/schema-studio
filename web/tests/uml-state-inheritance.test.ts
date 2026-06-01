import { describe, expect, it } from "vitest";
import type { ApiGraph } from "../src/types/api";
import { buildUmlStateFromGraph } from "../src/utils/umlState";

const baseGraph = (): ApiGraph => ({
  package: "pkg.schema",
  root: "",
  nodes: [
    { id: "pkg.schema.Parent", kind: "section", label: "Parent" },
    { id: "pkg.schema.Child", kind: "section", label: "Child" },
    { id: "pkg.schema.Sub", kind: "section", label: "Sub" },
    {
      id: "pkg.schema.Parent.shared_q",
      kind: "quantity",
      label: "shared_q",
      owner: "pkg.schema.Parent",
      dtype: "float",
      doc: "shared from parent",
    },
  ],
  edges: [
    { source: "pkg.schema.Child", target: "pkg.schema.Parent", type: "inherits" },
    { source: "pkg.schema.Parent", target: "pkg.schema.Sub", type: "hasSubSection", card: "0..*" },
    { source: "pkg.schema.Parent", target: "pkg.schema.Parent.shared_q", type: "hasQuantity" },
  ],
});

describe("buildUmlStateFromGraph inheritance", () => {
  it("surfaces inherited quantities and inherited subsection edges for children", () => {
    const uml = buildUmlStateFromGraph(baseGraph());
    expect(uml).not.toBeNull();

    const child = uml!.classes.find((c) => c.id === "pkg.schema.Child");
    expect(child).toBeDefined();
    expect(child!.parentId).toBe("pkg.schema.Parent");
    expect(child!.parentRelation).toBe("inherits");

    const inherited = child!.quantities.find((q) => q.name === "shared_q");
    expect(inherited).toBeDefined();
    expect(inherited!.inherited).toBe(true);
    expect(inherited!.inheritedFromName).toBe("Parent");
    expect(inherited!.id).toContain("::inherited::");

    expect(
      uml!.edges.some(
        (e) =>
          e.type === "hasSubSection" &&
          e.source === "pkg.schema.Child" &&
          e.target === "pkg.schema.Sub" &&
          e.card === "0..*"
      )
    ).toBe(true);
  });

  it("stores subsection parent cardinality on class nodes", () => {
    const uml = buildUmlStateFromGraph(baseGraph());
    const sub = uml!.classes.find((c) => c.id === "pkg.schema.Sub");

    expect(sub).toBeDefined();
    expect(sub!.parentId).toBe("pkg.schema.Parent");
    expect(sub!.parentRelation).toBe("hasSubSection");
    expect(sub!.parentCard).toBe("0..*");
  });

  it("prefers owned quantity over inherited quantity with the same name", () => {
    const graph = baseGraph();
    graph.nodes.push({
      id: "pkg.schema.Child.shared_q",
      kind: "quantity",
      label: "shared_q",
      owner: "pkg.schema.Child",
      dtype: "int",
      doc: "owned on child",
    });
    graph.edges.push({
      source: "pkg.schema.Child",
      target: "pkg.schema.Child.shared_q",
      type: "hasQuantity",
    });

    const uml = buildUmlStateFromGraph(graph);
    const child = uml!.classes.find((c) => c.id === "pkg.schema.Child");
    const quantities = child!.quantities.filter((q) => q.name === "shared_q");

    expect(quantities).toHaveLength(1);
    expect(quantities[0].inherited).toBe(false);
    expect(quantities[0].ownerId).toBe("pkg.schema.Child");
  });

  it("treats flattened inherited quantities on child nodes as inherited/read-only even with path/line drift", () => {
    const graph = baseGraph();
    graph.nodes[3] = {
      ...graph.nodes[3],
      path: "parent.py",
      line: 10,
    };
    graph.nodes.push({
      id: "pkg.schema.Child.shared_q",
      kind: "quantity",
      label: "shared_q",
      owner: "pkg.schema.Child",
      dtype: "float",
      doc: "flattened inherited value",
      path: "child.py",
      line: 99,
    });
    graph.edges.push({
      source: "pkg.schema.Child",
      target: "pkg.schema.Child.shared_q",
      type: "hasQuantity",
    });

    const uml = buildUmlStateFromGraph(graph);
    const child = uml!.classes.find((c) => c.id === "pkg.schema.Child");
    const shared = child!.quantities.find((q) => q.name === "shared_q");

    expect(shared).toBeDefined();
    expect(shared!.inherited).toBe(true);
    expect(shared!.inheritedFromId).toBe("pkg.schema.Parent");
  });
});

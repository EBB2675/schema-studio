import { describe, expect, it } from "vitest";
import { canvasEdges } from "../src/utils/canvasEdges";

const inherits = (source: string, target: string) => ({ source, target, type: "inherits" });
const pairs = (edges: { source: string; target: string; type: string }[]) =>
  edges.map((e) => `${e.source}->${e.target}:${e.type}`);

describe("canvasEdges", () => {
  it("draws an inheritance arrow only to the nearest parent", () => {
    // A(B), B(C), C(D), with an edge from each class to every ancestor.
    const edges = [
      inherits("A", "B"), inherits("A", "C"), inherits("A", "D"),
      inherits("B", "C"), inherits("B", "D"),
      inherits("C", "D"),
    ];
    expect(pairs(canvasEdges(edges))).toEqual(["A->B:inherits", "B->C:inherits", "C->D:inherits"]);
  });

  it("keeps the edge to an ancestor when the class in between is not drawn", () => {
    // B is hidden, so its edges are not in the list.
    expect(pairs(canvasEdges([inherits("A", "C")]))).toEqual(["A->C:inherits"]);
  });

  it("keeps every direct base of a class with several bases", () => {
    // A(B, M), both based on Base.
    const edges = [
      inherits("A", "B"), inherits("A", "M"), inherits("A", "Base"),
      inherits("B", "Base"), inherits("M", "Base"),
    ];
    expect(pairs(canvasEdges(edges))).toEqual(["A->B:inherits", "A->M:inherits", "B->Base:inherits", "M->Base:inherits"]);
  });

  it("leaves other edges alone and survives cycles", () => {
    const edges = [
      { source: "A", target: "S", type: "hasSubSection" },
      inherits("X", "Y"), inherits("Y", "X"),
    ];
    expect(pairs(canvasEdges(edges))).toEqual(["A->S:hasSubSection", "X->Y:inherits", "Y->X:inherits"]);
  });

  it("draws a subsection arrow only from the class that declares it", () => {
    // Child(Parent), GrandChild(Child); Parent declares a subsection of type Sub.
    const sub = (source: string) => ({ source, target: "Sub", type: "hasSubSection", card: "0..*" });
    const edges = [
      inherits("Child", "Parent"), inherits("GrandChild", "Child"), inherits("GrandChild", "Parent"),
      sub("Parent"), sub("Child"), sub("GrandChild"),
    ];
    expect(pairs(canvasEdges(edges).filter((e) => e.type === "hasSubSection"))).toEqual(["Parent->Sub:hasSubSection"]);
  });

  it("keeps a subsection arrow when the declaring class is not drawn or the cardinality differs", () => {
    const edges = [
      // Hidden declares a subsection of type Sub; it is not drawn, so its edges are not in the list.
      { source: "Child", target: "Sub", type: "hasSubSection", card: "0..*" },
      // Other redeclares its parent's subsection with another cardinality.
      inherits("Other", "Base"),
      { source: "Base", target: "Part", type: "hasSubSection", card: "0..*" },
      { source: "Other", target: "Part", type: "hasSubSection", card: "1" },
    ];
    expect(pairs(canvasEdges(edges).filter((e) => e.type === "hasSubSection"))).toEqual([
      "Child->Sub:hasSubSection", "Base->Part:hasSubSection", "Other->Part:hasSubSection",
    ]);
  });
});

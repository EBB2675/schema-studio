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
});

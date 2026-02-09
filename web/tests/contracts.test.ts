import { describe, expect, it } from "vitest";
import { ensureDiffResponse, ensureGraphResponse } from "../src/types/api";
import { fqidFromParts, normalizeId, normalizeLabel } from "../src/utils/identifier";

const sampleGraph = {
  package: "example.pkg",
  root: "Root",
  nodes: [
    { id: "example.pkg.Root", kind: "section", label: "Root" },
    { id: "example.pkg.Root.value", kind: "quantity", label: "value", owner: "example.pkg.Root" },
  ],
  edges: [
    { source: "example.pkg.Root.value", target: "example.pkg.Root", type: "hasQuantity" },
  ],
};

describe("contracts", () => {
  it("ensureGraphResponse validates shape and keeps labels", () => {
    const parsed = ensureGraphResponse(sampleGraph);
    expect(parsed.package).toBe("example.pkg");
    expect(parsed.nodes[0].id).toBe("example.pkg.Root");
    expect(parsed.nodes[1].owner).toBe("example.pkg.Root");
  });

  it("ensureGraphResponse rejects missing nodes", () => {
    expect(() => ensureGraphResponse({ package: "pkg", edges: [] } as unknown)).toThrow();
  });

  it("ensureDiffResponse validates nested graphs", () => {
    const diff = ensureDiffResponse({
      base: { branch: "main", sha: "abc1234", graph: sampleGraph },
      head: { branch: "dev", sha: "def5678", graph: sampleGraph },
      diff: {
        nodes: { added: [], removed: [], changed: [{ id: "example.pkg.Root" }] },
        edges: { added: [], removed: [] },
      },
    });
    expect(diff.base.graph.package).toBe("example.pkg");
    expect(diff.head.branch).toBe("dev");
    expect(diff.diff.nodes.changed[0].id).toBe("example.pkg.Root");
  });

  it("identifier utilities normalize ids and fqids", () => {
    expect(normalizeId("  spaced.id  ")).toBe("spaced.id");
    expect(normalizeLabel("  ", "fallback")).toBe("fallback");
    expect(fqidFromParts("pkg.", "Class", "fallback")).toBe("pkg.Class");
    expect(fqidFromParts("", "", "fallback")).toBe("fallback");
  });
});

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

  it("ensureGraphResponse keeps source facts of bam-masterdata nodes as details", () => {
    const parsed = ensureGraphResponse({
      package: "bam.pkg",
      root: null,
      nodes: [
        {
          id: "bam.pkg.C.p", kind: "quantity", label: "p", owner: "bam.pkg.C", code: "P", title: "P label",
          title_de: "P Bezeichnung", doc_de: "Deutsch", mandatory: true, section: "General", unit: "mm", iri: null,
        },
        { id: "nomad.pkg.S.q", kind: "quantity", label: "q", owner: "nomad.pkg.S", unit: "meter" },
      ],
      edges: [],
    });
    expect(parsed.nodes[0].details).toEqual({
      code: "P", title: "P label", titleDe: "P Bezeichnung", docDe: "Deutsch", mandatory: true, section: "General", unit: "mm",
    });
    // NOMAD quantities carry a unit but no openBIS code: nothing new is shown for them.
    expect(parsed.nodes[1].details).toBeNull();
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

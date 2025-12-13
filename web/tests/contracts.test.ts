import assert from "node:assert";
import { test } from "node:test";
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

test("ensureGraphResponse validates shape and keeps labels", () => {
  const parsed = ensureGraphResponse(sampleGraph);
  assert.equal(parsed.package, "example.pkg");
  assert.equal(parsed.nodes[0].id, "example.pkg.Root");
  assert.equal(parsed.nodes[1].owner, "example.pkg.Root");
});

test("ensureGraphResponse rejects missing nodes", () => {
  assert.throws(() => ensureGraphResponse({ package: "pkg", edges: [] } as any));
});

test("ensureDiffResponse validates nested graphs", () => {
  const diff = ensureDiffResponse({
    base: { branch: "main", sha: "abc1234", graph: sampleGraph },
    head: { branch: "dev", sha: "def5678", graph: sampleGraph },
    diff: {
      nodes: { added: [], removed: [], changed: [{ id: "example.pkg.Root" }] },
      edges: { added: [], removed: [] },
    },
  });
  assert.equal(diff.base.graph.package, "example.pkg");
  assert.equal(diff.head.branch, "dev");
  assert.equal(diff.diff.nodes.changed[0].id, "example.pkg.Root");
});

test("identifier utilities normalize ids and fqids", () => {
  assert.equal(normalizeId("  spaced.id  "), "spaced.id");
  assert.equal(normalizeLabel("  ", "fallback"), "fallback");
  assert.equal(fqidFromParts("pkg.", "Class", "fallback"), "pkg.Class");
  assert.equal(fqidFromParts("", "", "fallback"), "fallback");
});

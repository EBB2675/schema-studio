import { describe, expect, it } from "vitest";
import amorphousGraph from "./fixtures/bam-amorphous-graph.json";
import { ensureGraphResponse } from "../src/types/api";
import { buildUmlStateFromGraph } from "../src/utils/umlState";

// The graph the LinkML path builds for bam-masterdata `Amorphous` (a child of
// `MatSimStructure`); api/sources/tests/test_graph_bam.py keeps the file current.
const MODULE = "bam_masterdata.datamodel.object_types";
const AMORPHOUS = `${MODULE}.Amorphous`;
const MAT_SIM = `${MODULE}.MatSimStructure`;

describe("bam-masterdata graph through the LinkML path", () => {
  const graph = ensureGraphResponse(amorphousGraph);
  const uml = buildUmlStateFromGraph(graph)!;
  const amorphous = uml.classes.find((cls) => cls.id === AMORPHOUS)!;
  const parentNames = new Set(uml.classes.find((cls) => cls.id === MAT_SIM)!.quantities.map((q) => q.name));

  it("shows inherited properties on the child as inherited, so they are read-only there", () => {
    expect(parentNames.size).toBeGreaterThan(0);
    const inherited = amorphous.quantities.filter((q) => parentNames.has(q.name));
    expect(inherited).toHaveLength(parentNames.size);
    for (const q of inherited) {
      expect(q.inherited).toBe(true);
      expect(q.inheritedFromId).toBe(MAT_SIM);
      expect(q.inheritedFromName).toBe("MatSimStructure");
    }
  });

  it("keeps the child's own properties editable", () => {
    const own = amorphous.quantities.filter((q) => !parentNames.has(q.name));
    expect(own.map((q) => q.name)).toContain("atom_short_rng_ord");
    expect(own.every((q) => q.inherited === false)).toBe(true);
  });

  it("keeps the openBIS facts on classes and properties, inherited ones included", () => {
    expect(amorphous.details?.code).toBe("MAT_SIM_STRUCTURE.AMORPHOUS");
    expect(amorphous.details?.docDe).toBe("Material-simulationsstruktur - amorph");
    const own = amorphous.quantities.find((q) => q.name === "atom_short_rng_ord")!;
    expect(own.details).toMatchObject({
      code: "ATOM_SHORT_RNG_ORD",
      title: "Short-range Ordering",
      mandatory: false,
      section: "Material Information",
      docDe: "Ketten, Ringe, Tetraeder usw.",
    });
    expect(amorphous.quantities.filter((q) => q.inherited).every((q) => q.details?.code)).toBe(true);
  });
});

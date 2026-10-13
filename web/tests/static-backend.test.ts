import { describe, expect, it, vi } from "vitest";

import { createStaticBackend, StaticHttpError, type SiteIndex } from "../src/static/backend";
import { createEditStore, EDITS_STORAGE_KEY } from "../src/static/editStore";
import type { CoreRequest } from "../src/static/pythonRunner";

const SITE: SiteIndex = {
  format: 1,
  static: true,
  generated_at: "2026-10-02T00:00:00+00:00",
  profiles: [{
    key: "nomad-simulations",
    label: "nomad-simulations",
    default_branch: "develop",
    default_package: "ns.pkg.a",
    default_base_namespace: "ns.pkg",
    default_root: "Root",
    version: "abc1234def",
    source: "remote-develop",
    commit: "abc1234def",
    capabilities: ["usage"],
    edit_rule_set: "nomad",
    edit_rules: { rules: "nomad" },
    snapshot: "snapshots/nomad-simulations/ns.pkg.json",
    overview: [{ package: "ns.pkg.a", sections: ["Root", "Other"] }],
    modules: [{
      package: "ns.pkg.a",
      sections: ["Other", "Root"],
      snapshot: "snapshots/nomad-simulations/ns.pkg.a.json",
      graphs: { Root: "graphs/nomad-simulations/ns.pkg.a/Root.json" },
    }],
  }],
};

const READY = { package: "ns.pkg.a", root: "Root", nodes: [{ id: "ns.pkg.a.Root" }], edges: [] };

function setup() {
  const storage = window.localStorage;
  storage.clear();
  const readJson = vi.fn(async (path: string) => (path === "index.json" ? SITE : READY));
  const runCore = vi.fn(async (request: CoreRequest) => {
    if (request.op === "add_edits") {
      const ids = request.ids as number[];
      const edits = request.edits as { op: string; target: string; payload: object }[];
      const saved = edits.map((edit, index) => ({ ...edit, id: ids[index], profile: "nomad-simulations", package: request.package, commit: "abc", created_at: request.created_at }));
      return { ok: { package: request.package, nodes: [], edges: [], applied_edits: saved, persisted_edits: saved } };
    }
    if (request.op === "graph") return { ok: { package: request.package, root: (request.flags as { root: string }).root, nodes: [], edges: [], computed: true } };
    if (request.op === "sections") return { ok: ["Added", "Other", "Root"] };
    if (request.op === "linkml_yaml") return { ok: "id: x\n" };
    return { error: "unexpected", status: 500 };
  });
  const backend = createStaticBackend({ readJson, runCore, storage, edits: createEditStore(storage), now: () => "now" });
  return { backend, readJson, runCore };
}

describe("static backend", () => {
  it("serves the ready-made graph without the Python core while there are no edits", async () => {
    const { backend, runCore } = setup();
    const answer = await backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Root", base_namespace: "ns.pkg" });
    expect(answer.data).toMatchObject({ nodes: READY.nodes, workspace: { package: "ns.pkg.a", profile: "nomad-simulations" } });
    expect(runCore).not.toHaveBeenCalled();
  });

  it("asks the core for expanded subclasses and hands it the class list", async () => {
    const { backend, runCore } = setup();
    await backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Root", base_namespace: "ns.pkg", expand: "ns.pkg.a.Root, ns.pkg.a.Other" });
    expect(runCore).toHaveBeenLastCalledWith(expect.objectContaining({
      op: "graph", flags: expect.objectContaining({ expand: ["ns.pkg.a.Root", "ns.pkg.a.Other"] }),
    }));
  });

  it("asks the core when the filters differ or edits exist, and stores new edits in the browser", async () => {
    const { backend, runCore } = setup();
    await backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Root", include_quantities: false, base_namespace: "ns.pkg" });
    expect(runCore).toHaveBeenLastCalledWith(expect.objectContaining({ op: "graph", snapshots: ["snapshots/nomad-simulations/ns.pkg.a.json"] }));

    const added = await backend.request("POST", "/schema/edits", { root: "Root" }, {
      package: "ns.pkg.a", edits: [{ op: "add_class", target: "", payload: { name: "Added" } }],
    });
    expect((added.data as { persisted_edits: { id: number }[] }).persisted_edits.map(edit => edit.id)).toEqual([1]);
    expect(JSON.parse(window.localStorage.getItem(EDITS_STORAGE_KEY) || "{}").edits).toHaveLength(1);

    const roots = await backend.request("GET", "/roots", { package: "ns.pkg.a" });
    expect((roots.data as { sections: string[] }).sections).toEqual(["Added", "Other", "Root"]);
    const again = await backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Root", base_namespace: "ns.pkg" });
    expect(again.data).toMatchObject({ computed: true });
    expect(runCore).toHaveBeenLastCalledWith(expect.objectContaining({ op: "graph", stored: [expect.objectContaining({ id: 1 })] }));

    const listed = await backend.request("GET", "/schema/edits", { package: "ns.pkg.a" });
    expect((listed.data as { edits: unknown[] }).edits).toHaveLength(1);
    const cleared = await backend.request("DELETE", "/schema/edits", { package: "ns.pkg.a" }, { ids: [] });
    expect(cleared.data).toMatchObject({ deleted: 1 });
  });

  it("lists the site's modules and profiles, and marks them as static", async () => {
    const { backend } = setup();
    const profiles = (await backend.request("GET", "/schema/profiles")).data as { static: boolean; profiles: { version: string; available: boolean }[] };
    expect(profiles.static).toBe(true);
    expect(profiles.profiles[0]).toMatchObject({ version: "abc1234def", available: true, editable: true });
    const packages = await backend.request("GET", "/git/packages", { base_package: "ns.pkg" });
    expect(packages.data).toMatchObject({ packages: ["ns.pkg.a"], branch: "develop" });
    const overview = await backend.request("GET", "/overview", { base: "ns.pkg" });
    expect(overview.data).toMatchObject({ items: [{ package: "ns.pkg.a", classes: ["Other", "Root"] }] });
  });

  it("refuses what needs a server", async () => {
    const { backend } = setup();
    for (const [method, path] of [["POST", "/schema/update"], ["POST", "/send-design"], ["GET", "/git/branches"], ["POST", "/auth/login"]]) {
      await expect(backend.request(method, path)).rejects.toBeInstanceOf(StaticHttpError);
    }
    await expect(backend.request("PUT", "/workspace", {}, { package: "ns.pkg.a", branch: "main" })).rejects.toMatchObject({ status: 400 });
  });

  it("turns core errors into HTTP-like errors", async () => {
    const { backend, runCore } = setup();
    runCore.mockResolvedValueOnce({ error: "ValueError: no root", status: 400 });
    await expect(backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Nope", base_namespace: "ns.pkg" }))
      .rejects.toMatchObject({ status: 400, detail: "ValueError: no root" });
  });
});

describe("edit store", () => {
  it("downloads and loads the edit log, giving loaded edits new ids", () => {
    window.localStorage.clear();
    const store = createEditStore(window.localStorage);
    store.add([{ id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: { name: "A" }, created_at: null }]);
    const log = store.exportLog();
    expect(log.format).toBe("schema-studio-edits");

    const other = createEditStore(null);
    other.add([{ id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: { name: "B" }, created_at: null }]);
    expect(other.importLog(JSON.parse(JSON.stringify(log)))).toBe(1);
    expect(other.list("p").map(edit => [edit.id, edit.payload.name])).toEqual([[1, "B"], [2, "A"]]);
    expect(() => other.importLog({ edits: [] })).toThrow(/not a Schema Studio edit log/);
  });
});

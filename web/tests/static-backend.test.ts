import { afterEach, describe, expect, it, vi } from "vitest";

import { createStaticBackend, type SiteIndex } from "../src/static/backend";
import { createEditStore, EDITS_STORAGE_KEY } from "../src/static/editStore";
import { LEGACY_EDITS_STORAGE_KEY } from "../src/utils/storageKeys";
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
  }, {
    // A namespace the package does not have yet: no modules.
    key: "later",
    label: "later",
    default_branch: "main",
    default_package: "later.pkg.a",
    default_base_namespace: "later.pkg",
    default_root: "Root",
    version: "abc1234def",
    source: "remote-main",
    commit: "abc1234def",
    capabilities: [],
    edit_rule_set: "nomad",
    edit_rules: { rules: "nomad" },
    snapshot: "snapshots/later/later.pkg.json",
    overview: [],
    modules: [],
  }],
};

const READY = { package: "ns.pkg.a", root: "Root", nodes: [{ id: "ns.pkg.a.Root" }], edges: [] };

function setup(site = SITE) {
  const storage = window.localStorage;
  storage.clear();
  const readJson = vi.fn(async (path: string) => (path === "index.json" ? site : READY));
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

// Web Locks with one exclusive queue per lock name (nested requests for other names allowed).
function lockManager() {
  const queues = new Map<string, Promise<unknown>>();
  return vi.fn((name: string, _options: unknown, callback: () => unknown) => {
    const result = (queues.get(name) ?? Promise.resolve()).then(callback);
    queues.set(name, result.catch(() => undefined));
    return result;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const EDIT_BODY = { package: "ns.pkg.a", edits: [{ op: "add_class", payload: { name: "Added" } }] };

function pauseNextSave(runCore: ReturnType<typeof setup>["runCore"]) {
  const entered = deferred();
  const release = deferred();
  const implementation = runCore.getMockImplementation()!;
  runCore.mockImplementationOnce(async request => {
    entered.resolve();
    await release.promise;
    return implementation(request);
  });
  return { entered: entered.promise, release: release.resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("static backend", () => {
  it("caches a 47-module catalog across repeated reads and non-class edits, invalidating profile-wide for class changes", async () => {
    const site = structuredClone(SITE);
    const profile = site.profiles[0];
    profile.modules = Array.from({ length: 47 }, (_, i) => ({ package: `ns.pkg.module${i}`, sections: ['Root'], snapshot: `snapshots/module${i}.json` }));
    profile.overview = profile.modules.map(({ package: pkg, sections }) => ({ package: pkg, sections }));
    const { backend, runCore } = setup(site);
    const overview = () => backend.request('GET', '/overview', { base: 'ns.pkg' });
    const save = async (op: string, payload: Record<string, unknown> = {}) => backend.edits.transaction(tx => tx.add([{
      id: tx.nextIds(1)[0], profile: profile.key, package: 'ns.pkg.module0', commit: null,
      op, target: 'ns.pkg.module0.Root', payload, created_at: null,
    }]));
    await overview();
    await save('set_description');
    await save('add_attribute');
    await overview();
    await overview();
    expect(runCore).not.toHaveBeenCalled();

    await save('rename_class', { new_name: 'Renamed' });
    await Promise.all([overview(), overview()]);
    expect(runCore).toHaveBeenCalledTimes(47);
    expect(new Set(runCore.mock.calls.map(([request]) => request.package)).size).toBe(47);
    // All modules receive all profile edits, including modules that only import the renamed class.
    expect(runCore.mock.calls.every(([request]) => (request.stored as unknown[]).length === 3)).toBe(true);
    await backend.request('GET', '/roots', { package: 'ns.pkg.module0' });
    await save('set_description');
    await save('remove_attribute');
    await overview();
    await backend.edits.remove([4, 5]);
    await overview();
    expect(runCore).toHaveBeenCalledTimes(47);

    await save('add_class', { name: 'Added' });
    await overview();
    expect(runCore).toHaveBeenCalledTimes(94);
    const addedId = backend.edits.list(profile.key).at(-1)!.id;
    await backend.edits.remove([addedId]);
    await overview();
    expect(runCore).toHaveBeenCalledTimes(141);
    await save('remove_class');
    await overview();
    expect(runCore).toHaveBeenCalledTimes(188);
    const backup = backend.edits.exportLog();
    await backend.edits.restoreLog(backup);
    await overview();
    expect(runCore).toHaveBeenCalledTimes(235);
    await backend.edits.restoreLog({ ...backup, edits: [] });
    await overview();
    await overview();
    expect(runCore).toHaveBeenCalledTimes(235);
  });

  it("retries failed catalog calculations instead of caching their errors", async () => {
    const { backend, runCore } = setup();
    await backend.request('POST', '/schema/edits', {}, EDIT_BODY);
    runCore.mockClear();
    runCore.mockResolvedValueOnce({ error: 'temporary failure', status: 500 });
    await expect(backend.request('GET', '/overview', { base: 'ns.pkg' })).rejects.toThrow('temporary failure');
    await backend.request('GET', '/overview', { base: 'ns.pkg' });
    await backend.request('GET', '/overview', { base: 'ns.pkg' });
    expect(runCore).toHaveBeenCalledTimes(2);
  });

  it("invalidates when undo changes a reference edit preceding a class removal", async () => {
    const { backend, runCore } = setup();
    await backend.edits.transaction(tx => tx.add(['remove_attribute', 'remove_class'].map((op, i) => ({
      id: i + 1, profile: SITE.profiles[0].key, package: 'ns.pkg.a', commit: null, op,
      target: 'ns.pkg.a.Root', payload: {}, created_at: null,
    }))));
    const revision = backend.edits.getCatalogRevision();
    await backend.request('GET', '/overview', { base: 'ns.pkg' });
    await backend.edits.remove([1]);
    expect(backend.edits.getCatalogRevision()).toBeGreaterThan(revision);
    await backend.request('GET', '/overview', { base: 'ns.pkg' });
    expect(runCore).toHaveBeenCalledTimes(2);
  });

  it("uses the edited roots in overview after saves, undo, import, and restore", async () => {
    const { backend, runCore } = setup();
    const overview = async () => (await backend.request("GET", "/overview", { base: "ns.pkg" })).data;
    const original = { items: [{ package: "ns.pkg.a", classes: ["Other", "Root"] }] };
    expect(await overview()).toMatchObject(original);
    expect(runCore).not.toHaveBeenCalled();
    await backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    const backup = backend.edits.exportLog();
    expect(await overview()).toMatchObject({ items: [{ package: "ns.pkg.a", classes: ["Added", "Other", "Root"] }] });
    const roots = (await backend.request("GET", "/roots", { package: "ns.pkg.a" })).data;
    expect(roots).toMatchObject({ sections: ["Added", "Other", "Root"] });
    expect(runCore).toHaveBeenLastCalledWith(expect.objectContaining({ op: "sections", stored: backup.edits }));
    await backend.edits.remove([1]);
    expect(await overview()).toMatchObject(original);
    await backend.edits.importLog(backup);
    expect(await overview()).toMatchObject({ items: [{ classes: ["Added", "Other", "Root"] }] });
    await backend.edits.restoreLog({ ...backup, edits: [] });
    expect(await overview()).toMatchObject(original);
    await backend.edits.restoreLog(backup);
    expect(await overview()).toMatchObject({ items: [{ classes: ["Added", "Other", "Root"] }] });
  });
  it.each([false, true])("serializes overlapping saves and Undo (Web Locks: %s)", async useLocks => {
    const { backend, runCore, readJson } = setup();
    const requestLock = lockManager();
    vi.stubGlobal("navigator", { locks: useLocks ? { request: requestLock } : undefined });
    // Separate stores model two clients sharing persisted state.
    const other = createStaticBackend({ readJson, runCore, storage: window.localStorage });
    const pause = pauseNextSave(runCore);
    const first = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    await pause.entered;
    const second = other.request("POST", "/schema/edits", {}, EDIT_BODY);
    await other.request("GET", "/health");
    expect(runCore).toHaveBeenCalledTimes(1);
    pause.release();
    await Promise.all([first, second]);
    expect(runCore.mock.calls[1][0]).toMatchObject({ ids: [2], stored: [expect.objectContaining({ id: 1 })] });
    expect(backend.edits.list("nomad-simulations").map(edit => edit.id)).toEqual([1, 2]);
    await backend.request("DELETE", "/schema/edits/1");
    expect(backend.edits.list("nomad-simulations").map(edit => edit.id)).toEqual([2]);
    if (useLocks) expect(requestLock).toHaveBeenCalledWith(EDITS_STORAGE_KEY, { mode: "exclusive" }, expect.any(Function));
  });

  it.each(["single", "bulk", "clear"])("queues %s deletion behind an in-flight save", async kind => {
    const { backend, runCore } = setup();
    const pause = pauseNextSave(runCore);
    const save = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    await pause.entered;
    const deletion = kind === "single"
      ? backend.request("DELETE", "/schema/edits/1")
      : backend.request("DELETE", "/schema/edits", kind === "clear" ? { package: "ns.pkg.a" } : {}, { ids: kind === "bulk" ? [1] : [] });
    await backend.request("GET", "/health");
    pause.release();
    await save;
    expect((await deletion).data).toMatchObject({ deleted: 1 });
    expect(backend.edits.list("nomad-simulations")).toEqual([]);
  });

  it("queues imported edits behind validation and gives them fresh IDs", async () => {
    const { backend, runCore } = setup();
    const pause = pauseNextSave(runCore);
    const save = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    await pause.entered;
    const imported = backend.edits.importLog({ format: "schema-studio-edits", edits: [{
      id: 1, profile: "nomad-simulations", package: "ns.pkg.a", op: "add_class", target: "", payload: { name: "Imported" },
    }] });
    pause.release();
    await save;
    expect(await imported).toBe(1);
    expect(backend.edits.list("nomad-simulations").map(edit => edit.id)).toEqual([1, 2]);
  });

  it("continues queued saves after failed validation without persisting the failed edit", async () => {
    const { backend, runCore } = setup();
    runCore.mockResolvedValueOnce({ error: "Invalid edit", status: 400 });
    const failed = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    const next = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    await expect(failed).rejects.toMatchObject({ status: 400 });
    await next;
    expect(backend.edits.list("nomad-simulations").map(edit => edit.id)).toEqual([1]);
    expect(runCore.mock.calls[1][0]).toMatchObject({ ids: [1], stored: [] });
  });

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
    expect(profiles.profiles[0]).toMatchObject({ version: "abc1234def", available: true, editable: true, empty: false });
    expect(profiles.profiles[1]).toMatchObject({ key: "later", empty: true });
    const packages = await backend.request("GET", "/git/packages", { base_package: "ns.pkg" });
    expect(packages.data).toMatchObject({ packages: ["ns.pkg.a"], branch: "develop" });
    const overview = await backend.request("GET", "/overview", { base: "ns.pkg" });
    expect(overview.data).toMatchObject({ items: [{ package: "ns.pkg.a", classes: ["Other", "Root"] }] });
  });


  it("turns core errors into HTTP-like errors", async () => {
    const { backend, runCore } = setup();
    runCore.mockResolvedValueOnce({ error: "ValueError: no root", status: 400 });
    await expect(backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Nope", base_namespace: "ns.pkg" }))
      .rejects.toMatchObject({ status: 400, detail: "ValueError: no root" });
  });
});

describe("edit store", () => {
  it("rejects duplicate IDs without partially inserting a batch", async () => {
    const store = createEditStore(null);
    const edit = { id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: {}, created_at: null };
    await expect(store.transaction(edits => edits.add([edit, edit]))).rejects.toThrow("Duplicate edit ID: 1");
    expect(store.list("p")).toEqual([]);
    await store.transaction(edits => edits.add([edit]));
    await expect(store.transaction(edits => edits.add([{ ...edit, id: 2 }, edit]))).rejects.toThrow("Duplicate edit ID: 1");
    expect(store.list("p").map(edit => edit.id)).toEqual([1]);
    await store.transaction(edits => {
      expect(edits.nextIds(1)).toEqual([2]);
      edits.add([{ ...edit, id: 2 }]);
    });
    expect(store.list("p").map(edit => edit.id)).toEqual([1, 2]);
  });

  it("downloads and loads the edit log, giving loaded edits new ids", async () => {
    window.localStorage.clear();
    const store = createEditStore(window.localStorage);
    await store.transaction(edits => edits.add([{ id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: { name: "A" }, created_at: null }]));
    const log = store.exportLog();
    expect(log.format).toBe("schema-studio-edits");

    const other = createEditStore(null);
    await other.transaction(edits => edits.add([{ id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: { name: "B" }, created_at: null }]));
    expect(await other.importLog(JSON.parse(JSON.stringify(log)))).toBe(1);
    expect(other.list("p").map(edit => [edit.id, edit.payload.name])).toEqual([[1, "B"], [2, "A"]]);
    await expect(other.importLog({ edits: [] })).rejects.toThrow(/not a Schema Studio edit log/);
  });
});

describe("edit ids across log generations", () => {
  it("reports the generation with every graph and never deletes by an id from a replaced log", async () => {
    const { backend } = setup();
    const store = () => createEditStore(window.localStorage);
    const added = await backend.request("POST", "/schema/edits", { root: "Root" }, EDIT_BODY);
    const savedIn = (added.data as { edit_generation: string }).edit_generation;
    expect(savedIn).toBe(store().getGeneration());
    const read = await backend.request("GET", "/schema", { package: "ns.pkg.a", root: "Root", base_namespace: "ns.pkg" });
    expect((read.data as { edit_generation: string }).edit_generation).toBe(savedIn);

    // Another tab restores a backup in which id 1 is an unrelated edit.
    const replacement = { id: 1, profile: "nomad-simulations", package: "ns.pkg.b", commit: null, op: "add_class", target: "", payload: { name: "ImportantReplacementClass" }, created_at: null };
    await store().restoreLog({ format: "schema-studio-edits", version: 1, edits: [replacement] });

    await expect(backend.request("DELETE", "/schema/edits", {}, { ids: [1], generation: savedIn }))
      .rejects.toMatchObject({ status: 409 });
    expect(store().list("nomad-simulations")).toEqual([replacement]);
    // In the current generation the same id can be deleted.
    const current = store().getGeneration();
    await backend.request("DELETE", "/schema/edits", {}, { ids: [1], generation: current });
    expect(store().list("nomad-simulations")).toEqual([]);
  });
});

describe("first save after the storage keys were scoped", () => {
  it("holds the legacy lock, so a still-open old-version tab cannot replace the log mid-save", async () => {
    const { backend, runCore } = setup();
    const requestLock = lockManager();
    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    const storage = window.localStorage;
    const original = { id: 1, profile: "nomad-simulations", package: "ns.pkg.a", commit: null, op: "add_class", target: "", payload: { name: "Original" }, created_at: null };
    storage.setItem(LEGACY_EDITS_STORAGE_KEY, JSON.stringify({ nextId: 2, edits: [original], generation: "G0" }));

    const pause = pauseNextSave(runCore);
    const save = backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    await pause.entered;
    expect(requestLock).toHaveBeenCalledWith(LEGACY_EDITS_STORAGE_KEY, { mode: "exclusive" }, expect.any(Function));
    // The previous version restores a backup under its own (legacy) lock and key.
    const replacement = { ...original, payload: { name: "Replacement" } };
    let restoredDuringSave = false;
    const oldTab = requestLock(LEGACY_EDITS_STORAGE_KEY, { mode: "exclusive" }, () => {
      restoredDuringSave = storage.getItem(EDITS_STORAGE_KEY) === null;
      storage.setItem(LEGACY_EDITS_STORAGE_KEY, JSON.stringify({ nextId: 2, edits: [replacement], generation: "G1" }));
    });
    pause.release();
    const answer = (await save).data as { persisted_edits: { id: number }[]; edit_generation: string };
    await oldTab;

    // The old tab got the lock only after the first scoped write, and the save validated
    // against, extended and reported one and the same log.
    expect(restoredDuringSave).toBe(false);
    expect(JSON.parse(storage.getItem(LEGACY_EDITS_STORAGE_KEY)!).generation).toBe("G1");
    expect(answer.edit_generation).toBe("G0");
    expect(answer.persisted_edits.map(edit => edit.id)).toEqual([2]);
    const scoped = JSON.parse(storage.getItem(EDITS_STORAGE_KEY)!);
    expect(scoped.generation).toBe("G0");
    expect(scoped.edits.map((edit: { payload: { name: string } }) => edit.payload.name)).toEqual(["Original", "Added"]);
    // From now on the scoped log is used; the legacy lock is no longer taken.
    requestLock.mockClear();
    await backend.request("POST", "/schema/edits", {}, EDIT_BODY);
    expect(requestLock.mock.calls.map(([name]) => name)).toEqual([EDITS_STORAGE_KEY]);
  });
});

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StaticSitePanel from "../src/components/StaticSitePanel";
import { getStaticBackend } from "../src/client";
import { useAuditTrail } from "../src/hooks/useAuditTrail";
import { createEditStore, EDITS_STORAGE_KEY, LEGACY_EDIT_GENERATION, type StoredEdit } from "../src/static/editStore";
import {
  AUDIT_STORAGE_KEY, LEGACY_AUDIT_STORAGE_KEY, LEGACY_EDITS_STORAGE_KEY, readWithLegacyFallback, scopedStorageKey,
} from "../src/utils/storageKeys";
import { describeSavedEdit, packagesListingAppliedEdits, unlistedAppliedEdits } from "../src/utils/savedEdits";
import type { AuditTrailEntry } from "../src/types/uml";

vi.mock("../src/client", () => ({ getStaticBackend: vi.fn() }));
vi.mock("../src/static/workerCore", () => ({ coreStatus: () => "ready", onCoreStatus: () => () => {}, warmUpWorker: vi.fn() }));

const edit = (id: number, pkg = "m"): StoredEdit => ({
  id, profile: "p", package: pkg, commit: null, op: "add_class", target: "", payload: { name: `C${id}` }, created_at: null,
});
const savedLog = (edits: StoredEdit[]) => JSON.stringify({ nextId: edits.length + 1, edits, generation: LEGACY_EDIT_GENERATION });

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("storage keys scoped to the base path", () => {
  it("gives each deployment on one origin its own keys", () => {
    expect(scopedStorageKey("k", "/schema-studio/")).not.toBe(scopedStorageKey("k", "/other-fork/"));
    expect(EDITS_STORAGE_KEY).not.toBe(LEGACY_EDITS_STORAGE_KEY);
    expect(AUDIT_STORAGE_KEY).not.toBe(LEGACY_AUDIT_STORAGE_KEY);
  });

  it("falls back to the legacy value without ever writing", () => {
    localStorage.setItem("old", "v1");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    expect(readWithLegacyFallback(localStorage, "new", "old")).toBe("v1");
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem("new")).toBeNull();
    // Once the scoped key exists, the legacy one is no longer consulted.
    localStorage.setItem("new", "v2");
    expect(readWithLegacyFallback(localStorage, "new", "old")).toBe("v2");
  });

  it("reads legacy edits and moves them to the scoped key on the first locked save", async () => {
    const legacy = savedLog([edit(1), edit(2)]);
    localStorage.setItem(LEGACY_EDITS_STORAGE_KEY, legacy);
    const store = createEditStore(localStorage);
    expect(store.list("p").map(e => e.id)).toEqual([1, 2]);
    expect(localStorage.getItem(EDITS_STORAGE_KEY)).toBeNull();
    await store.transaction(tx => tx.add([edit(3)]));
    expect(JSON.parse(localStorage.getItem(EDITS_STORAGE_KEY)!).edits.map((e: StoredEdit) => e.id)).toEqual([1, 2, 3]);
    expect(localStorage.getItem(LEGACY_EDITS_STORAGE_KEY)).toBe(legacy);
  });

  // Two tabs on an unmigrated deployment: A reads first (legacy fallback), then B saves.
  it.each([
    ["saves another edit", (b: ReturnType<typeof createEditStore>) => b.transaction(tx => tx.add([edit(2)])), [1, 2]],
    ["discards all edits", (b: ReturnType<typeof createEditStore>) => b.discardAll(), []],
  ] as const)("a reading tab never overwrites what another tab %s", async (_name, other, expected) => {
    localStorage.setItem(LEGACY_EDITS_STORAGE_KEY, savedLog([edit(1)]));
    const tabA = createEditStore(localStorage);
    const tabB = createEditStore(localStorage);
    expect(tabA.list("p").map(e => e.id)).toEqual([1]);
    await other(tabB);
    // A's earlier read wrote nothing, so it cannot have clobbered B; it now sees B's log.
    expect(tabA.list("p").map(e => e.id)).toEqual(expected);
    expect(tabA.exportLog().edits.map(e => e.id)).toEqual(expected);
    // A's next locked save builds on B's log, not on the legacy one.
    await tabA.transaction(tx => tx.add([edit(9)]));
    expect(JSON.parse(localStorage.getItem(EDITS_STORAGE_KEY)!).edits.map((e: StoredEdit) => e.id)).toEqual([...expected, 9]);
  });

  it("does not let the legacy log come back after the scoped log was emptied", async () => {
    localStorage.setItem(LEGACY_EDITS_STORAGE_KEY, savedLog([edit(1)]));
    const store = createEditStore(localStorage);
    await store.remove([1]);
    expect(createEditStore(localStorage).list("p")).toEqual([]);
  });

  it("migrates History from the unscoped key", () => {
    const entry: AuditTrailEntry = {
      id: "local-1", timestamp: "2026-11-24T00:00:00Z", description: "old entry", editGeneration: LEGACY_EDIT_GENERATION,
      change: { type: "add-class", cls: { id: "pkg.A", name: "A", quantities: [] } },
    };
    localStorage.setItem(LEGACY_AUDIT_STORAGE_KEY, JSON.stringify([entry]));
    const { result } = renderHook(useAuditTrail);
    expect(result.current[0].map(e => e.id)).toEqual(["local-1"]);
    expect(localStorage.getItem(LEGACY_AUDIT_STORAGE_KEY)).not.toBeNull();
  });
});

describe("discarding all saved edits", () => {
  it("empties the log of every schema and starts a new generation", async () => {
    const store = createEditStore(localStorage);
    await store.transaction(tx => tx.add([edit(1, "a"), { ...edit(2, "b"), profile: "q" }]));
    const generation = store.getGeneration();
    expect(await store.discardAll()).toBe(2);
    expect(store.list("p")).toEqual([]);
    expect(store.list("q")).toEqual([]);
    expect(store.getGeneration()).not.toBe(generation);
    expect(JSON.parse(localStorage.getItem(EDITS_STORAGE_KEY)!).edits).toEqual([]);
    // Ids keep counting up, so a late reference to a discarded edit cannot name a new one.
    expect(await store.transaction(tx => tx.nextIds(1))).toEqual([3]);
  });

  it("recovers from a log that cannot be read", async () => {
    localStorage.setItem(EDITS_STORAGE_KEY, "broken json");
    const store = createEditStore(localStorage);
    expect(() => store.list("p")).toThrow();
    expect(await store.discardAll()).toBe(0);
    expect(store.list("p")).toEqual([]);
  });

  it("asks for confirmation in the panel and does nothing when cancelled", async () => {
    const store = createEditStore(null);
    await store.transaction(tx => tx.add([edit(1), edit(2)]));
    vi.mocked(getStaticBackend).mockResolvedValue({ edits: store } as Awaited<ReturnType<typeof getStaticBackend>>);
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    const discarded = vi.fn();
    const { rerender } = render(<StaticSitePanel onEditsChanged={vi.fn()} onBackupRestored={vi.fn()} onAllEditsDiscarded={discarded} discardBlocked />);
    // While an edit is being saved, discarding is not offered.
    expect(screen.getByRole("button", { name: "Discard all saved edits…" })).toBeDisabled();
    rerender(<StaticSitePanel onEditsChanged={vi.fn()} onBackupRestored={vi.fn()} onAllEditsDiscarded={discarded} />);

    fireEvent.click(screen.getByRole("button", { name: "Discard all saved edits…" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0][0]).toMatch(/all 2 saved edits across all schemas/);
    expect(store.list("p")).toHaveLength(2);
    expect(discarded).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard all saved edits…" }));
    await screen.findByText("Discarded 2 saved edits.");
    expect(store.list("p")).toEqual([]);
    expect(discarded).toHaveBeenCalledOnce();

    // Nothing left: no confirmation, just a note.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard all saved edits…" })); });
    await screen.findByText("There are no saved edits to discard.");
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("applied edits without a History entry", () => {
  const history = (editIds: string[]): AuditTrailEntry => ({
    id: "h", timestamp: "2026-11-24T00:00:00Z", description: "h", editIds,
    change: { type: "add-class", cls: { id: "pkg.A", name: "A", quantities: [] } },
  });
  const applied = (id?: string) => ({ id, op: "add_class", target: "", payload: { name: "A" } });

  it("lists edits no History entry names, including edits without an id", () => {
    const edits = [applied("1"), applied("2"), applied(undefined)];
    expect(unlistedAppliedEdits(edits, [history(["1"])])).toEqual([edits[1], edits[2]]);
    expect(unlistedAppliedEdits(undefined, [])).toEqual([]);
  });

  it("counts only History entries of the graph's generation, since ids are reused across logs", () => {
    const restored = applied("1");
    const stale = { ...history(["1"]), editGeneration: "G0" };
    expect(unlistedAppliedEdits([restored], [stale], "G1")).toEqual([restored]);
    expect(unlistedAppliedEdits([restored], [{ ...stale, editGeneration: "G1" }], "G1")).toEqual([]);
  });

  it("names the other packages whose History lists edits applied here", () => {
    const inA = { ...history(["1", "2"]), package: "pkg.a", editGeneration: "G" };
    const inB = { ...history(["3"]), package: "pkg.b", editGeneration: "G" };
    const old = { ...history(["4"]), package: "pkg.c", editGeneration: "G0" };
    const here = (pkg?: string) => pkg === "pkg.b";
    expect(packagesListingAppliedEdits([applied("1"), applied("3"), applied("4")], [inA, inB, old], "G", here))
      .toEqual({ count: 1, packages: ["pkg.a"] });
    expect(packagesListingAppliedEdits([], [inA], "G", here)).toEqual({ count: 0, packages: [] });
  });

  it("describes edits in plain words", () => {
    expect(describeSavedEdit({ op: "add_attribute", target: "pkg.m.AtomsState", payload: { name: "x" } }))
      .toBe("add attribute x on AtomsState");
    expect(describeSavedEdit({ op: "rename_attribute", target: "pkg.m.AtomsState", payload: { attribute: "x", new_name: "y" } }))
      .toBe("rename attribute x to y on AtomsState");
    expect(describeSavedEdit({ op: "rename_class", target: "pkg.m.A", payload: { new_name: "B" } }))
      .toBe("rename class A to B");
  });
});

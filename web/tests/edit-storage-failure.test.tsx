import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createEditStore, EDITS_STORAGE_KEY, type StoredEdit } from "../src/static/editStore";
import EditStorageWarning from "../src/components/EditStorageWarning";
import { getStaticBackend } from "../src/client";

vi.mock("../src/client", () => ({ getStaticBackend: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const edit = (id: number): StoredEdit => ({ id, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: { name: `Class${id}` }, created_at: null });

function setup() {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() { return data.size; },
    clear: () => data.clear(),
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
  const store = createEditStore(storage);
  const fail = () => vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  return { store, storage, fail };
}

it("preserves failed saves across reads, exports, ID allocation, imports and deletes, then persists the full log on recovery", async () => {
  const { store, storage, fail } = setup();
  await store.transaction(tx => tx.add([edit(1)]));
  const listener = vi.fn();
  const stop = store.subscribe(listener);
  const failedWrite = fail();
  await store.transaction(tx => tx.add([edit(2)]));
  expect(store.hasUnsavedChanges()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.list("p").map(e => e.id)).toEqual([1, 2]);
  expect(store.exportLog().edits.map(e => e.id)).toEqual([1, 2]);
  await store.transaction(tx => {
    expect(tx.nextIds(1)).toEqual([3]);
    tx.add([edit(3)]);
  });
  await store.importLog({ format: "schema-studio-edits", edits: [edit(99)] });
  await store.remove([1]);
  expect(store.list("p").map(e => e.id)).toEqual([2, 3, 4]);
  expect(JSON.parse(storage.getItem(EDITS_STORAGE_KEY)!).edits.map((e: StoredEdit) => e.id)).toEqual([1]);
  failedWrite.mockRestore();
  await store.transaction(tx => tx.add([edit(tx.nextIds(1)[0])]));
  expect(store.hasUnsavedChanges()).toBe(false);
  // Catalog subscribers need every edit change, even if persistence status is unchanged.
  expect(listener).toHaveBeenCalledTimes(5);
  expect(store.getRevision()).toBe(6);
  expect(createEditStore(storage).list("p").map(e => e.id)).toEqual([2, 3, 4, 5]);
  stop();
  fail();
  await store.remove([5]);
  expect(listener).toHaveBeenCalledTimes(5);
});

it("retains failed deletes and imports even when they are the first failed write", async () => {
  for (const operation of ["delete", "import"]) {
    const { store, fail } = setup();
    await store.transaction(tx => tx.add([edit(1)]));
    fail();
    if (operation === "delete") await store.remove([1]);
    else await store.importLog({ format: "schema-studio-edits", edits: [edit(99)] });
    expect(store.exportLog().edits.map(e => e.id)).toEqual(operation === "delete" ? [] : [1, 2]);
    expect(store.hasUnsavedChanges()).toBe(true);
  }
});

it("handles unavailable storage, including a blocked localStorage getter", async () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  for (const store of [createEditStore(null), createEditStore()]) {
    await store.transaction(tx => tx.add([edit(1)]));
    expect(store.hasUnsavedChanges()).toBe(true);
    expect(store.exportLog().edits).toEqual([edit(1)]);
  }
});

it("shows existing unsaved state, downloads all edits, and clears the warning only after persistence recovers", async () => {
  const { store, fail } = setup();
  await store.transaction(tx => tx.add([edit(1)]));
  const failedWrite = fail();
  await store.transaction(tx => tx.add([edit(2)]));
  vi.mocked(getStaticBackend).mockResolvedValue({ edits: store } as Awaited<ReturnType<typeof getStaticBackend>>);
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:backup");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<EditStorageWarning />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Download edits backup" }));
  const blob = createUrl.mock.calls[0][0] as Blob;
  expect(JSON.parse(await blob.text()).edits.map((e: StoredEdit) => e.id)).toEqual([1, 2]);
  expect(click).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent("reload or close");
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await screen.findByText("Saving still failed. Download a backup to keep your edits.");
  failedWrite.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  const savedLeaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(savedLeaving);
  expect(savedLeaving.defaultPrevented).toBe(false);
  expect(store.exportLog().edits).toEqual([edit(1), edit(2)]);
  fail();
  await act(async () => { await store.remove([2]); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it.each([false, true])("never overwrites saved edits after a failed read (previously read: %s)", async previouslyRead => {
  const { store, storage } = setup();
  await store.transaction(tx => tx.add([edit(1)]));
  const fresh = createEditStore(storage);
  if (previouslyRead) expect(fresh.list("p")).toEqual([edit(1)]);
  const read = vi.spyOn(storage, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  const write = vi.spyOn(storage, "setItem");
  await expect(fresh.transaction(tx => tx.add([edit(2)]))).rejects.toThrow("could not be read");
  await expect(fresh.remove([1])).rejects.toThrow("could not be read");
  await expect(fresh.importLog(storeLog([edit(2)]))).rejects.toThrow("could not be read");
  await fresh.retrySave();
  expect(write).not.toHaveBeenCalled();
  read.mockRestore();
  await fresh.transaction(tx => tx.add([edit(tx.nextIds(1)[0])]));
  expect(fresh.exportLog().edits).toEqual([edit(1), edit(2)]);
});

const storeLog = (edits: StoredEdit[]) => ({ format: "schema-studio-edits", version: 1, edits });

it("does not overwrite a malformed persistent log", async () => {
  const { store, storage } = setup();
  storage.setItem(EDITS_STORAGE_KEY, "broken json");
  await expect(store.transaction(tx => tx.add([edit(1)]))).rejects.toThrow("could not be read");
  expect(storage.getItem(EDITS_STORAGE_KEY)).toBe("broken json");
});

it.each(["add", "delete", "clear"])("round-trips a backup after a failed %s without duplicating or resurrecting edits", async operation => {
  const { store, storage, fail } = setup();
  await store.transaction(tx => tx.add([edit(1), edit(2)]));
  const failure = fail();
  if (operation === "add") await store.transaction(tx => tx.add([edit(3)]));
  else await store.remove(operation === "clear" ? [1, 2] : [2]);
  const backup = JSON.parse(JSON.stringify(store.exportLog()));
  failure.mockRestore();
  const reloaded = createEditStore(storage);
  expect(reloaded.list("p")).toEqual([edit(1), edit(2)]);
  await reloaded.restoreLog(backup);
  expect(reloaded.exportLog().edits).toEqual(backup.edits);
  expect(createEditStore(storage).exportLog().edits).toEqual(backup.edits);
  await reloaded.restoreLog(backup);
  expect(reloaded.exportLog().edits).toEqual(backup.edits);
  await reloaded.transaction(tx => {
    const id = tx.nextIds(1)[0];
    expect(id).toBe(operation === "add" ? 4 : operation === "clear" ? 1 : 2);
  });
});

it("rejects invalid backups and preserves a restored backup if its write fails", async () => {
  const { store, fail } = setup();
  await store.transaction(tx => tx.add([edit(1)]));
  for (const invalid of [{ ...storeLog([]), version: 2 }, storeLog([edit(2), edit(2)]), storeLog([edit(-1)]), storeLog([null as unknown as StoredEdit])]) {
    await expect(store.restoreLog(invalid)).rejects.toThrow("valid Schema Studio backup");
    expect(store.exportLog().edits).toEqual([edit(1)]);
  }
  const failure = fail();
  await store.restoreLog(storeLog([edit(5)]));
  expect(store.exportLog().edits).toEqual([edit(5)]);
  expect(store.hasUnsavedChanges()).toBe(true);
  failure.mockRestore();
  expect(await store.retrySave()).toBe(true);
});

it("persists each replacement generation atomically with edits and preserves it through retries and ordinary mutations", async () => {
  const { store, storage, fail } = setup();
  // Legacy logs remain readable without a migration write.
  storage.setItem(EDITS_STORAGE_KEY, JSON.stringify({ nextId: 2, edits: [edit(1)] }));
  const original = store.getGeneration();
  expect(original).toBe("legacy");
  const failure = fail();
  await store.restoreLog(storeLog([{ ...edit(1), target: "B" }]));
  const restored = store.getGeneration();
  expect(restored).not.toBe(original);
  expect(createEditStore(storage).getGeneration()).toBe(original);
  failure.mockRestore();
  await store.retrySave();
  const saved = JSON.parse(storage.getItem(EDITS_STORAGE_KEY)!);
  expect(saved.generation).toBe(restored);
  expect(saved.edits[0].target).toBe("B");
  expect(createEditStore(storage).getGeneration()).toBe(restored);
  await store.transaction(tx => tx.add([edit(2)]));
  await store.importLog(storeLog([edit(3)]));
  await store.remove([2]);
  expect(store.getGeneration()).toBe(restored);
  await store.restoreLog(store.exportLog());
  expect(store.getGeneration()).not.toBe(restored);
});

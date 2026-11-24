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
  expect(listener).toHaveBeenCalledTimes(2);
  expect(createEditStore(storage).list("p").map(e => e.id)).toEqual([2, 3, 4, 5]);
  stop();
  fail();
  await store.remove([5]);
  expect(listener).toHaveBeenCalledTimes(2);
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
  failedWrite.mockRestore();
  await act(async () => { await store.transaction(tx => tx.add([edit(3)])); });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fail();
  await act(async () => { await store.remove([3]); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

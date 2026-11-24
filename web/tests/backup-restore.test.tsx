import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import StaticSitePanel from "../src/components/StaticSitePanel";
import { createEditStore } from "../src/static/editStore";
import { getStaticBackend } from "../src/client";

vi.mock("../src/client", () => ({ getStaticBackend: vi.fn() }));
vi.mock("../src/static/workerCore", () => ({ coreStatus: () => "ready", onCoreStatus: () => () => {}, warmUpWorker: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires confirmation for replacement while keeping import additive", async () => {
  const store = createEditStore(null);
  const edit = { id: 1, profile: "p", package: "m", commit: null, op: "add_class", target: "", payload: {}, created_at: null };
  await store.transaction(tx => tx.add([edit]));
  vi.mocked(getStaticBackend).mockResolvedValue({ edits: store } as Awaited<ReturnType<typeof getStaticBackend>>);
  const changed = vi.fn();
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("confirm", confirm);
  render(<StaticSitePanel onEditsChanged={changed} />);
  const file = new File([JSON.stringify({ format: "schema-studio-edits", version: 1, edits: [] })], "backup.json");
  fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(store.exportLog().edits).toEqual([edit]);
  expect(changed).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
  await screen.findByText("Restored 0 edits.");
  expect(store.exportLog().edits).toEqual([]);
  expect(changed).toHaveBeenCalledOnce();
  const log = new File([JSON.stringify({ format: "schema-studio-edits", version: 1, edits: [edit] })], "edits.json");
  fireEvent.change(screen.getByLabelText("Edit log file"), { target: { files: [log] } });
  await waitFor(() => expect(store.list("p")).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Edit log file"), { target: { files: [log] } });
  await waitFor(() => expect(store.list("p")).toHaveLength(2));
  expect(confirm).toHaveBeenCalledTimes(2);
});

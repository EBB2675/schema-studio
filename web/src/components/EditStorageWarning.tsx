import { useEffect, useState, useSyncExternalStore } from "react";
import { getStaticBackend } from "../client";
import type { EditStore } from "../static/editStore";

function StorageWarning({ store }: { store: EditStore }) {
  const unsaved = useSyncExternalStore(store.subscribe, store.hasUnsavedChanges);
  const [retryMessage, setRetryMessage] = useState("");
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  if (!unsaved) return null;

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(store.exportLog(), null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "schema-studio-edits.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div role="alert" style={{ position: "fixed", bottom: 16, left: 16, right: 16, zIndex: 1000, padding: 16, background: "var(--panel)", border: "2px solid var(--danger)", borderRadius: 8 }}>
      <p>Browser storage could not save your edits. Your changes are available only in this page and may be lost when you reload or close it. Download a backup now. Keep editing in this tab only.</p>
      <button type="button" className="btn secondary" onClick={download}>Download edits backup</button>
      <button type="button" className="btn secondary" onClick={async () => {
        try {
          if (!await store.retrySave()) setRetryMessage("Saving still failed. Download a backup to keep your edits.");
        } catch {
          setRetryMessage("Saving could not be retried. Download a backup to keep your edits.");
        }
      }}>Retry saving</button>
      <p>To recover later, open History and choose Restore backup. This replaces the saved edit log.</p>
      <p>If browser storage was blocked when this page opened, Retry saving cannot reconnect it. Download a backup, enable browser storage, reload, then restore the backup.</p>
      {retryMessage && <p role="status">{retryMessage}</p>}
    </div>
  );
}

/** Mounted outside the panels so collapsed settings cannot hide storage failures. */
export default function EditStorageWarning() {
  const [store, setStore] = useState<EditStore | null>(null);
  useEffect(() => {
    let active = true;
    void getStaticBackend().then(backend => {
      if (active) setStore(backend.edits);
    }).catch(() => {
      // Backend initialization errors are reported by the app's request handlers.
    });
    return () => { active = false; };
  }, []);
  return store ? <StorageWarning store={store} /> : null;
}

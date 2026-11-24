import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { getStaticBackend } from "../client";
import { coreStatus, onCoreStatus, warmUpWorker, type CoreStatus } from "../static/workerCore";

// Only states the user has to wait for or act on get a line; idle and ready show nothing.
const ENGINE_TEXT: Partial<Record<CoreStatus, string>> = {
  loading: "Schema engine: loading (slow on the first visit only)…",
  failed: "Schema engine: failed to load; reload the page to try again",
};

/**
 * What the static site shows instead of the server controls: the edit log kept in this browser,
 * and the in-browser engine status while it loads or if it fails.
 */
export default function StaticSitePanel({ onEditsChanged, onBackupRestored }: {
  onEditsChanged: () => void;
  onBackupRestored: () => void;
}) {
  const [engine, setEngine] = useState<CoreStatus>(coreStatus());
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const restoreRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stop = onCoreStatus(setEngine);
    // Start Pyodide while the user looks at the first, ready-made graph.
    warmUpWorker();
    return () => {
      stop();
    };
  }, []);

  const downloadLog = async () => {
    try {
      const log = (await getStaticBackend()).edits.exportLog();
      const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "schema-studio-edits.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Downloaded ${log.edits.length} edit${log.edits.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreLog = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const log: unknown = JSON.parse(await file.text());
      if (!window.confirm("Restore this backup? This replaces ALL current edits across all schemas, including unsaved edits, and clears the previous undo history. Download your current edits first if you want to keep them.")) return;
      const count = await (await getStaticBackend()).edits.restoreLog(log);
      setMessage(`Restored ${count} edit${count === 1 ? "" : "s"}.`);
      onBackupRestored();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const loadLog = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const count = await (await getStaticBackend()).edits.importLog(JSON.parse(await file.text()));
      setMessage(`Loaded ${count} edit${count === 1 ? "" : "s"}.`);
      onEditsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div data-testid="static-site-panel">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn secondary"
          type="button"
          onClick={downloadLog}
          title="Edits are stored only in this browser. Download them to keep them or move them to another browser."
        >
          Download edits
        </button>
        <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()} title="Append imported edits to the current log; use Restore backup to replace it">
          Load edits
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={loadLog} aria-label="Edit log file" />
        <button className="btn secondary" type="button" onClick={() => restoreRef.current?.click()} title="Replace all current edits with a backup">
          Restore backup
        </button>
        <input ref={restoreRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={restoreLog} aria-label="Backup file" />
      </div>
      {ENGINE_TEXT[engine] ? (
        <div className="small" role="status" style={{ marginTop: 6, color: engine === "failed" ? "var(--danger)" : "var(--muted)" }}>
          {ENGINE_TEXT[engine]}
        </div>
      ) : null}
      {message ? <div className="small" style={{ marginTop: 6, color: "var(--muted)" }}>{message}</div> : null}
    </div>
  );
}

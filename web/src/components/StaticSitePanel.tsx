import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { getStaticBackend } from "../client";
import { coreStatus, onCoreStatus, warmUpWorker, type CoreStatus } from "../static/workerCore";

type ProfileVersion = { key: string; label: string; version?: string | null };

const ENGINE_TEXT: Record<CoreStatus, string> = {
  idle: "Schema engine: starts on first use",
  loading: "Schema engine: loading (slow on the first visit only)…",
  ready: "Schema engine: ready",
  failed: "Schema engine: failed to load; reload the page to try again",
};

/**
 * What the static site shows instead of the server controls: which commit each schema is from,
 * whether the in-browser engine is ready, and the edit log kept in this browser.
 */
export default function StaticSitePanel({
  profiles,
  onEditsChanged,
}: {
  profiles: ProfileVersion[];
  onEditsChanged: () => void;
}) {
  const [engine, setEngine] = useState<CoreStatus>(coreStatus());
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stop = onCoreStatus(setEngine);
    // Start Pyodide while the user looks at the first, ready-made graph.
    warmUpWorker();
    return () => {
      stop();
    };
  }, []);

  const downloadLog = async () => {
    const log = (await getStaticBackend()).edits.exportLog();
    const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "schema-studio-edits.json";
    a.click();
    URL.revokeObjectURL(url);
    setMessage(`Downloaded ${log.edits.length} edit${log.edits.length === 1 ? "" : "s"}.`);
  };

  const loadLog = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const count = (await getStaticBackend()).edits.importLog(JSON.parse(await file.text()));
      setMessage(`Loaded ${count} edit${count === 1 ? "" : "s"}.`);
      onEditsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div style={{ marginTop: 12 }} data-testid="static-site-panel">
      <div className="small" style={{ color: "var(--muted)" }}>
        Schemas as of:
        {profiles.map(profile => (
          <div key={profile.key}>
            {profile.label}: <code>{profile.version ? profile.version.slice(0, 9) : "unknown"}</code>
          </div>
        ))}
      </div>
      <div className="small" role="status" style={{ marginTop: 6, color: engine === "failed" ? "#fca5a5" : "var(--muted)" }}>
        {ENGINE_TEXT[engine]}
      </div>
      <div className="small" style={{ marginTop: 6, color: "var(--muted)" }}>
        Your edits are stored only in this browser. Download them to keep them or to move them to another browser.
      </div>
      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <button className="btn secondary" type="button" onClick={downloadLog}>
          Download edits
        </button>
        <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()}>
          Load edits
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={loadLog} aria-label="Edit log file" />
      </div>
      {message ? <div className="small" style={{ marginTop: 6, color: "var(--muted)" }}>{message}</div> : null}
    </div>
  );
}

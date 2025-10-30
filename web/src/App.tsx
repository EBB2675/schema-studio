import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import GraphView from "./GraphView";

type ApiGraph = {
  package: string;
  root: string | null;
  nodes: any[];
  edges: any[];
};

const DEFAULT_API = "http://localhost:5179";

export default function App() {
  const [apiBase, setApiBase] = useState<string>(DEFAULT_API);
  const [pkg, setPkg] = useState<string>("nomad_simulations.schema_packages.model_method");
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string>("ModelMethod");

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [umlMode, setUmlMode] = useState<boolean>(true);

  const [crossModules, setCrossModules] = useState<boolean>(true);
  const [namespace, setNamespace] = useState<string>("nomad_simulations.schema_packages");

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // --- branch diff state ---
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [headBranch, setHeadBranch] = useState<string>("");
  const [diffData, setDiffData] = useState<any | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  const api = useMemo(() => axios.create({ baseURL: apiBase }), [apiBase]);

  // roots for selected package
  const loadRoots = async () => {
    setErr(null);
    try {
      const r = await api.get("/roots", { params: { package: pkg } });
      const list = r.data.sections || [];
      setRoots(list);
      if (list.length > 0 && !list.includes(root)) setRoot(list[0]);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setRoots([]);
    }
  };

  // build single-branch graph (resets diff view)
  const loadGraph = async () => {
    setErr(null);
    setLoading(true);
    setDiffData(null);
    try {
      const r = await api.get("/schema", {
        params: {
          package: pkg,
          root,
          include_quantities: includeQuantities,
          include_subsections: includeSubsections,
          allow_cross_module: crossModules,
          base_namespace: namespace || undefined
        }
      });
      setGraph(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  };

  // fetch git branches
  const loadBranches = async () => {
    try {
      const r = await api.get("/git/branches");
      setBranches(r.data.branches || []);
    } catch (e) {
      // keep silent in UI; dropdown will just be empty
      console.error("Failed to load branches", e);
    }
  };

  // compare base/head using SAME filters as sidebar
  const compareBranches = async () => {
    if (!baseBranch || !headBranch) return;
    setErr(null);
    setDiffLoading(true);
    setGraph(null); // switch to diff mode
    try {
      const r = await api.post(
        "/graph/diff",
        {
          base: baseBranch,
          head: headBranch,
          package: pkg
        },
        {
          params: {
            root,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            allow_cross_module: crossModules,
            base_namespace: namespace || undefined
          }
        }
      );
      setDiffData(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setDiffData(null);
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    loadRoots();
    loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main>
      <aside className="sidebar">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Schema UML</h3>
          <span className="small">{loading || diffLoading ? "Loading…" : ""}</span>
        </div>

        <label className="label" style={{ marginTop: 12 }}>API base</label>
        <input
          className="input"
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          placeholder="http://localhost:5179"
        />

        <label className="label" style={{ marginTop: 12 }}>Package (module)</label>
        <input
          className="input"
          value={pkg}
          onChange={(e) => setPkg(e.target.value)}
          placeholder="nomad_simulations.schema_packages.model_method"
        />

        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={loadRoots}>Load roots</button>
          <span className="small">{roots.length ? `${roots.length} sections` : ""}</span>
        </div>

        <label className="label" style={{ marginTop: 12 }}>Root section</label>
        <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
          {roots.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <hr />

        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={includeQuantities}
              onChange={(e) => setIncludeQuantities(e.target.checked)}
            />{" "}
            Quantities
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeSubsections}
              onChange={(e) => setIncludeSubsections(e.target.checked)}
            />{" "}
            Subsections
          </label>
        </div>

        <div className="row" style={{ marginTop: 6 }}>
          <label>
            <input
              type="checkbox"
              checked={umlMode}
              onChange={(e) => setUmlMode(e.target.checked)}
            />{" "}
            UML mode
          </label>
        </div>

        <div className="row" style={{ marginTop: 6 }}>
          <label>
            <input
              type="checkbox"
              checked={crossModules}
              onChange={(e) => setCrossModules(e.target.checked)}
            />{" "}
            Cross-modules
          </label>
        </div>

        <label className="label" style={{ marginTop: 8 }}>Base namespace (optional)</label>
        <input
          className="input"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          placeholder="nomad_simulations.schema_packages"
        />

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={loadGraph}>Build graph</button>
          {graph ? (
            <button
              className="btn secondary"
              onClick={() => {
                const s =
                  "data:text/json;charset=utf-8," +
                  encodeURIComponent(JSON.stringify(graph, null, 2));
                const a = document.createElement("a");
                a.href = s;
                a.download = `${graph.package}_${graph.root || "all"}.json`;
                a.click();
              }}
            >
              Export JSON
            </button>
          ) : null}
        </div>

        {err ? (
          <p style={{ color: "#b91c1c", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
        ) : null}

        {/* --- Branch comparison --- */}
        <hr />
        <h4 style={{ marginTop: 10 }}>Compare branches</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label>Base branch</label>
          <select className="select" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
            <option value="">—</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <label>Head branch</label>
          <select className="select" value={headBranch} onChange={(e) => setHeadBranch(e.target.value)}>
            <option value="">—</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <button className="btn" onClick={compareBranches} disabled={!baseBranch || !headBranch || diffLoading}>
            {diffLoading ? "Comparing…" : "Compare"}
          </button>
        </div>
      </aside>

      <div className="graph">
        {diffData ? (
          <>
            <div style={{ padding: "6px 8px", fontSize: 12, background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              Base: {diffData.base.branch} ({diffData.base.sha.slice(0, 7)}) → Head: {diffData.head.branch} ({diffData.head.sha.slice(0, 7)}){" "}
              <span style={{ marginLeft: 12 }}>
                <span style={{ color: "#16a34a" }}>🟩 Added</span> •{" "}
                <span style={{ color: "#ca8a04" }}>🟨 Changed</span> •{" "}
                <span style={{ color: "#dc2626" }}>🟥 Removed</span>
              </span>
            </div>
            <GraphView
              nodes={diffData.head.graph.nodes}
              edges={diffData.head.graph.edges}
              diff={diffData.diff}
            />
          </>
        ) : graph ? (
          <GraphView nodes={graph.nodes} edges={graph.edges} />
        ) : (
          <div style={{ padding: 24, color: "#6b7280" }}>
            No graph yet. Select a package, load roots, pick a root, then “Build graph”; or compare two branches.
          </div>
        )}
      </div>
    </main>
  );
}

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
  const [umlMode, setUmlMode] = useState<boolean>(true); // Currently always using UML renderer

  const [crossModules, setCrossModules] = useState<boolean>(true);
  const [namespace, setNamespace] = useState<string>("nomad_simulations.schema_packages");

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const api = useMemo(() => axios.create({ baseURL: apiBase }), [apiBase]);

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

  const loadGraph = async () => {
    setErr(null);
    setLoading(true);
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
      // debug
      // console.log("Graph response", r.data);
      setGraph(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRoots();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main>
      <aside className="sidebar">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Schema UML</h3>
          <span className="small">{loading ? "Loading…" : ""}</span>
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

        {/* NEW controls */}
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
      </aside>

      <div className="graph">
        {graph ? (
          <GraphView nodes={graph.nodes} edges={graph.edges} />
        ) : (
          <div style={{ padding: 24, color: "#6b7280" }}>
            No graph yet. Select a package, load roots, pick a root, then “Build graph”.
          </div>
        )}
      </div>
    </main>
  );
}
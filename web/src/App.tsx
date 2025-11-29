import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import GraphView, { type GraphExportHandle } from "./GraphView";
import DocPanel from "./components/DocPanel";
import OverviewGrid from "./components/OverviewGrid";
import UnderTheHoodPanel from './components/UnderTheHoodPanel';
import AddQuantityForm from "./components/AddQuantityForm";
import CollapsibleSection from "./components/CollapsibleSection";
import { useSelection } from "./store/selection";
import { jsPDF } from "jspdf";

type ApiGraph = {
  package: string;
  root: string | null;
  nodes: any[];
  edges: any[];
};

const DEFAULT_API = "http://localhost:5179";
const DEFAULT_PACKAGE = import.meta.env.VITE_DEFAULT_PACKAGE ?? "nomad_simulations.schema_packages.model_method";
const DEFAULT_NAMESPACE =
  import.meta.env.VITE_DEFAULT_NAMESPACE ??
  "nomad_simulations.schema_packages,nomad_measurements.schema_packages";
const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT ?? "ModelMethod";
const DEFAULT_BRANCH = import.meta.env.VITE_DEFAULT_BRANCH ?? "develop";

export default function App() {
  const [apiBase, setApiBase] = useState<string>(DEFAULT_API);
  const [pkg, setPkg] = useState<string>(DEFAULT_PACKAGE);
  const [availablePkgs, setAvailablePkgs] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string>(DEFAULT_ROOT);

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [umlMode, setUmlMode] = useState<boolean>(true);

  const [crossModules, setCrossModules] = useState<boolean>(true);
  const [namespace, setNamespace] = useState<string>(DEFAULT_NAMESPACE);

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // appearance
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("schema-uml-theme");
    const initial = stored === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", initial);
    return initial;
  });

  // branch diff state
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [headBranch, setHeadBranch] = useState<string>("");
  const [diffData, setDiffData] = useState<any | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  // editable mode
  const [editableMode, setEditableMode] = useState<boolean>(false);
  const [addLoading, setAddLoading] = useState<boolean>(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const [exportHandle, setExportHandle] = useState<GraphExportHandle | null>(null);

  const { selected, setSelected } = useSelection();

  // overview mode
  const [mode, setMode] = useState<"graph" | "overview">("graph");
  const [overviewBranch, setOverviewBranch] = useState<string>(DEFAULT_BRANCH);

  const api = useMemo(() => axios.create({ baseURL: apiBase }), [apiBase]);
  const normalizedNamespace = useMemo(() => {
    const parts = namespace.split(",").map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(",") : DEFAULT_NAMESPACE;
  }, [namespace]);

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
    setExportHandle(null);
    try {
      const r = await api.get("/schema", {
        params: {
          package: pkg,
          root,
          include_quantities: includeQuantities,
          include_subsections: includeSubsections,
          allow_cross_module: crossModules,
          base_namespace: normalizedNamespace || undefined,
        },
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

  // fetch available schema packages from develop branch
  const loadPackages = async () => {
    try {
      const r = await api.get("/git/packages", {
        params: {
          branch: DEFAULT_BRANCH,
          base_package: normalizedNamespace,
        },
      });
      const list: string[] = r.data.packages || [];
      setAvailablePkgs(list);

      // if current pkg is not in the list, default to the first entry
      if (list.length > 0 && !list.includes(pkg)) {
        setPkg(list[0]);
      }
    } catch (e) {
      // silent failure is fine; user can still type manually
      console.error("Failed to load packages", e);
    }
  };

  // compare base/head using same filters as sidebar
  const compareBranches = async () => {
    if (!baseBranch || !headBranch) return;
    setErr(null);
    setDiffLoading(true);
    setGraph(null); // switch to diff mode
    setExportHandle(null);
    try {
      const r = await api.post(
        "/graph/diff",
        {
          base: baseBranch,
          head: headBranch,
          package: pkg,
        },
        {
          params: {
            root,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
          },
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

  const refreshSelectionQuantities = (nextGraph: ApiGraph) => {
    if (!selected || selected.kind !== "class") return;
    const quantities = (nextGraph.nodes || [])
      .filter((n: any) => n.kind === "quantity" && n.owner === selected.id)
      .map((n: any) => ({
        id: n.id,
        name: n.label,
        dtype: n.dtype ?? undefined,
        shape: n.shape ?? undefined,
        card: n.card ?? undefined,
        doc: n.doc ?? undefined,
        path: n.path ?? undefined,
        line: typeof n.line === "number" ? n.line : undefined,
        owner: n.owner ?? selected.id
      }));

    setSelected({ ...selected, quantities });
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("schema-uml-theme", theme);
  }, [theme]);

  const addCustomQuantity = async ({ quantityName, dtype, docstring }: { quantityName: string; dtype: string; docstring: string }) => {
    if (!graph) {
      setAddErr("Build a graph first to add a quantity.");
      return;
    }
    if (!selected || selected.kind !== "class") {
      setAddErr("Select a class node to attach the quantity.");
      return;
    }

    setAddLoading(true);
    setAddErr(null);
    try {
      const r = await api.post(
        "/schema/custom-quantity",
        {
          package: pkg,
          class_name: selected.name,
          quantity_name: quantityName,
          dtype,
          docstring: docstring || null,
        },
        {
          params: {
          root,
          include_subsections: includeSubsections,
          allow_cross_module: crossModules,
          base_namespace: normalizedNamespace || undefined,
        },
      }
    );
      const updated = r.data as ApiGraph;
      setGraph(updated);
      refreshSelectionQuantities(updated);
    } catch (e: any) {
      setAddErr(e?.response?.data?.detail || String(e));
    } finally {
      setAddLoading(false);
    }
  };

  useEffect(() => {
    loadRoots();
    loadBranches();
    loadPackages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedClassName = selected?.kind === "class" ? selected.name : null;
  const addBlockedReason =
    mode !== "graph"
      ? "Switch to diagram view to add quantities"
      : diffData
        ? "Exit branch comparison to add quantities"
        : !graph
          ? "Build a graph first to add quantities"
          : null;

  const currentGraph = diffData ? diffData.head?.graph ?? null : graph;

  const exportJson = () => {
    if (!currentGraph) return;
    const s =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(currentGraph, null, 2));
    const a = document.createElement("a");
    a.href = s;
    a.download = `${currentGraph.package}_${currentGraph.root || "all"}.json`;
    a.click();
  };

  const exportPdf = () => {
    if (!currentGraph || !exportHandle) return;

    const png = exportHandle.toPng();
    if (!png) return;

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const props = pdf.getImageProperties(png);

    const ratio = Math.min(pageWidth / props.width, pageHeight / props.height);
    const w = props.width * ratio;
    const h = props.height * ratio;
    const x = (pageWidth - w) / 2;
    const y = (pageHeight - h) / 2;

    pdf.addImage(png, "PNG", x, y, w, h);
    pdf.save(`${currentGraph.package}_${currentGraph.root || "all"}.pdf`);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <p className="eyebrow">Schema explorer</p>
          <h3 className="brand-title">
            <span className="pulse" />
            Schema UML
          </h3>
          <p className="subdued">Craft diagrams, compare branches, and publish docs.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="tag">{loading || diffLoading ? "Working…" : "Ready"}</span>
            {selectedClassName ? <span className="tag">Selected: {selectedClassName}</span> : null}
          </div>
        </div>

        <CollapsibleSection title="Appearance" hint="Dark vs light ambience">
          <div className="toggle-group">
            <button
              className={`toggle-chip ${theme === "dark" ? "active" : ""}`}
              onClick={() => setTheme("dark")}
            >
              Dark
            </button>
            <button
              className={`toggle-chip ${theme === "light" ? "active" : ""}`}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Workspace" hint="Switch modes on the fly">
          <div className="row" style={{ gap: 10 }}>
            <button
              className="btn"
              onClick={() => setMode((m) => (m === "overview" ? "graph" : "overview"))}
              title="Toggle bird's-eye view"
            >
              {mode === "overview" ? "Back to diagram" : "Bird's-eye view"}
            </button>
            {mode === "overview" && (
              <div style={{ flex: 1 }}>
                <label className="label" style={{ margin: 0 }}>Branch</label>
                <select
                  className="select"
                  value={overviewBranch}
                  onChange={(e) => setOverviewBranch(e.target.value)}
                >
                  {[DEFAULT_BRANCH, ...branches.filter((b) => b !== DEFAULT_BRANCH)].map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="API & package" hint="Connect to a backend">
          <div className="action-stack">
            <div>
              <label className="label">API base</label>
              <input
                className="input"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="http://localhost:5179"
              />
            </div>

            <div>
              <label className="label">Package (module)</label>
              <input
                className="input"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder={DEFAULT_PACKAGE}
              />
            </div>

            {availablePkgs.length > 0 && (
              <div>
                <label className="label">Choose from {DEFAULT_BRANCH}</label>
                <select
                  className="select"
                  value={availablePkgs.includes(pkg) ? pkg : ""}
                  onChange={(e) => setPkg(e.target.value)}
                >
                  <option value="">Custom module...</option>
                  {availablePkgs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <label className="label">Root section</label>
                <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
                  {roots.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">&nbsp;</label>
                <button className="btn" onClick={loadRoots}>
                  Load roots
                </button>
                <div className="small">{roots.length ? `${roots.length} sections` : ""}</div>
              </div>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Diagram filters" hint="Fine-tune the graph">
          <div className="control-grid">
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={includeQuantities}
                onChange={(e) => setIncludeQuantities(e.target.checked)}
              />
              Quantities
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={includeSubsections}
                onChange={(e) => setIncludeSubsections(e.target.checked)}
              />
              Subsections
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={umlMode}
                onChange={(e) => setUmlMode(e.target.checked)}
              />
              UML mode
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={crossModules}
                onChange={(e) => setCrossModules(e.target.checked)}
              />
              Cross-modules
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="label">Base namespace (supports comma-separated)</label>
            <input
              className="input"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder={DEFAULT_NAMESPACE}
            />
          </div>

          <div className="row" style={{ marginTop: 14, justifyContent: "space-between", gap: 10 }}>
            <button className="btn" onClick={loadGraph}>
              Build graph
            </button>
            {currentGraph ? (
              <div className="row" style={{ flex: 1, justifyContent: "flex-end" }}>
                <button className="btn secondary" onClick={exportJson}>
                  Export JSON
                </button>
                <button
                  className="btn secondary"
                  onClick={exportPdf}
                  disabled={!exportHandle}
                  title={exportHandle ? "Download current diagram as PDF" : "Build a graph first"}
                >
                  Export PDF
                </button>
              </div>
            ) : null}
          </div>

          {err ? (
            <p style={{ color: "#fca5a5", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
          ) : null}
        </CollapsibleSection>

        <CollapsibleSection title="Editable mode" hint="Prototype new quantities">
          <div className="row" style={{ marginBottom: 6 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={editableMode}
                onChange={(e) => {
                  setEditableMode(e.target.checked);
                  setAddErr(null);
                }}
              />
              Editable mode
            </label>
            {addBlockedReason && <span className="small">{addBlockedReason}</span>}
          </div>

          <AddQuantityForm
            enabled={editableMode && !addBlockedReason}
            blockedReason={addBlockedReason}
            targetClass={selectedClassName}
            onSubmit={addCustomQuantity}
            submitting={addLoading}
            error={addErr}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Compare branches" hint="Diff diagrams across git">
          <div className="action-stack">
            <div>
              <label className="label">Base branch</label>
              <select
                className="select"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
              >
                <option value="">-</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Head branch</label>
              <select
                className="select"
                value={headBranch}
                onChange={(e) => setHeadBranch(e.target.value)}
              >
                <option value="">-</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="btn"
              onClick={compareBranches}
              disabled={!baseBranch || !headBranch || diffLoading}
            >
              {diffLoading ? "Comparing…" : "Compare"}
            </button>
          </div>
        </CollapsibleSection>
      </aside>

      {/* Main workspace: Graph + Doc Panel side-by-side */}
      <div className="workspace">
        {/* Left: graph area */}
        <div style={{ minWidth: 0 }}>
          {mode === "overview" ? (
            <OverviewGrid apiBase={apiBase} branch={overviewBranch} base={normalizedNamespace} />
          ) : diffData ? (
            <>
              <div className="workspace-toolbar">
                <div>
                  Base: {diffData.base.branch} ({diffData.base.sha.slice(0, 7)}) → Head: {diffData.head.branch}
                  ({diffData.head.sha.slice(0, 7)})
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <span className="pill">🟩 Added</span>
                  <span className="pill" style={{ background: "rgba(234, 179, 8, 0.18)", color: "#fef9c3" }}>
                    🟨 Changed
                  </span>
                  <span className="pill" style={{ background: "rgba(248, 113, 113, 0.16)", color: "#fecdd3" }}>
                    🟥 Removed
                  </span>
                </div>
              </div>
              <GraphView
                nodes={diffData.head.graph.nodes}
                edges={diffData.head.graph.edges}
                diff={diffData.diff}
                onReady={setExportHandle}
              />
            </>
          ) : graph ? (
            <GraphView nodes={graph.nodes} edges={graph.edges} onReady={setExportHandle} />
          ) : (
            <div className="empty-state">
              <div style={{ fontSize: 18, marginBottom: 8 }}>Build a diagram to get started</div>
              <div>Select a package, load roots, pick a root, then “Build graph”; or compare two branches.</div>
            </div>
          )}
        </div>

        {/* Right: DocPanel (top) + Under-the-hood (bottom) */}
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            borderLeft: "1px solid var(--panel-border)",
            padding: "10px",
            gap: "10px"
          }}
        >
          {/* TOP PANEL — about 60% */}
          <div
            style={{
              flex: 6,
              minHeight: 0,
              overflowY: "auto"
            }}
          >
            <CollapsibleSection title="Documentation" hint="Inspect the selected class" className="panel">
              <DocPanel />
            </CollapsibleSection>
          </div>

          {/* BOTTOM PANEL — about 40% */}
          <div
            style={{
              flex: 4,
              minHeight: 0,
              overflowY: "auto"
            }}
          >
            <CollapsibleSection title="Under the hood" hint="Raw schema structure" className="panel">
              <UnderTheHoodPanel apiBase={apiBase} />
            </CollapsibleSection>
          </div>
        </div>
      </div>
    </main>
  );
}

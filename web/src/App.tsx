import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import GraphView, { type GraphExportHandle } from "./GraphView";
import DocPanel from "./components/DocPanel";
import OverviewGrid from "./components/OverviewGrid";
import UnderTheHoodPanel from "./components/UnderTheHoodPanel";
import AddQuantityForm from "./components/AddQuantityForm";
import type { QuantityFormData } from "./components/quantityShared";
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
  "nomad_simulations.schema_packages";
const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT ?? "ModelMethod";
const DEFAULT_BRANCH = import.meta.env.VITE_DEFAULT_BRANCH ?? "develop";
const WORKSPACE_PRESETS = [
  {
    label: "nomad-simulations",
    namespace: "nomad_simulations.schema_packages",
    branch: "develop",
    pkg: "nomad_simulations.schema_packages.model_method",
    root: "ModelMethod",
  },
  {
    label: "nomad-measurements",
    namespace: "nomad_measurements",
    branch: "main",
    pkg: "nomad_measurements.general",
    root: "InSituMeasurement",
  },
];

export default function App() {
  const apiBase = DEFAULT_API;
  const [pkg, setPkg] = useState<string>(DEFAULT_PACKAGE);
  const [availablePkgs, setAvailablePkgs] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string>(DEFAULT_ROOT);

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [showQuantityMetadata, setShowQuantityMetadata] = useState<boolean>(true);

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

  const appShellRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 360;
    const stored = Number.parseInt(window.localStorage.getItem("schema-uml-left-width") || "", 10);
    return Number.isFinite(stored) ? stored : 360;
  });
  const [docPanelWidth, setDocPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 380;
    const stored = Number.parseInt(window.localStorage.getItem("schema-uml-doc-width") || "", 10);
    return Number.isFinite(stored) ? stored : 380;
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
  const [quantityActionErr, setQuantityActionErr] = useState<string | null>(null);

  const [graphHandle, setGraphHandle] = useState<GraphExportHandle | null>(null);

  const { selected, setSelected } = useSelection();

  const clearQuantityActionError = useCallback(() => setQuantityActionErr(null), []);

  // overview mode
  const [mode, setMode] = useState<"graph" | "overview">("graph");
  const [overviewBranch, setOverviewBranch] = useState<string>(DEFAULT_BRANCH);
  const [packageBranch, setPackageBranch] = useState<string>(DEFAULT_BRANCH);

  const api = useMemo(() => axios.create({ baseURL: apiBase }), []);
  const normalizedNamespace = useMemo(() => {
    const parts = namespace.split(",").map((p) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(",") : DEFAULT_NAMESPACE;
  }, [namespace]);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const clampDocWidth = useCallback((value: number) => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect()?.width ?? 0;
    const minGraphWidth = 380;
    const maxByViewport = workspaceWidth
      ? Math.max(260, workspaceWidth - minGraphWidth - 10)
      : 640;

    return clamp(value, 260, Math.min(640, maxByViewport));
  }, []);

  const setSidebarWidthClamped = useCallback(
    (value: number) => setSidebarWidth(clamp(value, 260, 520)),
    []
  );
  const setDocPanelWidthClamped = useCallback(
    (value: number) => setDocPanelWidth(clampDocWidth(value)),
    [clampDocWidth]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("schema-uml-left-width", String(clamp(sidebarWidth, 260, 520)));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("schema-uml-doc-width", String(clampDocWidth(docPanelWidth)));
  }, [clampDocWidth, docPanelWidth]);

  useEffect(() => {
    if (!graphHandle) return;

    graphHandle.refit();
    const t1 = window.setTimeout(() => graphHandle.refit(), 120);
    const t2 = window.setTimeout(() => graphHandle.refit(), 360);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [graphHandle, sidebarWidth, docPanelWidth]);

  useEffect(() => {
    setDocPanelWidth((w) => clampDocWidth(w));
  }, [clampDocWidth]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      setDocPanelWidth((w) => clampDocWidth(w));
    });

    if (workspaceRef.current) observer.observe(workspaceRef.current);

    return () => observer.disconnect();
  }, [clampDocWidth]);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = appShellRef.current?.getBoundingClientRect();
    const offsetLeft = rect?.left ?? 0;

    const onMove = (evt: MouseEvent) => {
      const next = evt.clientX - offsetLeft;
      setSidebarWidthClamped(next);
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const startDocResize = (e: React.MouseEvent) => {
    e.preventDefault();

    const onMove = (evt: MouseEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = rect.right - evt.clientX;
      setDocPanelWidthClamped(next);
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

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
  const loadGraph = async (
    overrides?: { pkg?: string; root?: string; namespace?: string; branch?: string }
  ) => {
    const pkgToUse = overrides?.pkg ?? pkg;
    const rootToUse = overrides?.root ?? root;
    const namespaceToUse = overrides?.namespace ?? normalizedNamespace;
    const branchToUse = overrides?.branch ?? "";
    setErr(null);
    setQuantityActionErr(null);
    setLoading(true);
    setDiffData(null);
    setGraphHandle(null);
    try {
      if (branchToUse) {
        const r = await api.post(
          "/graph",
          {
            branch: branchToUse,
            package: pkgToUse,
          },
          {
            params: {
              root: rootToUse,
              include_quantities: includeQuantities,
              include_subsections: includeSubsections,
              allow_cross_module: crossModules,
              base_namespace: namespaceToUse || undefined,
            },
          }
        );
        setGraph(r.data?.graph ?? null);
      } else {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
          },
        });
        setGraph(r.data);
      }
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
      const r = await api.get("/git/branches", { params: { base_package: normalizedNamespace } });
      setBranches(r.data.branches || []);
    } catch (e) {
      // keep silent in UI; dropdown will just be empty
      console.error("Failed to load branches", e);
    }
  };

  // fetch available schema packages from develop branch
  const loadPackages = async () => {
    setErr(null);
    try {
      const r = await api.get("/git/packages", {
        params: {
          branch: packageBranch,
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
      // surface the error so users know why the dropdown is empty
      setErr((e as any)?.response?.data?.detail || String(e));
    }
  };

  // compare base/head using same filters as sidebar
  const compareBranches = async () => {
    if (!baseBranch || !headBranch) return;
    setErr(null);
    setQuantityActionErr(null);
    setDiffLoading(true);
    setGraph(null); // switch to diff mode
    setGraphHandle(null);
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
        dtype: n.dtype ?? n.data_type ?? n.type ?? undefined,
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
      setQuantityActionErr(null);
    } catch (e: any) {
      setAddErr(e?.response?.data?.detail || String(e));
    } finally {
      setAddLoading(false);
    }
  };

  useEffect(() => {
    loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  useEffect(() => {
    loadBranches();
    loadPackages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedNamespace, packageBranch]);

  const selectedClassName = selected?.kind === "class" ? selected.name : null;
  const addBlockedReason =
    mode !== "graph"
      ? "Switch to diagram view to modify quantities"
      : diffData
        ? "Exit branch comparison to modify quantities"
        : !graph
          ? "Build a graph first to modify quantities"
          : null;

  const currentGraph = diffData ? diffData.head?.graph ?? null : graph;

  const focusRootSection = useCallback(() => {
    const targetRoot = currentGraph?.root || root;
    if (!targetRoot) return;

    const handled = graphHandle?.focusNode(targetRoot);
    if (handled) return;

    const fallbackNode = currentGraph?.nodes?.find?.((n: any) => {
      const label = (n as any).label || (n as any).rawName;
      return n.id === targetRoot || label === targetRoot;
    }) as any;

    if (fallbackNode) {
      setSelected({
        id: fallbackNode.id,
        kind: "class",
        name: fallbackNode.label || fallbackNode.id,
        doc: fallbackNode.doc || "",
        path: fallbackNode.path || "",
        line: typeof fallbackNode.line === "number" ? fallbackNode.line : undefined,
        fqid:
          fallbackNode.module && (fallbackNode.label || fallbackNode.id)
            ? `${fallbackNode.module}.${fallbackNode.label || fallbackNode.id}`
            : fallbackNode.id,
      });
    }
  }, [currentGraph, graphHandle, root, setSelected]);

  useEffect(() => {
    focusRootSection();
  }, [focusRootSection]);

  const handleOverviewClassSelect = (pkgName: string, className: string) => {
    setMode("graph");
    setPkg(pkgName);
    setRoot(className);
    setPackageBranch((prev) => prev || overviewBranch);
    setRoots((prev) => (prev.includes(className) ? prev : [className, ...prev]));
    loadGraph({
      pkg: pkgName,
      root: className,
      namespace: normalizedNamespace,
      branch: overviewBranch,
    });
  };

  const ensureEditableReady = () => {
    if (addBlockedReason) {
      setQuantityActionErr(addBlockedReason);
      return null;
    }
    if (!editableMode) {
      setQuantityActionErr("Enable editable mode to edit or remove quantities.");
      return null;
    }
    if (!graph) {
      setQuantityActionErr("Build a graph first to modify quantities.");
      return null;
    }
    return graph;
  };

  const editQuantity = (quantityId: string, updates: QuantityFormData) => {
    const current = ensureEditableReady();
    if (!current) return;

    const target = current.nodes.find((n) => n.id === quantityId && n.kind === "quantity");
    if (!target) {
      setQuantityActionErr("Quantity not found in current graph.");
      return;
    }
    if (!target.owner) {
      setQuantityActionErr("Cannot edit a quantity without an owner.");
      return;
    }

    const trimmedName = updates.quantityName.trim();
    if (!trimmedName) {
      setQuantityActionErr("Quantity name cannot be empty.");
      return;
    }

    const newId = `${target.owner}.${trimmedName}`;
    const conflict = current.nodes.some(
      (n) => n.kind === "quantity" && n.owner === target.owner && n.id !== quantityId && (n.id === newId || n.label === trimmedName)
    );
    if (conflict) {
      setQuantityActionErr("A quantity with that name already exists on this class.");
      return;
    }

    const nextNodes = current.nodes.map((n) => {
      if (n.id !== quantityId) return n;
      return { ...n, id: newId, label: trimmedName, doc: updates.docstring || null, dtype: updates.dtype };
    });

    const nextEdges = current.edges.map((e) => {
      if (e.source === quantityId) return { ...e, source: newId };
      if (e.target === quantityId) return { ...e, target: newId };
      return e;
    });

    const nextGraph = { ...current, nodes: nextNodes, edges: nextEdges };
    setGraph(nextGraph);
    refreshSelectionQuantities(nextGraph);
    setQuantityActionErr(null);

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelected({ ...selected, id: newId, name: trimmedName, doc: updates.docstring, dtype: updates.dtype, owner: selected.owner });
    }
  };

  const removeQuantity = (quantityId: string) => {
    const current = ensureEditableReady();
    if (!current) return;

    const target = current.nodes.find((n) => n.id === quantityId && n.kind === "quantity");
    if (!target) {
      setQuantityActionErr("Quantity not found in current graph.");
      return;
    }
    if (!target.owner) {
      setQuantityActionErr("Cannot remove a quantity without an owner.");
      return;
    }

    const nextNodes = current.nodes.filter((n) => n.id !== quantityId);
    const nextEdges = current.edges.filter((e) => e.source !== quantityId && e.target !== quantityId);
    const nextGraph = { ...current, nodes: nextNodes, edges: nextEdges };

    setGraph(nextGraph);
    refreshSelectionQuantities(nextGraph);
    setQuantityActionErr(null);

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelected(null);
    }
  };

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
    if (!currentGraph || !graphHandle) return;

    const png = graphHandle.toPng();
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
    <main
      className="app-shell"
      ref={appShellRef}
      style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}
    >
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
          <div style={{ marginTop: 12 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              Appearance
            </div>
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
          </div>
        </div>

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
                  {[overviewBranch || DEFAULT_BRANCH, ...branches.filter((b) => b !== overviewBranch)].map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="toggle-group" style={{ marginTop: 10 }}>
            {WORKSPACE_PRESETS.map((ws) => (
              <button
                key={ws.namespace}
                className={`toggle-chip ${normalizedNamespace === ws.namespace ? "active" : ""}`}
                onClick={() => {
                  setNamespace(ws.namespace);
                  if (ws.branch) {
                    setOverviewBranch(ws.branch);
                    setPackageBranch(ws.branch);
                  }
                  if (ws.pkg) setPkg(ws.pkg);
                  if (ws.root) setRoot(ws.root);
                }}
                title={`Set base namespace to ${ws.namespace}`}
              >
                {ws.label}
              </button>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Package & filters" hint="Pick a backend package and fine-tune the graph">
          <div className="action-stack">
            <div>
              <label className="label">Package</label>
              <input
                className="input"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder={DEFAULT_PACKAGE}
              />
            </div>

            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label className="label">Choose from branch</label>
                <select
                  className="select"
                  value={packageBranch}
                  onChange={(e) => setPackageBranch(e.target.value)}
                >
                  {[packageBranch || DEFAULT_BRANCH, ...branches.filter((b) => b !== packageBranch)].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn secondary" onClick={loadPackages} style={{ whiteSpace: "nowrap" }}>
                Refresh packages
              </button>
            </div>

            <div>
              <label className="label">Choose from {packageBranch || DEFAULT_BRANCH}</label>
              <select
                className="select"
                value={availablePkgs.includes(pkg) ? pkg : ""}
                onChange={(e) => setPkg(e.target.value)}
              >
                <option value="">Custom package...</option>
                {availablePkgs.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Root section</label>
              <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
                {roots.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div className="small" style={{ marginTop: 4 }}>
                {roots.length ? `${roots.length} sections` : ""}
              </div>
            </div>

            <div className="control-grid" style={{ marginTop: 4 }}>
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
                  checked={showQuantityMetadata}
                  onChange={(e) => setShowQuantityMetadata(e.target.checked)}
                />
                Show dtypes & shapes
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
                  checked={crossModules}
                  onChange={(e) => setCrossModules(e.target.checked)}
                />
                Cross-modules
              </label>
            </div>

            <div className="row" style={{ marginTop: 14, justifyContent: "space-between", gap: 10 }}>
              <button className="btn" onClick={() => loadGraph()}>
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
                    disabled={!graphHandle}
                    title={graphHandle ? "Download current diagram as PDF" : "Build a graph first"}
                  >
                    Export PDF
                  </button>
                </div>
              ) : null}
            </div>

            {err ? (
              <p style={{ color: "#fca5a5", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
            ) : null}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Under the hood" hint="Raw schema structure">
          <UnderTheHoodPanel apiBase={apiBase} />
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
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={startSidebarResize}
        />

      {/* Main workspace: Graph + Doc Panel side-by-side */}
      <div
        className="workspace"
        ref={workspaceRef}
        style={{ gridTemplateColumns: `minmax(0, 1fr) 10px ${docPanelWidth}px` }}
      >
        {/* Left: graph area */}
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            overflow: mode === "overview" ? "auto" : "hidden",
          }}
        >
          {mode === "overview" ? (
            <div style={{ flex: 1, minHeight: 0 }}>
              <OverviewGrid
                apiBase={apiBase}
                branch={overviewBranch}
                base={normalizedNamespace}
                onClassSelect={handleOverviewClassSelect}
              />
            </div>
          ) : diffData ? (
            <>
              <div className="workspace-toolbar">
                <div>
                  Base: {diffData.base.branch} ({diffData.base.sha.slice(0, 7)}) → Head: {diffData.head.branch}
                  ({diffData.head.sha.slice(0, 7)})
                </div>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <button className="btn secondary" type="button" onClick={focusRootSection}>
                    Go to root
                  </button>
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
                showQuantityMetadata={showQuantityMetadata}
                onReady={setGraphHandle}
              />
            </>
          ) : graph ? (
            <>
              <div className="workspace-toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  Root: <strong>{currentGraph?.root || root}</strong>
                  {" "}from <strong>{currentGraph?.package || pkg}</strong>
                </div>
                <button className="btn secondary" type="button" onClick={focusRootSection}>
                  Go to root
                </button>
              </div>
              <GraphView
                nodes={graph.nodes}
                edges={graph.edges}
                showQuantityMetadata={showQuantityMetadata}
                onReady={setGraphHandle}
              />
            </>
          ) : (
            <div className="empty-state">
              <div style={{ fontSize: 18, marginBottom: 8 }}>Build a diagram to get started</div>
              <div>
                Select a package (roots load automatically), pick a root, then “Build graph”; or compare two
                branches.
              </div>
            </div>
          )}
        </div>

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize documentation panel"
          onMouseDown={startDocResize}
        />

        {/* Right: Documentation + quantity editing */}
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
          {/* TOP PANEL — about half */}
          <div
            style={{
              flex: 5,
              minHeight: 0,
              overflowY: "auto"
            }}
          >
            <CollapsibleSection title="Documentation" hint="Browse docs and edit quantities" className="panel">
              <DocPanel
                editableMode={editableMode}
                onRemoveQuantity={removeQuantity}
                onEditQuantity={editQuantity}
                blockedReason={addBlockedReason}
                actionError={quantityActionErr}
                clearActionError={clearQuantityActionError}
              />
            </CollapsibleSection>
          </div>

          {/* BOTTOM PANEL — editable mode controls */}
          <div
            style={{
              flex: 5,
              minHeight: 0,
              overflowY: "auto"
            }}
          >
            <CollapsibleSection
              title="Editable mode"
              hint="Enable editing and add new quantities"
              className="panel"
            >
              <div className="action-stack" style={{ gap: 14 }}>
                <div className="row" style={{ alignItems: "center", gap: 10 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={editableMode}
                      onChange={(e) => {
                        setEditableMode(e.target.checked);
                        setAddErr(null);
                        setQuantityActionErr(null);
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
              </div>
            </CollapsibleSection>
          </div>
        </div>
      </div>
    </main>
  );
}

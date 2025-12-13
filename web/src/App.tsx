import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import GraphView, { type GraphExportHandle } from "./GraphView";
import DocPanel from "./components/DocPanel";
import OverviewGrid from "./components/OverviewGrid";
import UnderTheHoodPanel from "./components/UnderTheHoodPanel";
import type { QuantityFormData } from "./components/quantityShared";
import CollapsibleSection from "./components/CollapsibleSection";
import { useSelection } from "./store/selection";
import { jsPDF } from "jspdf";
import type { AuditTrailEntry, QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";

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
];

type WorkspaceState = {
  branch: string;
  package: string;
  base_namespace: string;
};

export default function App() {
  const apiBase = DEFAULT_API;
  const [token, setToken] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("schema-uml-token") || "";
  });
  const [userName, setUserName] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState<string>("admin");
  const [loginPassword, setLoginPassword] = useState<string>("admin");
  const [pkg, setPkg] = useState<string>(DEFAULT_PACKAGE);
  const [availablePkgs, setAvailablePkgs] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string>(DEFAULT_ROOT);
  const [startEmpty, setStartEmpty] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("schema-uml-start-empty");
    return stored === "true";
  });

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [includeInheritance, setIncludeInheritance] = useState<boolean>(true);
  const [showQuantityMetadata, setShowQuantityMetadata] = useState<boolean>(false);

  const [crossModules, setCrossModules] = useState<boolean>(true);
  const [namespace, setNamespace] = useState<string>(DEFAULT_NAMESPACE);

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [baseGraph, setBaseGraph] = useState<ApiGraph | null>(null);
  const [umlState, setUmlState] = useState<UmlGraphState | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedQuantityId, setSelectedQuantityId] = useState<string | null>(null);
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
  const workspaceStateRef = useRef<WorkspaceState | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
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
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<string | null>(null);

  // branch diff state
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [headBranch, setHeadBranch] = useState<string>("");
  const [diffData, setDiffData] = useState<any | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>((() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("schema-uml-audit");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // drop legacy entries without the new shape
      return parsed.filter((e: any) => e && e.change && e.id && e.timestamp && e.description);
    } catch {
      return [];
    }
  })());

  // editable mode
  const [editableMode, setEditableMode] = useState<boolean>(false);
  const [quantityActionErr, setQuantityActionErr] = useState<string | null>(null);
  const [creatingQuantityFor, setCreatingQuantityFor] = useState<string | null>(null);
  const [creatingClass, setCreatingClass] = useState<boolean>(false);

  const [graphHandle, setGraphHandle] = useState<GraphExportHandle | null>(null);

  const { selected, setSelected } = useSelection();

  const clearQuantityActionError = useCallback(() => setQuantityActionErr(null), []);

  useEffect(() => {
    if (!selected) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      return;
    }
    if (selected.kind === "class") {
      setSelectedClassId(selected.id);
      setSelectedQuantityId(null);
      return;
    }
    if (selected.kind === "quantity" && selected.owner) {
      setSelectedClassId(selected.owner);
      setSelectedQuantityId(selected.id);
    }
  }, [selected]);

  // overview mode
  const [mode, setMode] = useState<"graph" | "overview">("graph");
  const [overviewBranch, setOverviewBranch] = useState<string>(DEFAULT_BRANCH);
  const [packageBranch, setPackageBranch] = useState<string>(DEFAULT_BRANCH);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("schema-uml-audit", JSON.stringify(auditTrail));
      window.localStorage.setItem("schema-uml-start-empty", JSON.stringify(startEmpty));
    } catch {
      // ignore storage errors
    }
  }, [auditTrail, startEmpty]);

  const api = useMemo(() => {
    const instance = axios.create({ baseURL: apiBase });
    instance.interceptors.request.use((config) => {
      if (token) {
        config.headers = config.headers ?? {};
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });
    return instance;
  }, [apiBase, token]);
  const normalizedNamespace = useMemo(() => {
    const parts = namespace.split(",").map((p: string) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(",") : DEFAULT_NAMESPACE;
  }, [namespace]);

  const basePackageForEmpty = useMemo(() => {
    const parts = normalizedNamespace.split(",").map((p: string) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[0];
    }
    // fall back to stripping the last segment of the default package
    const segments = pkg.split(".");
    return segments.slice(0, Math.max(1, segments.length - 1)).join(".");
  }, [normalizedNamespace, pkg]);

  const scratchPackage = useMemo(
    () => `${basePackageForEmpty}.custom_schema`,
    [basePackageForEmpty]
  );

  const emptyCanvasActive = startEmpty && graph?.package === scratchPackage && graph?.root === "";

  const applyWorkspace = useCallback((ws: WorkspaceState | null) => {
    if (!ws) return;
    const prev = workspaceStateRef.current;
    const unchanged =
      prev &&
      prev.branch === ws.branch &&
      prev.package === ws.package &&
      prev.base_namespace === ws.base_namespace;
    if (unchanged) return;

    workspaceStateRef.current = ws;
    setWorkspace(ws);
    if (ws.package) setPkg(ws.package);
    if (ws.base_namespace) setNamespace(ws.base_namespace);
    if (ws.branch) {
      setPackageBranch(ws.branch);
      setOverviewBranch(ws.branch);
      setBaseBranch((prev) => prev || ws.branch);
      setHeadBranch((prev) => prev || ws.branch);
    }
  }, []);

  const syncWorkspaceFromResponse = useCallback(
    (payload: any) => {
      if (payload?.workspace) applyWorkspace(payload.workspace as WorkspaceState);
    },
    [applyWorkspace]
  );

  const updateWorkspaceOnServer = useCallback(
    async (updates: Partial<WorkspaceState>) => {
      if (!token) return;
      try {
        const res = await api.put("/workspace", updates);
        applyWorkspace(res.data.workspace as WorkspaceState);
      } catch (error) {
        console.error("Failed to update workspace", error);
      }
    },
    [api, applyWorkspace, token]
  );

  const logout = useCallback(() => {
    setToken("");
    setWorkspace(null);
    workspaceStateRef.current = null;
    setUserName(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("schema-uml-token");
    }
  }, []);

  const appendAudit = useCallback((change: AuditTrailEntry["change"], description: string) => {
    const now = new Date().toISOString();
    const id = `${now}-${Math.random().toString(16).slice(2)}`;
    setAuditTrail((prev) => [...prev, { change, description, id, timestamp: now }]);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (token) {
      window.localStorage.setItem("schema-uml-token", token);
    } else {
      window.localStorage.removeItem("schema-uml-token");
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setWorkspace(null);
      workspaceStateRef.current = null;
      return;
    }
    api
      .get("/workspace")
      .then((res) => {
        applyWorkspace(res.data.workspace as WorkspaceState);
        setAuthError(null);
      })
      .catch((error) => {
        setAuthError(error?.response?.data?.detail || String(error));
        logout();
      });
  }, [api, applyWorkspace, logout, token]);

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

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const res = await axios.post(`${apiBase}/auth/login`, {
        username: loginUsername,
        password: loginPassword,
      });
      const nextToken = res.data.access_token as string;
      setToken(nextToken);
      setUserName(res.data.user?.username ?? loginUsername);
      applyWorkspace(res.data.workspace as WorkspaceState);
    } catch (error: any) {
      setAuthError(error?.response?.data?.detail || String(error));
    }
  };

  useEffect(() => {
    if (!workspace || !token) return;
    const updates: Partial<WorkspaceState> = {};
    const desiredBranch = packageBranch || workspace.branch;
    if (workspace.package !== pkg) updates.package = pkg;
    if (workspace.base_namespace !== normalizedNamespace) updates.base_namespace = normalizedNamespace;
    if (workspace.branch !== desiredBranch) updates.branch = desiredBranch;
    if (Object.keys(updates).length > 0) updateWorkspaceOnServer(updates);
  }, [normalizedNamespace, packageBranch, pkg, token, updateWorkspaceOnServer, workspace]);

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
  const loadRoots = useCallback(async () => {
    if (!token) return;
    if (startEmpty) {
      setRoots([]);
      setRoot("");
      return;
    }
    setErr(null);
    try {
      const r = await api.get("/roots", { params: { package: pkg } });
      const list = r.data.sections || [];
      setRoots(list);
      if (list.length > 0 && !list.includes(root)) setRoot(list[0]);
      syncWorkspaceFromResponse(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setRoots([]);
    }
  }, [api, pkg, root, startEmpty, syncWorkspaceFromResponse, token]);

  // build single-branch graph (resets diff view)
  const loadGraph = useCallback(async (
    overrides?: { pkg?: string; root?: string; namespace?: string; branch?: string; forceEmpty?: boolean }
  ) => {
    if (!token) {
      setErr("Login required");
      return;
    }
    const pkgToUse = overrides?.pkg ?? pkg;
    const rootToUse = overrides?.root ?? root;
    const namespaceToUse = overrides?.namespace ?? normalizedNamespace;
    const branchToUse = overrides?.branch ?? workspace?.branch ?? "";
    const useEmpty = overrides?.forceEmpty ?? startEmpty;
    setErr(null);
    setQuantityActionErr(null);
    setLoading(true);
    setDiffData(null);
    setGraphHandle(null);
    try {
      if (useEmpty) {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
            empty: true,
          },
        });
        setGraph(r.data);
        setBaseGraph(r.data);
        syncWorkspaceFromResponse(r.data);
        return;
      }
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
              include_inheritance: includeInheritance,
              allow_cross_module: crossModules,
              base_namespace: namespaceToUse || undefined,
            },
          }
        );
        setGraph(r.data?.graph ?? null);
        setBaseGraph(r.data?.graph ?? null);
        syncWorkspaceFromResponse(r.data);
      } else {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
          },
        });
        setGraph(r.data);
        setBaseGraph(r.data);
        syncWorkspaceFromResponse(r.data);
      }
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [api, crossModules, includeQuantities, includeSubsections, includeInheritance, normalizedNamespace, pkg, root, startEmpty, syncWorkspaceFromResponse, token, workspace?.branch]);

  const resetEmptyCanvas = useCallback(async () => {
    if (!token) {
      setErr("Login required");
      return;
    }
    const targetPkg = scratchPackage;
    try {
      setCanvasStatus("Resetting canvas…");
      setErr(null);
      await api.delete("/schema/custom-edits", {
        params: {
          package: targetPkg,
          branch: workspace?.branch || undefined,
        },
      });
      setAuditTrail([]);
      setGraph(null);
      setBaseGraph(null);
      setUmlState(null);
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      await loadGraph({ pkg: targetPkg, root: "", namespace: normalizedNamespace, branch: workspace?.branch, forceEmpty: true });
      setCanvasStatus("Canvas reset to empty.");
    } catch (e: any) {
      setCanvasStatus(`Reset failed: ${e?.response?.data?.detail || String(e)}`);
    }
  }, [api, loadGraph, normalizedNamespace, scratchPackage, setSelected, token, workspace?.branch]);

  // fetch git branches
  const loadBranches = useCallback(async () => {
    if (!token) return;
    try {
      const r = await api.get("/git/branches", { params: { base_package: normalizedNamespace } });
      setBranches(r.data.branches || []);
      syncWorkspaceFromResponse(r.data);
    } catch (e) {
      // keep silent in UI; dropdown will just be empty
      console.error("Failed to load branches", e);
    }
  }, [api, normalizedNamespace, syncWorkspaceFromResponse, token]);

  // fetch available schema packages from develop branch
  const loadPackages = useCallback(async () => {
    if (!token) return;
    setErr(null);
    try {
      const r = await api.get("/git/packages", {
        params: {
          branch: packageBranch,
          base_package: normalizedNamespace,
        },
      });
      const raw: string[] = r.data.packages || [];
      const filtered = raw.filter((p: string) => !p.endsWith(".__init__"));
      const list = (filtered.length ? filtered : raw).filter(Boolean);
      const augmented = startEmpty && scratchPackage ? [scratchPackage, ...list] : list;
      // dedupe while preserving order
      const seen = new Set<string>();
      const unique = augmented.filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });
      setAvailablePkgs(unique);
      syncWorkspaceFromResponse(r.data);

      // if current pkg is not in the list, default to the first entry (keep scratch when empty)
      if (unique.length > 0 && !unique.includes(pkg)) {
        setPkg(startEmpty && scratchPackage ? scratchPackage : unique[0]);
      }
    } catch (e) {
      // silent failure is fine; user can still type manually
      console.error("Failed to load packages", e);
      // surface the error so users know why the dropdown is empty
      setErr((e as any)?.response?.data?.detail || String(e));
    }
  }, [api, normalizedNamespace, packageBranch, pkg, scratchPackage, startEmpty, syncWorkspaceFromResponse, token]);

  useEffect(() => {
    if (!workspace || !token) return;
    loadBranches();
    loadPackages();
    loadRoots();
  }, [loadBranches, loadPackages, loadRoots, token, workspace]);

  // compare base/head using same filters as sidebar
  const compareBranches = async () => {
    if (!token) {
      setErr("Login required");
      return;
    }
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
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
          },
        }
      );
      setDiffData(r.data);
      syncWorkspaceFromResponse(r.data);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || String(e));
      setDiffData(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const toQuantityNode = useCallback((n: any): QuantityNode => {
    const ownerId = n.owner ?? "";
    return {
      id: n.id,
      name: n.label ?? n.id?.split(".").pop() ?? n.id,
      dtype: n.dtype ?? n.data_type ?? n.type ?? undefined,
      shape: n.shape ?? null,
      card: n.card ?? null,
      doc: n.doc ?? null,
      path: n.path ?? null,
      line: typeof n.line === "number" ? n.line : null,
      ownerId,
    };
  }, []);

  const buildUmlState = useCallback((g: ApiGraph | null): UmlGraphState | null => {
    if (!g) return null;
    const nodes = g.nodes || [];
    const edges = g.edges || [];
    const sections = nodes.filter((n: any) => n.kind === "section");
    const quantities = nodes.filter((n: any) => n.kind === "quantity");
    const parentInfoByChild = new Map<string, { id: string; relation: string }>();
    edges.forEach((e: any) => {
      if ((e.type === "inherits" || e.type === "hasSubSection") && e.target && e.source) {
        parentInfoByChild.set(e.target, { id: e.source, relation: e.type });
      }
    });

    const classList: UmlClassNode[] = sections.map((sec: any) => {
      const ownedQuantities = quantities
        .filter((q: any) => q.owner === sec.id)
        .map((q: any) => toQuantityNode(q));

      const parentInfo = parentInfoByChild.get(sec.id);
      const relation = parentInfo?.relation === "hasSubSection" ? "hasSubSection" : parentInfo?.relation === "inherits" ? "inherits" : null;

      return {
        id: sec.id,
        name: sec.label ?? sec.id,
        doc: sec.doc ?? null,
        module: sec.module ?? null,
        path: sec.path ?? null,
        line: typeof sec.line === "number" ? sec.line : null,
        quantities: ownedQuantities,
        parentId: parentInfo?.id ?? null,
        parentRelation: relation,
      };
    });

    return {
      package: g.package,
      root: g.root ?? null,
      classes: classList,
      edges: edges.map((e: any) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        card: e.card ?? null,
      })),
    };
  }, [toQuantityNode]);

  const toggleEmptyMode = useCallback(async () => {
    const nextShouldBeEmpty = !emptyCanvasActive;
    setStartEmpty(nextShouldBeEmpty);
    if (nextShouldBeEmpty) {
      const targetPkg = scratchPackage;
      const blankGraph: ApiGraph = { package: targetPkg, root: "", nodes: [], edges: [] };
      setMode("graph");
      setDiffData(null);
      setGraphHandle(null);
      setAuditTrail([]);
      setGraph(blankGraph);
      setBaseGraph(blankGraph);
      setUmlState(buildUmlState(blankGraph));
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setRoot("");
      setPkg(targetPkg);
      setEditableMode(true);
      setCanvasStatus(null);
      await loadGraph({ pkg: targetPkg, root: "", namespace: normalizedNamespace, forceEmpty: true });
    } else {
      await loadGraph({ forceEmpty: false });
    }
  }, [buildUmlState, emptyCanvasActive, loadGraph, normalizedNamespace, scratchPackage, setSelected]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("schema-uml-theme", theme);
  }, [theme]);

  useEffect(() => {
    setUmlState(buildUmlState(graph));
  }, [buildUmlState, graph]);

  useEffect(() => {
    if (!auditTrail.length && graph) {
      setBaseGraph(graph);
    }
  }, [auditTrail.length, graph]);

  useEffect(() => {
    if (!umlState) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setSelected(null);
      return;
    }
    if (selectedClassId && !umlState.classes.some((c) => c.id === selectedClassId)) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setSelected(null);
      return;
    }
    if (
      selectedClassId &&
      selectedQuantityId &&
      !umlState.classes.some((c) => c.id === selectedClassId && c.quantities.some((q) => q.id === selectedQuantityId))
    ) {
      setSelectedQuantityId(null);
    }
  }, [selectedClassId, selectedQuantityId, setSelected, umlState]);

  useEffect(() => {
    if (!umlState) {
      setSelected(null);
      return;
    }
    if (!selectedClassId) {
      setSelected(null);
      return;
    }
    const cls = umlState.classes.find((c) => c.id === selectedClassId);
    if (!cls) {
      setSelected(null);
      return;
    }
    if (selectedQuantityId) {
      const qty = cls.quantities.find((q) => q.id === selectedQuantityId);
      if (!qty) {
        setSelected({
          id: cls.id,
          fqid: cls.module && cls.name ? `${cls.module}.${cls.name}` : cls.id,
          kind: "class",
          name: cls.name,
          doc: cls.doc || "",
          path: cls.path || undefined,
          line: typeof cls.line === "number" ? cls.line : undefined,
          quantities: cls.quantities.map((q) => ({
            id: q.id,
            name: q.name,
            dtype: q.dtype,
            shape: q.shape ?? undefined,
            card: q.card ?? undefined,
            doc: q.doc ?? undefined,
            path: q.path ?? undefined,
            line: typeof q.line === "number" ? q.line : undefined,
            owner: q.ownerId,
          })),
        });
        return;
      }
      setSelected({
        id: qty.id,
        kind: "quantity",
        name: qty.name,
        doc: qty.doc || "",
        path: qty.path || undefined,
        line: typeof qty.line === "number" ? qty.line : undefined,
        dtype: qty.dtype,
        shape: qty.shape ?? undefined,
        card: qty.card ?? undefined,
        owner: cls.id,
      });
      return;
    }
    setSelected({
      id: cls.id,
      fqid: cls.module && cls.name ? `${cls.module}.${cls.name}` : cls.id,
      kind: "class",
      name: cls.name,
      doc: cls.doc || "",
      path: cls.path || undefined,
      line: typeof cls.line === "number" ? cls.line : undefined,
      quantities: cls.quantities.map((q) => ({
        id: q.id,
        name: q.name,
        dtype: q.dtype,
        shape: q.shape ?? undefined,
        card: q.card ?? undefined,
        doc: q.doc ?? undefined,
        path: q.path ?? undefined,
        line: typeof q.line === "number" ? q.line : undefined,
        owner: q.ownerId,
      })),
    });
  }, [selectedClassId, selectedQuantityId, setSelected, umlState]);

  const createQuantityOnCanvas = async (classId: string, { quantityName, dtype, docstring }: QuantityFormData) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }
    if (!token) {
      const message = "Login required";
      setQuantityActionErr(message);
      throw new Error(message);
    }
    const targetClass = umlState?.classes.find((c) => c.id === classId);
    if (!targetClass) {
      const message = "Select a class to add the quantity.";
      setQuantityActionErr(message);
      throw new Error(message);
    }

    setCreatingQuantityFor(classId);
    setQuantityActionErr(null);
    try {
      const targetPackage = targetClass.module || pkg;
      const rawName = targetClass.name || targetClass.id || classId;
      const classLabel =
        rawName && rawName.includes(".") ? rawName.split(".").pop() || rawName : rawName;

      const parentLabel =
        targetClass.parentId
          ? umlState?.classes.find((c) => c.id === targetClass.parentId)?.name ||
            targetClass.parentId.split(".").pop() ||
            targetClass.parentId
          : null;
      const parentRelation = targetClass.parentRelation ?? null;

      if (!classLabel) {
        const message = "Target class name missing";
        setQuantityActionErr(message);
        throw new Error(message);
      }

      const r = await api.post(
        "/schema/custom-quantity",
        {
          package: targetPackage,
          class_name: classLabel,
          parent_name: parentLabel,
          parent_relation: parentRelation,
          quantity_name: quantityName,
          dtype,
          docstring: docstring || null,
        },
        {
          params: {
            root,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
            empty: startEmpty ? true : undefined,
          },
        }
      );
      const updated = r.data as ApiGraph;
      const newChange: AuditTrailEntry["change"] = {
        type: "add-quantity",
        classId: targetClass.id,
        quantity: {
          id: `${targetClass.id}.${quantityName}`,
          name: quantityName,
          dtype,
          doc: docstring || null,
          ownerId: targetClass.id,
          shape: null,
          card: null,
          path: null,
          line: null,
        },
      };

      const mergedGraph = replayGraphWithAudit(updated, newChange);

      setGraph(mergedGraph);
      const nextUml = buildUmlState(mergedGraph);
      setUmlState(nextUml);
      syncWorkspaceFromResponse(mergedGraph);
      const updatedClass =
        nextUml?.classes?.find(
          (c) =>
            c.id === targetClass.id ||
            c.name === targetClass.name ||
            c.id?.endsWith?.(`.${targetClass.name}`) ||
            c.name?.endsWith?.(`.${targetClass.name}`)
        ) ?? targetClass;

      const addedQuantity =
        nextUml?.classes
          ?.find(
            (c) =>
              c.id === updatedClass.id ||
              c.name === updatedClass.name ||
              c.name?.endsWith?.(`.${updatedClass.name}`)
          )
          ?.quantities.find(
            (q) => q.name === quantityName || q.id === `${updatedClass.id}.${quantityName}`
          ) ??
        ({
          id: `${updatedClass.id}.${quantityName}`,
          name: quantityName,
          dtype,
          doc: docstring || null,
          ownerId: updatedClass.id,
          shape: null,
          card: null,
          path: null,
          line: null,
        } as QuantityNode);

      appendAudit(
        { type: "add-quantity", classId: updatedClass.id, quantity: addedQuantity },
        `Added quantity ${addedQuantity.name}${dtype ? `: ${dtype}` : ""} to class ${updatedClass.name}`
      );
      setSelectedClassId(updatedClass.id);
      setSelectedQuantityId(addedQuantity.id);
    } catch (e: any) {
      const message = e?.response?.data?.detail || String(e);
      setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      setCreatingQuantityFor(null);
    }
  };

  const createClassOnCanvas = async ({ name, parentId, docstring, relation }: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection" }) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }
    if (!token) {
      const message = "Login required";
      setQuantityActionErr(message);
      throw new Error(message);
    }
    setCreatingClass(true);
    setQuantityActionErr(null);
    try {
      const res = await api.post(
        "/schema/custom-class",
        {
          package: pkg,
          name,
          parent: parentId || null,
          relation: parentId ? relation || "inherits" : "inherits",
          docstring: docstring || null,
        },
        {
          params: {
            root,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
            empty: startEmpty ? true : undefined,
          },
        }
      );
      const next = res.data as ApiGraph;
      const newChange: AuditTrailEntry["change"] = {
        type: "add-class",
        cls: {
          id: `${pkg}.${name}`,
          name,
          doc: docstring || null,
          module: pkg,
          parentId: parentId || null,
          parentRelation: parentId ? relation || "inherits" : null,
          quantities: [],
          path: null,
          line: null,
        } as UmlClassNode,
      };
      const mergedGraph = replayGraphWithAudit(next, newChange);
      setGraph(mergedGraph);
      const nextUml = buildUmlState(mergedGraph);
      setUmlState(nextUml);
      syncWorkspaceFromResponse(mergedGraph);
      const newCls =
        nextUml?.classes.find((c) => c.name === name || c.id === name || c.id.endsWith(`.${name}`)) ??
        ({
          id: `${pkg}.${name}`,
          name,
          doc: docstring || null,
          module: pkg,
          parentId: parentId || null,
          parentRelation: parentId ? relation || "inherits" : null,
          quantities: [],
          path: null,
          line: null,
        } as UmlClassNode);
      appendAudit(
        { type: "add-class", cls: newCls },
        parentId ? `Added class ${newCls.name} extending ${parentId}` : `Added class ${newCls.name}`
      );
      setSelectedClassId(newCls.id);
      setSelectedQuantityId(null);
    } catch (e: any) {
      const message = e?.response?.data?.detail || String(e);
      setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      setCreatingClass(false);
    }
  };

  const removeQuantityFromGraphState = useCallback((g: ApiGraph, quantityId: string): ApiGraph => {
    const nodes = (g.nodes || []).filter((n: any) => n.id !== quantityId);
    const edges = (g.edges || []).filter((e: any) => e.source !== quantityId && e.target !== quantityId);
    return { ...g, nodes, edges };
  }, []);

  const addQuantityToGraphState = useCallback((g: ApiGraph, quantity: QuantityNode): ApiGraph => {
    const qNode = {
      id: quantity.id,
      kind: "quantity",
      label: quantity.name,
      dtype: quantity.dtype,
      shape: quantity.shape ?? undefined,
      card: quantity.card ?? undefined,
      doc: quantity.doc ?? null,
      owner: quantity.ownerId,
      path: quantity.path ?? undefined,
      line: quantity.line ?? undefined,
    };
    const hasNode = (g.nodes || []).some((n: any) => n.id === quantity.id);
    const nodes = hasNode
      ? g.nodes.map((n: any) => (n.id === quantity.id ? { ...n, ...qNode } : n))
      : [...(g.nodes || []), qNode];
    const edgeExists = (g.edges || []).some((e: any) => e.source === quantity.ownerId && e.target === quantity.id);
    const edges = edgeExists
      ? g.edges
      : [...(g.edges || []), { source: quantity.ownerId, target: quantity.id, type: "hasQuantity", card: quantity.card ?? null }];
    return { ...g, nodes, edges };
  }, []);

  const removeClassFromGraphState = useCallback((g: ApiGraph, classId: string): ApiGraph => {
    const removedQuantityIds = (g.nodes || []).filter((n: any) => n.owner === classId).map((n: any) => n.id);
    const nodes = (g.nodes || []).filter(
      (n: any) => n.id !== classId && !removedQuantityIds.includes(n.id)
    );
    const edges = (g.edges || []).filter(
      (e: any) =>
        e.source !== classId &&
        e.target !== classId &&
        !removedQuantityIds.includes(e.source) &&
        !removedQuantityIds.includes(e.target)
    );
    return { ...g, nodes, edges };
  }, []);

  const addClassToGraphState = useCallback((g: ApiGraph, cls: UmlClassNode): ApiGraph => {
    const nodesWithoutClass = (g.nodes || []).filter((n: any) => !(n.kind === "section" && n.id === cls.id));
    const sectionNode = {
      id: cls.id,
      kind: "section",
      label: cls.name,
      module: cls.module ?? g.package,
      doc: cls.doc ?? null,
      path: cls.path ?? null,
      line: cls.line ?? null,
    };
    const qtyNodes = cls.quantities.map((q) => ({
      id: q.id,
      kind: "quantity",
      label: q.name,
      dtype: q.dtype,
      shape: q.shape ?? undefined,
      card: q.card ?? undefined,
      doc: q.doc ?? null,
      owner: q.ownerId,
      path: q.path ?? undefined,
      line: q.line ?? undefined,
    }));
    const qtyEdges = cls.quantities.map((q) => ({
      source: q.ownerId,
      target: q.id,
      type: "hasQuantity",
      card: q.card ?? null,
    }));
    const relationType = cls.parentRelation || "inherits";
    const inheritEdge = cls.parentId ? [{ source: cls.parentId, target: cls.id, type: relationType, card: null }] : [];

    return {
      ...g,
      nodes: [...nodesWithoutClass, sectionNode, ...qtyNodes],
      edges: [
        ...(g.edges || []).filter(
          (e: any) =>
            !((e.type === "inherits" || e.type === "hasSubSection") && e.target === cls.id)
        ),
        ...qtyEdges,
        ...inheritEdge
      ],
    };
  }, []);

  const applyForwardChange = useCallback((current: ApiGraph, change: AuditTrailEntry["change"]): ApiGraph => {
    switch (change.type) {
      case "add-class":
        return addClassToGraphState(current, change.cls);
      case "remove-class":
        return removeClassFromGraphState(current, change.cls.id);
      case "add-quantity":
        return addQuantityToGraphState(current, change.quantity);
      case "remove-quantity":
        return removeQuantityFromGraphState(current, change.quantity.id);
      case "edit-quantity": {
        const withoutBefore = removeQuantityFromGraphState(current, change.before.id);
        return addQuantityToGraphState(withoutBefore, change.after);
      }
      default:
        return current;
    }
  }, [addClassToGraphState, addQuantityToGraphState, removeClassFromGraphState, removeQuantityFromGraphState]);

  const replayGraphWithAudit = useCallback(
    (serverGraph: ApiGraph, extraChange?: AuditTrailEntry["change"]): ApiGraph => {
      const changes = auditTrail.map((a) => a.change).filter(Boolean) as AuditTrailEntry["change"][];
      const allChanges = extraChange ? [...changes, extraChange] : changes;
      return allChanges.reduce((acc, change) => applyForwardChange(acc, change), serverGraph);
    },
    [applyForwardChange, auditTrail]
  );

  const undoAuditEntry = (id: string) => {
    const remaining = auditTrail.filter((a) => a.id !== id && a.change);
    const entry = auditTrail.find((a) => a.id === id);
    if (!entry || !entry.change) return;

    const start = baseGraph ?? graph;
    if (!start) return;

    const rebuilt = remaining.reduce((acc, curr) => applyForwardChange(acc, curr.change!), start);

    setGraph(rebuilt);
    setUmlState(buildUmlState(rebuilt));
    setAuditTrail(remaining as AuditTrailEntry[]);
    setQuantityActionErr(null);
  };

  const clearAuditTrail = async () => {
    if (auditTrail.length === 0) return;
    const baseline = baseGraph ?? graph;
    if (baseline) {
      setGraph(baseline);
      setUmlState(buildUmlState(baseline));
    }
    setAuditTrail([]);
    setQuantityActionErr(null);
    try {
      await api.delete("/schema/custom-edits", {
        params: {
          package: pkg,
          branch: workspace?.branch || undefined,
        },
      });
    } catch (e) {
      console.warn("Failed to clear persisted edits", e);
    }
  };

  useEffect(() => {
    loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, startEmpty, loadRoots]);

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

  const handleBranchSelect = (value: string) => {
    setPackageBranch(value);
    setOverviewBranch(value);
    setBaseBranch((prev) => prev || value);
    setHeadBranch((prev) => prev || value);
    updateWorkspaceOnServer({ branch: value });
  };

  const handlePackageSelect = (value: string) => {
    setPkg(value);
    updateWorkspaceOnServer({ package: value });
  };

  const handleNamespaceChange = (value: string) => {
    setNamespace(value);
    updateWorkspaceOnServer({ base_namespace: value });
  };

  const handleCanvasClassSelect = useCallback((cls: UmlClassNode) => {
    setSelectedClassId(cls.id);
    setSelectedQuantityId(null);
  }, []);

  const handleCanvasClear = useCallback(() => {
    setSelectedClassId(null);
    setSelectedQuantityId(null);
    setSelected(null);
  }, [setSelected]);

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
      setSelectedClassId(fallbackNode.id);
      setSelectedQuantityId(null);
    }
  }, [currentGraph, graphHandle, root, setSelected, setSelectedClassId, setSelectedQuantityId]);

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
    setQuantityActionErr(null);
    const before: QuantityNode = {
      id: target.id,
      name: target.label,
      dtype: target.dtype ?? target.data_type ?? target.type ?? undefined,
      shape: target.shape ?? null,
      card: target.card ?? null,
      doc: target.doc ?? null,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      ownerId: target.owner,
    };
    const after: QuantityNode = {
      ...before,
      id: newId,
      name: trimmedName,
      dtype: updates.dtype,
      doc: updates.docstring || null,
    };
    appendAudit(
      { type: "edit-quantity", classId: target.owner, before, after },
      `Edited quantity ${before.name} on ${target.owner}`
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelectedQuantityId(newId);
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
    setQuantityActionErr(null);
    const removed: QuantityNode = {
      id: target.id,
      name: target.label,
      dtype: target.dtype ?? target.data_type ?? target.type ?? undefined,
      shape: target.shape ?? null,
      card: target.card ?? null,
      doc: target.doc ?? null,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      ownerId: target.owner,
    };
    appendAudit(
      { type: "remove-quantity", classId: target.owner, quantity: removed },
      `Removed quantity ${removed.name} from ${target.owner}`
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelectedQuantityId(null);
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

  const handleImportJson = () => {
    setImportStatus(null);
    importFileRef.current?.click();
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result ?? "{}"));
        if (!raw || typeof raw !== "object") {
          throw new Error("File is empty or invalid JSON.");
        }
        if (!Array.isArray((raw as any).nodes) || !Array.isArray((raw as any).edges)) {
          throw new Error("Expected nodes[] and edges[] in the workspace file.");
        }
        const nextGraph: ApiGraph = {
          package: (raw as any).package ?? pkg,
          root: (raw as any).root ?? null,
          nodes: (raw as any).nodes,
          edges: (raw as any).edges,
        };
        setMode("graph");
        setDiffData(null);
        setGraphHandle(null);
        setGraph(nextGraph);
        setBaseGraph(nextGraph);
        const nextUml = buildUmlState(nextGraph);
        setUmlState(nextUml);
        setAuditTrail([]);
        setSelectedClassId(null);
        setSelectedQuantityId(null);
        setSelected(null);
        if (nextGraph.package) setPkg(nextGraph.package);
        if (nextGraph.root) setRoot(nextGraph.root);
        setImportStatus(`Imported ${file.name}`);
        setErr(null);
      } catch (error: any) {
        setImportStatus(`Import failed: ${error?.message || "Invalid workspace file."}`);
      } finally {
        e.target.value = "";
      }
    };
    reader.onerror = () => {
      setImportStatus("Import failed: could not read the file.");
      e.target.value = "";
    };
    reader.readAsText(file);
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

  const exportAuditLog = () => {
    if (!auditTrail.length) return;
    const blob = new Blob([JSON.stringify(auditTrail, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "schema-uml-audit-log.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!token) {
    return (
      <main className="app-shell" ref={appShellRef} style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}>
        <div className="sidebar" style={{ gridColumn: "1 / span 3", padding: 24 }}>
          <h2>Sign in</h2>
          <p className="subdued">Authenticate to load your personalized workspace.</p>
          <form className="action-stack" onSubmit={handleLogin} style={{ maxWidth: 360 }}>
            <label className="label">Username</label>
            <input className="input" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
            />
            <button className="btn" type="submit">
              Sign in
            </button>
            {authError ? <p style={{ color: "#fca5a5" }}>{authError}</p> : null}
          </form>
        </div>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="app-shell" ref={appShellRef} style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}>
        <div className="sidebar" style={{ gridColumn: "1 / span 3", padding: 24 }}>
          <p>Loading workspace…</p>
        </div>
      </main>
    );
  }

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
            SchemaStudio
          </h3>
          <p className="subdued">Craft diagrams, compare branches, and edit schemas.</p>
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

        <div className="brand-card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p className="eyebrow">Signed in</p>
              <h4 style={{ margin: 0 }}>{userName ?? "User"}</h4>
            </div>
            <button className="btn secondary" onClick={logout} type="button">
              Logout
            </button>
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
                  onChange={(e) => handleBranchSelect(e.target.value)}
                >
                  {[overviewBranch || DEFAULT_BRANCH, ...branches.filter((b) => b !== overviewBranch)].map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="workspace-presets">
            {WORKSPACE_PRESETS.map((ws) => {
              return (
                <div key={ws.namespace} className="preset-block">
                  <button
                    className={`workspace-preset-btn ${normalizedNamespace === ws.namespace ? "active" : ""}`}
                    onClick={() => {
                      handleNamespaceChange(ws.namespace);
                      if (ws.branch) {
                        handleBranchSelect(ws.branch);
                      }
                      if (ws.pkg) handlePackageSelect(ws.pkg);
                      if (ws.root) setRoot(ws.root);
                    }}
                    title={`Set base namespace to ${ws.namespace}`}
                  >
                    {ws.label}
                  </button>
                </div>
              );
            })}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Package & filters" hint="Pick a backend package and fine-tune the graph">
          <div className="action-stack">
            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label className="label">Choose from branch</label>
                <select
                  className="select"
                  value={packageBranch}
                  onChange={(e) => handleBranchSelect(e.target.value)}
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
                onChange={(e) => handlePackageSelect(e.target.value)}
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
                  checked={includeInheritance}
                  onChange={(e) => setIncludeInheritance(e.target.checked)}
                />
                Inheritance
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

            <div className="row" style={{ marginTop: 14, justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  toggleEmptyMode();
                }}
                title={emptyCanvasActive ? "Return to schema-backed graph" : "Start a blank canvas"}
              >
                {emptyCanvasActive ? "Back to schema graph" : "+ Start from empty canvas"}
              </button>
              <button className="btn" onClick={() => loadGraph()}>
                Build graph
              </button>
              <div className="row" style={{ flex: 1, justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept="application/json"
                  ref={importFileRef}
                  style={{ display: "none" }}
                  onChange={handleImportFile}
                />
                <button className="btn secondary" type="button" onClick={handleImportJson}>
                  Import JSON
                </button>
                {currentGraph ? (
                  <>
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
                  </>
                ) : null}
              </div>
              {importStatus ? (
                <div className="small" style={{ color: importStatus.startsWith("Import failed") ? "#fca5a5" : "var(--muted)", textAlign: "right" }}>
                  {importStatus}
                </div>
              ) : null}
            </div>

            {err ? (
              <p style={{ color: "#fca5a5", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
            ) : null}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Under the hood" hint="Raw schema structure">
          <UnderTheHoodPanel apiBase={apiBase} token={token} />
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
                token={token}
                onClassSelect={handleOverviewClassSelect}
              />
            </div>
          ) : diffData ? (
            <>
              <div className="workspace-toolbar" style={{ justifyContent: "space-between" }}>
                <div>
                  Base: {diffData.base.branch} ({diffData.base.sha.slice(0, 7)}) → Head: {diffData.head.branch} ({diffData.head.sha.slice(0, 7)})
                </div>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <span className="pill diff added">🟩 Added</span>
                  <span className="pill diff changed">🟨 Changed</span>
                  <span className="pill diff removed">🟥 Removed</span>
                </div>
              </div>
              <GraphView
                nodes={diffData.head.graph.nodes}
                edges={diffData.head.graph.edges}
                diff={diffData.diff}
                showQuantityMetadata={showQuantityMetadata}
                showInheritance={includeInheritance}
                theme={theme}
                onReady={setGraphHandle}
              />
            </>
          ) : graph ? (
            <>
              <div style={{ position: "relative", flex: 1 }}>
                <div className="graph-toolbar">
                  <div className="label" style={{ marginBottom: 4 }}>Canvas mode</div>
                  <div className="toggle-group">
                    <button
                      className={`toggle-chip ${!editableMode ? "active" : ""}`}
                      type="button"
                      onClick={() => setEditableMode(false)}
                      aria-pressed={!editableMode}
                    >
                      UML
                    </button>
                    <button
                      className={`toggle-chip ${editableMode ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        setEditableMode(true);
                        setQuantityActionErr(null);
                      }}
                      disabled={!!addBlockedReason}
                      aria-pressed={editableMode}
                      title={addBlockedReason || "Toggle editing"}
                    >
                      Edit
                    </button>
                  </div>
                  {startEmpty ? (
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={resetEmptyCanvas}
                        title="Clear saved custom schema edits for this empty canvas"
                        style={{ padding: "6px 10px", whiteSpace: "nowrap" }}
                      >
                        Reset canvas
                      </button>
                      {canvasStatus ? (
                        <span className="small" style={{ color: canvasStatus.startsWith("Reset failed") ? "#fca5a5" : "var(--muted)" }}>
                          {canvasStatus}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {editableMode && addBlockedReason ? (
                    <div className="small" style={{ color: "var(--muted)" }}>{addBlockedReason}</div>
                  ) : null}
                </div>
                <GraphView
                  nodes={graph.nodes}
                edges={graph.edges}
                umlState={umlState}
                selectedClassId={selectedClassId}
                showQuantityMetadata={showQuantityMetadata}
                showInheritance={includeInheritance}
                theme={theme}
                onReady={setGraphHandle}
                onSelectClass={handleCanvasClassSelect}
                onCreateQuantity={createQuantityOnCanvas}
                onCreateClass={createClassOnCanvas}
                creatingQuantityFor={creatingQuantityFor}
                creatingClass={creatingClass}
                onClearSelection={handleCanvasClear}
                  editableMode={editableMode}
                />
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div style={{ fontSize: 18, marginBottom: 8 }}>Build a diagram to get started</div>
              <div>
                Select a package (roots load automatically), pick a root, then “Build graph” — or toggle “Start from
                empty canvas” to draw your own schema from scratch. You can also compare two branches.
              </div>
              <div style={{ marginTop: 12 }}>
                <button className="btn secondary" type="button" onClick={() => toggleEmptyMode()}>
                  {emptyCanvasActive ? "Back to schema graph" : "+ Start from empty canvas"}
                </button>
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
              title="Audit trail"
              hint="Track edits and export"
              className="panel"
            >
              <div className="action-stack" style={{ gap: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={exportAuditLog}
                    disabled={!auditTrail.length}
                    title={auditTrail.length ? "Download audit log as JSON" : "No edits recorded yet"}
                  >
                    Export JSON
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={clearAuditTrail}
                    disabled={!auditTrail.length}
                  >
                    Clear
                  </button>
                </div>
                <div className="small" style={{ color: "var(--muted)" }}>
                  {auditTrail.length ? `${auditTrail.length} edits recorded` : "No edits yet"}
                </div>
                <div
                  style={{
                    maxHeight: 240,
                    overflowY: "auto",
                    border: "1px solid var(--panel-border)",
                    borderRadius: 10,
                    padding: 8,
                    background: "var(--panel)",
                    fontSize: 12
                  }}
                >
                  {[...auditTrail].reverse().filter((e) => e?.change).map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid var(--panel-border)",
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => undoAuditEntry(entry.id)}
                          title="Undo this change"
                          style={{ padding: "6px 10px" }}
                        >
                          🗑
                        </button>
                        <div>
                          <div style={{ fontWeight: 700 }}>{entry.description}</div>
                          <div style={{ color: "var(--muted)" }}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </div>
                          <div style={{ color: "var(--subtitle)" }}>Change: {entry.change.type}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>
      </div>
    </main>
  );
}

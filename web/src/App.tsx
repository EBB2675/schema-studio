import { getBrowserEditStore, LEGACY_EDIT_GENERATION } from "./static/editStore";
import { readPreference, writePreference } from "./utils/browserStorage";
import type { ChangeEvent, SyntheticEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import type { GraphExportHandle } from "./types/graph";
import FlowGraphView from "./FlowGraphView";
import { useMobilePanels } from "./hooks/useMobilePanels";
import DocPanel from "./components/DocPanel";
import OverviewGrid from "./components/OverviewGrid";
import UnderTheHoodPanel from "./components/UnderTheHoodPanel";
import {
  NOMAD_EDIT_RULES,
  VOCAB_TERM,
  dtypeNameFor,
  parseEditRules,
  subsectionName,
  type EditRules,
  type QuantityFormData,
} from "./components/quantityShared";
import CollapsibleSection from "./components/CollapsibleSection";
import HomeButton from "./components/HomeButton";
import ActionMenu from "./components/ActionMenu";
import WorkbenchIcon from "./components/WorkbenchIcon";
import "./workbench.css";
import { useSelection } from "./store/selection";
import { jsPDF } from "jspdf";
import type { AuditTrailEntry, QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";
import {
  ensureGraphResponse,
  ensureImportedGraph,
  type ApiEdge,
  type ApiGraph,
  type ApiNode
} from "./types/api";
import type { WorkspaceState } from "./types/workspace";
import { createApiClient } from "./client";
import { DEFAULT_BRANCH, DEFAULT_NAMESPACE, DEFAULT_ROOT, DEFAULT_PACKAGE, WORKSPACE_PRESETS } from "./constants/defaults";
import { useWorkspaceStore } from "./store/workspace";
import { fqidFromParts, normalizeId, normalizeLabel, normalizeModule } from "./utils/identifier";
import { formatApiError } from "./utils/errors";
import { buildUmlStateFromGraph } from "./utils/umlState";
import { initialTheme } from "./utils/theme";
import { canvasPositionKey } from "./utils/canvasPositions";
import { initialLayoutDirection, LAYOUT_DIRECTION_STORAGE_KEY, LAYOUT_DIRECTIONS, type LayoutDirection } from "./utils/layoutDirection";

// Loaded on demand when the static site information panel is opened.
const StaticSitePanel = lazy(() => import("./components/StaticSitePanel"));

type WorkspaceEnvelope = { workspace?: WorkspaceState };
type CanvasIdentity = { package: string; root: string; namespace: string; branch: string; empty: boolean };
const sameCanvas = (a: CanvasIdentity | null, b: CanvasIdentity) =>
  a !== null && a.package === b.package && a.root === b.root &&
  a.namespace === b.namespace && a.branch === b.branch && a.empty === b.empty;

// Responses carry the workspace the browser backend had when the request was handled.
// A response that was requested before the user's latest workspace change must
// not overwrite that change, however late it arrives.
const WORKSPACE_EPOCH = "__workspaceEpoch";
type EpochConfig = { workspaceEpoch?: number };

type SchemaProfileSummary = {
  key: string;
  label: string;
  default_branch: string;
  default_package: string;
  default_base_namespace: string;
  default_root: string;
  available: boolean;
  current: boolean;
  version?: string | null;
  source?: string | null;
  error?: string | null;
  linkml_export?: boolean;
  capabilities?: string[];
  // Whether the schema can be edited (the LinkML path is on) and with which rules.
  editable?: boolean;
  edit_rules?: EditRules;
  // The schema has no modules in this build (the static site knows it; from the snapshot index).
  empty?: boolean;
  // The tracked branch holds a draft of the schema, not a release.
  draft?: boolean;
};

// One button per database in the Workspace panel.
type DatabaseButton = Pick<SchemaProfileSummary, "key" | "label" | "available" | "version" | "source" | "empty" | "draft">
  & Partial<Pick<SchemaProfileSummary, "default_branch">>;

const EMPTY_DATABASE_NOTE = "not released on the tracked branch yet";

export default function App() {

  const [workspace, setWorkspace] = useState<WorkspaceState | null>({ branch: DEFAULT_BRANCH, package: DEFAULT_PACKAGE, base_namespace: DEFAULT_NAMESPACE });

  const {
    branch: workspaceBranch,
    pkg,
    baseNamespace: namespace,
    startEmpty,
    setPkg,
    setStartEmpty,
    applyWorkspace: applyWorkspaceInStore,
  } = useWorkspaceStore();
  const [root, setRoot] = useState<string>(DEFAULT_ROOT);

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [includeInheritance, setIncludeInheritance] = useState<boolean>(true);
  const [showBaseSections, setShowBaseSections] = useState<boolean>(false);
  const [showQuantityMetadata, setShowQuantityMetadata] = useState<boolean>(false);

  const [crossModules, setCrossModules] = useState<boolean>(true);

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [baseGraph, setBaseGraph] = useState<ApiGraph | null>(null);
  // Classes whose subclasses the canvas shows; cleared when the module or root changes.
  const [expandedClasses, setExpandedClasses] = useState<string[]>([]);
  // Built from the graph in the same render, so cards and canvas never disagree.
  const umlState = useMemo<UmlGraphState | null>(() => buildUmlStateFromGraph(graph), [graph]);
  // Changes when a new graph is shown; the canvas then lays it out and fits it once.
  const [canvasKey, setCanvasKey] = useState(0);
  // Only the latest graph request may change what the canvas shows.
  const graphRequestRef = useRef(0);
  // Navigation ends an editing context; refreshes only supersede its displayed graph.
  const canvasEpochRef = useRef(0);
  const canvasIdentityRef = useRef<CanvasIdentity | null>(null);
  const pendingMutationsRef = useRef<Record<string, number>>({});
  const [pendingMutations, setPendingMutations] = useState<Record<string, number>>({});
  const withPendingMutation = useCallback(async <T,>(targetPackage: string, mutate: () => Promise<T>): Promise<T> => {
    const update = (delta: number) => {
      pendingMutationsRef.current = {
        ...pendingMutationsRef.current,
        [targetPackage]: (pendingMutationsRef.current[targetPackage] ?? 0) + delta,
      };
      setPendingMutations(pendingMutationsRef.current);
    };
    update(1);
    try {
      return await mutate();
    } finally {
      update(-1);
    }
  }, []);
  const editUiOperationRef = useRef(0);
  const quantityCreationRef = useRef(0);
  const classCreationRef = useRef(0);
  const beginEditUiOperation = () => {
    const epoch = canvasEpochRef.current;
    const operation = ++editUiOperationRef.current;
    return () => epoch === canvasEpochRef.current && operation === editUiOperationRef.current;
  };
  // expandedRef mirrors expandedClasses; expandIntentRef is what the latest request asked for.
  const expandedRef = useRef<string[]>([]);
  const expandIntentRef = useRef<string[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedQuantityId, setSelectedQuantityId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const invalidateGraphRequests = useCallback(() => {
    canvasEpochRef.current += 1;
    graphRequestRef.current += 1;
    expandIntentRef.current = expandedRef.current;
    setLoading(false);
    setCreatingQuantityFor(null);
    setCreatingClass(false);
  }, []);
  const [err, setErr] = useState<string | null>(null);

  // appearance
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const initial = initialTheme(readPreference("schema-uml-theme"));
    document.documentElement.setAttribute("data-theme", initial);
    return initial;
  });
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>(() =>
    typeof window === "undefined" ? initialLayoutDirection(null) : initialLayoutDirection(readPreference(LAYOUT_DIRECTION_STORAGE_KEY))
  );

  const appShellRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceStateRef = useRef<WorkspaceState | null>(null);
  const workspaceEpochRef = useRef(0);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 360;
    const stored = Number.parseInt(readPreference("schema-uml-left-width") || "", 10);
    return Number.isFinite(stored) ? stored : 360;
  });
  const [docPanelWidth, setDocPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 380;
    const stored = Number.parseInt(readPreference("schema-uml-doc-width") || "", 10);
    return Number.isFinite(stored) ? stored : 380;
  });
  // The right panel starts collapsed; the canvas gets the room until someone opens it.
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [docPanelCollapsed, setDocPanelCollapsed] = useState<boolean>(true);
  const { isMobile, mobilePanel, setMobilePanel } = useMobilePanels();
  const detailsHidden = isMobile ? mobilePanel !== "details" : docPanelCollapsed;
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [linkmlStatus, setLinkmlStatus] = useState<string | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<string | null>(null);

  const [schemaProfileKey, setSchemaProfileKey] = useState<string | null>(null);
  const [schemaProfileError, setSchemaProfileError] = useState<string | null>(null);
  const [schemaProfiles, setSchemaProfiles] = useState<SchemaProfileSummary[]>([]);

  // branch diff state

  // collapsible controls for accessibility / quick-open links
  const [leftPanel, setLeftPanel] = useState<"workspace" | "history">("workspace");
  const [openUnderTheHood, setOpenUnderTheHood] = useState<boolean>(false);




  const isAuditChange = (value: unknown): value is AuditTrailEntry["change"] => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.type === "string";
  };

  const parseAuditEntry = (value: unknown): AuditTrailEntry | null => {
    if (!value || typeof value !== "object") return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.timestamp !== "string" || typeof entry.description !== "string") {
      return null;
    }
    if (!isAuditChange(entry.change)) return null;
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      description: entry.description,
      change: entry.change,
      replayable: entry.replayable === false ? false : true,
      package: typeof entry.package === "string" ? entry.package : undefined,
      editGeneration: typeof entry.editGeneration === "string" ? entry.editGeneration : LEGACY_EDIT_GENERATION,
      editIds: Array.isArray(entry.editIds)
        ? entry.editIds.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  };

  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = readPreference("schema-uml-audit");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const generation = getBrowserEditStore().getGeneration();
      return parsed
        .map(parseAuditEntry)
        .filter((e): e is AuditTrailEntry => Boolean(e))
        .filter(e => e.editGeneration === generation)
        .filter((e) => !(typeof e.id === "string" && e.id.startsWith("persisted-")));
    } catch {
      return [];
    }
  });

  // editable mode
  const editableMode = true;

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
  useEffect(() => { setMobilePanel(null); }, [canvasKey, mode, graph?.package, setMobilePanel]);
  const [overviewQuery, setOverviewQuery] = useState<string>("");
  const [overviewBranch, setOverviewBranch] = useState<string>(workspaceBranch || DEFAULT_BRANCH);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      writePreference("schema-uml-audit", JSON.stringify(auditTrail));
    } catch {
      // ignore storage errors
    }
  }, [auditTrail]);

  const api = useMemo(() => {
    const instance = createApiClient();
    instance.interceptors.request.use((config) => {
      (config as EpochConfig).workspaceEpoch = workspaceEpochRef.current;
      return config;
    });
    instance.interceptors.response.use((response) => {
      const epoch = (response.config as EpochConfig).workspaceEpoch;
      if (typeof epoch === "number" && response.data && typeof response.data === "object") {
        Object.defineProperty(response.data, WORKSPACE_EPOCH, { value: epoch, enumerable: false });
      }
      return response;
    });
    return instance;
  }, []);

  const isStaleResponse = useCallback((payload: unknown): boolean => {
    if (!payload || typeof payload !== "object") return false;
    const epoch = (payload as Record<string, unknown>)[WORKSPACE_EPOCH];
    return typeof epoch === "number" && epoch < workspaceEpochRef.current;
  }, []);
  const normalizedNamespace = useMemo(() => {
    const parts = namespace.split(",").map((p: string) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(",") : DEFAULT_NAMESPACE;
  }, [namespace]);
  const namespaceFilters = useMemo(
    () => normalizedNamespace.split(",").map((p: string) => p.trim()).filter(Boolean),
    [normalizedNamespace]
  );
  const pinnedClassIds = useMemo(
    () =>
      auditTrail
        .filter((entry) => entry.replayable !== false && entry.change?.type === "add-class")
        .map((entry) => (entry.change.type === "add-class" ? entry.change.cls.id : ""))
        .filter(Boolean),
    [auditTrail]
  );

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

  const emptyCanvasActive = startEmpty && graph?.package === scratchPackage && (graph?.root === "" || graph?.root === null);
  // The schema's base namespace is no module itself; its graph is every class of the data model.
  const wholeModelPackage = basePackageForEmpty;
  const wholeModelActive = !startEmpty && pkg === wholeModelPackage;

  const normalizePackageName = useCallback((value?: string | null) => {
    if (!value) return "";
    return normalizeModule(value) || value;
  }, []);

  const inferProfileKey = useCallback((value?: string | null) => {
    const normalized = normalizePackageName(value);
    const within = (namespace: string) => normalized === namespace || normalized.startsWith(`${namespace}.`);
    // The preset whose namespace holds the package, else the first one of its top-level package.
    const preset = WORKSPACE_PRESETS.find((entry) => within(entry.namespace))
      ?? WORKSPACE_PRESETS.find((entry) => within(entry.namespace.split(".")[0]));
    return preset?.key ?? null;
  }, [normalizePackageName]);

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
    setSchemaProfileKey(inferProfileKey(ws.package));
    applyWorkspaceInStore(ws);
    if (ws.branch) {
      setOverviewBranch(ws.branch);

    }
  }, [applyWorkspaceInStore, inferProfileKey]);

  // Build-time defaults only fill in until the snapshot index reports the workspace.
  // Re-applying them later would undo a schema the user has just selected.
  const applyDefaultWorkspace = useCallback(() => {
    if (workspaceStateRef.current) return;
    applyWorkspace({ branch: DEFAULT_BRANCH, package: DEFAULT_PACKAGE, base_namespace: DEFAULT_NAMESPACE });
  }, [applyWorkspace]);

  const syncWorkspaceFromResponse = useCallback(
    (payload: WorkspaceEnvelope | null | undefined) => {
      if (isStaleResponse(payload)) return;
      if (payload?.workspace) applyWorkspace(payload.workspace);
    },
    [applyWorkspace, isStaleResponse]
  );

  const updateWorkspace = useCallback(
    async (updates: Partial<WorkspaceState>) => {

      // From here on, answers to earlier requests describe an outdated workspace.
      workspaceEpochRef.current += 1;
      try {
        const res = await api.put("/workspace", updates);
        syncWorkspaceFromResponse(res.data);
      } catch (error: unknown) {
        console.error("Failed to update workspace", error);
      }
    },
    [api, syncWorkspaceFromResponse]
  );

  const currentSchemaProfile = useMemo(
    () => schemaProfiles.find((profile) => profile.key === schemaProfileKey) ?? null,
    [schemaProfileKey, schemaProfiles]
  );
  const editRules: EditRules = currentSchemaProfile?.edit_rules ?? NOMAD_EDIT_RULES;
  const schemaSelectionRequired = !startEmpty && !currentSchemaProfile;
  const selectedSchemaReady = !schemaSelectionRequired && (!currentSchemaProfile || currentSchemaProfile.available);

  const filterActiveAuditForPackage = useCallback(
    (entries: AuditTrailEntry[], targetPackage?: string | null) => {
      const normalizedTarget = normalizePackageName(targetPackage);
      return entries.filter(
        (e) =>
          e?.change &&
          e.replayable !== false &&
          (!e.package || normalizePackageName(e.package) === normalizedTarget)
      );
    },
    [normalizePackageName]
  );

  const archiveAuditTrail = useCallback(() => {
    setAuditTrail((prev) => prev.map((entry) => ({ ...entry, replayable: false })));
  }, []);

  const appendAudit = useCallback(
    (change: AuditTrailEntry["change"], description: string, editIds?: string[], packageName?: string) => {
      const now = new Date().toISOString();
      const id = `${now}-${Math.random().toString(16).slice(2)}`;
      const pkgForEntry = packageName || graph?.package || pkg;
      const editGeneration = getBrowserEditStore().getGeneration();
      setAuditTrail((prev) => [
        ...prev,
        { change, description, id, timestamp: now, package: pkgForEntry, replayable: true, editIds, editGeneration },
      ]);
    },
    [graph, pkg]
  );

  const loadSchemaProfiles = useCallback(async () => {

    try {
      const res = await api.get("/schema/profiles");
      const profilesRaw = Array.isArray(res.data?.profiles) ? res.data.profiles : [];
      const parsed: SchemaProfileSummary[] = profilesRaw
        .filter((entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry: Record<string, unknown>) => ({
          key: typeof entry.key === "string" ? entry.key : "",
          label: typeof entry.label === "string" ? entry.label : "",
          default_branch: typeof entry.default_branch === "string" ? entry.default_branch : DEFAULT_BRANCH,
          default_package: typeof entry.default_package === "string" ? entry.default_package : DEFAULT_PACKAGE,
          default_base_namespace: typeof entry.default_base_namespace === "string" ? entry.default_base_namespace : DEFAULT_NAMESPACE,
          default_root: typeof entry.default_root === "string" ? entry.default_root : DEFAULT_ROOT,
          available: Boolean(entry.available),
          current: Boolean(entry.current),
          version: typeof entry.version === "string" ? entry.version : null,
          source: typeof entry.source === "string" ? entry.source : null,
          error: typeof entry.error === "string" ? entry.error : null,
          linkml_export: typeof entry.linkml_export === "boolean" ? entry.linkml_export : undefined,
          capabilities: Array.isArray(entry.capabilities)
            ? entry.capabilities.filter((item: unknown): item is string => typeof item === "string")
            : undefined,
          editable: typeof entry.editable === "boolean" ? entry.editable : undefined,
          edit_rules: parseEditRules(entry.edit_rules),
          empty: entry.empty === true,
          draft: entry.draft === true,
        }))
        .filter((entry: SchemaProfileSummary) => Boolean(entry.key));
      setSchemaProfiles(parsed);
      setSchemaProfileError(null);
      if (isStaleResponse(res.data)) return;
      const current = typeof res.data?.current_profile === "string" ? res.data.current_profile : null;
      setSchemaProfileKey(current || parsed.find((entry: SchemaProfileSummary) => entry.current)?.key || inferProfileKey(pkg));
      syncWorkspaceFromResponse(res.data);
    } catch (error) {
      setSchemaProfileError(`Could not load schema snapshots: ${formatApiError(error)}`);
    }
  }, [api, inferProfileKey, isStaleResponse, pkg, syncWorkspaceFromResponse]);

  useEffect(() => {
    applyDefaultWorkspace();
    void loadSchemaProfiles();
  }, [applyDefaultWorkspace, loadSchemaProfiles]);

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
    writePreference("schema-uml-left-width", String(clamp(sidebarWidth, 260, 520)));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writePreference("schema-uml-doc-width", String(clampDocWidth(docPanelWidth)));
  }, [clampDocWidth, docPanelWidth]);

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

  useEffect(() => {
    if (!workspace) return;
    const updates: Partial<WorkspaceState> = {};

    if (workspace.package !== pkg) updates.package = pkg;
    if (workspace.base_namespace !== normalizedNamespace) updates.base_namespace = normalizedNamespace;

    if (Object.keys(updates).length > 0) updateWorkspace(updates);
  }, [normalizedNamespace, pkg, updateWorkspace, workspace]);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = appShellRef.current?.getBoundingClientRect();
    const offsetLeft = rect?.left ?? 0;

    const onMove = (evt: MouseEvent) => {
      const next = evt.clientX - offsetLeft - 72;
      setSidebarWidthClamped(next);
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const helpSummary = useMemo(
    () => {
      const lines = [
        "Start page (center): pick a schema; its bird's-eye view lists every module with its classes, and a class opens its diagram.",
        "Setup: diagram options, Build graph, import and export.",
        "Graph canvas (center): pan/zoom, select classes; add, rename or remove classes and quantities directly.",
        "Inspector: switch between Properties and Documentation to inspect or edit the selection.",
        "Under the hood: inspect the selected class’s raw schema structure.",
        "History: log of your edits to communicate them; export or clear it anytime.",
      ];

      lines.push("Empty canvas: sketch your own classes and quantities without loading an existing schema.");
      return lines;
    },
    []
  );

  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  const focusAndOpen = useCallback((section: "workspace" | "documentation" | "audit" | "under" ) => {
    const mapping: Record<typeof section, { setter: (v: boolean) => void; elementId: string }> = {
      workspace: { setter: () => setLeftPanel("workspace"), elementId: "section-workspace" },
      documentation: { setter: () => {}, elementId: "section-documentation" },
      audit: { setter: () => setLeftPanel("history"), elementId: "section-audit" },
      under: { setter: setOpenUnderTheHood, elementId: "section-under" },
    };

    if (isMobile) setMobilePanel(section === "documentation" || section === "under" ? "details" : "workspace");
    if (section === "workspace" || section === "audit") setWorkspaceExpanded(true);
    const target = mapping[section];
    target.setter(true);
    if (section === "documentation" || section === "under") setDocPanelCollapsed(false);
    // Wait a frame so a collapsed right panel is visible before scrolling to it.
    requestAnimationFrame(() => {
      const el = document.getElementById(target.elementId);
      if (el) {
        const behavior: ScrollBehavior =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth";
        el.scrollIntoView({ behavior, block: "start" });
        const headerBtn = el.querySelector("button.collapsible-header") as HTMLButtonElement | null;
        headerBtn?.focus({ preventScroll: true });
      }
    });
  }, [isMobile, setMobilePanel]);

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

  // Keeps the root a section of the selected package.
  const loadRoots = useCallback(async () => {

    if (startEmpty) {
      setRoot("");
      return;
    }
    setErr(null);
    try {
      const r = await api.get("/roots", { params: { package: pkg, branch: undefined } });
      const list = r.data.sections || [];
      // The whole data model has no root.
      if (list.length > 0 && !list.includes(root) && !wholeModelActive) setRoot(list[0]);
      syncWorkspaceFromResponse(r.data);
    } catch (e: unknown) {
      setErr(formatApiError(e));
    }
  }, [api, pkg, root, startEmpty, syncWorkspaceFromResponse, wholeModelActive]);

  // Fetch and validate without changing UI state; callers must check freshness before syncing.
  const fetchGraph = useCallback(async (
    opts: { pkg: string; root: string; namespace: string; branch: string; empty: boolean; expand: string[] }
  ): Promise<ApiGraph> => {
    const expand = opts.expand.length ? opts.expand.join(",") : undefined;
    const response = await api.get("/schema", {
      params: {
        package: opts.pkg,
        root: opts.root,
        include_quantities: includeQuantities,
        include_subsections: includeSubsections,
        include_inheritance: includeInheritance,
        allow_cross_module: crossModules,
        base_namespace: opts.namespace || undefined,
        expand,
        ...(opts.empty ? { empty: true } : {}),
      },
    });
    const parsed = ensureGraphResponse(response.data);
    // Retain the transport's workspace epoch through validation without syncing it yet.
    Object.defineProperty(parsed, WORKSPACE_EPOCH, {
      value: (response.data as Record<string, unknown>)[WORKSPACE_EPOCH],
    });
    return parsed;
  }, [api, crossModules, includeQuantities, includeSubsections, includeInheritance]);

  // Build the selected snapshot graph.
  // keepView: the same graph again (after an undo, say), so the canvas keeps its layout and view.
  const loadGraph = useCallback(async (
    overrides?: { pkg?: string; root?: string; namespace?: string; branch?: string; forceEmpty?: boolean; expand?: string[]; keepView?: boolean }
  ) => {

    const pkgToUse = overrides?.pkg ?? pkg;
    const rootToUse = overrides?.root ?? root;
    const namespaceToUse = overrides?.namespace ?? normalizedNamespace;
    const branchToUse = overrides?.branch ?? workspaceBranch ?? "";
    const useEmpty = overrides?.forceEmpty ?? startEmpty;
    const identity: CanvasIdentity = { package: pkgToUse, root: rootToUse, namespace: namespaceToUse, branch: branchToUse, empty: useEmpty };
    const identityChanged = !sameCanvas(canvasIdentityRef.current, identity);
    if (identityChanged) invalidateGraphRequests();
    canvasIdentityRef.current = identity;
    if (!useEmpty) {
      setStartEmpty(false);
      setCanvasStatus(null);
    }
    setErr(null);
    setQuantityActionErr(null);
    setLoading(true);

    const request = ++graphRequestRef.current;
    const auditIds = new Set(auditTrail.filter(entry =>
      normalizePackageName(entry.package || pkg) === normalizePackageName(pkgToUse)
    ).map(entry => entry.id));
    // Another module or root starts with no class expanded.
    const expand = overrides?.expand ?? (identityChanged ? [] : expandIntentRef.current);
    try {
      const parsed = await fetchGraph({
        pkg: pkgToUse, root: rootToUse, namespace: namespaceToUse, branch: branchToUse, empty: useEmpty, expand,
      });
      if (request !== graphRequestRef.current) return false;
      syncWorkspaceFromResponse(parsed);
      expandedRef.current = expand;
      expandIntentRef.current = expand;
      setExpandedClasses(expand);
      setGraph(parsed);
      setBaseGraph(parsed);
      if (!overrides?.keepView) setCanvasKey((key) => key + 1);
      if (useEmpty) return true;
      // If the browser backend returned a clean graph without applied persisted edits, archive any local audit history
      // so “active edits” reflects only new work in this session.
      if (!parsed.applied_edits || parsed.applied_edits.length === 0) {
        setAuditTrail(prev => prev.map(entry => auditIds.has(entry.id) ? { ...entry, replayable: false } : entry));
      }
      return true;
    } catch (e: unknown) {
      if (request !== graphRequestRef.current) return false;
      const message = formatApiError(e);
      setErr(message || "Failed to load graph");
      setGraph(null);
      setBaseGraph(null);
      return false;
    } finally {
      if (request === graphRequestRef.current) setLoading(false);
    }
  }, [auditTrail, fetchGraph, invalidateGraphRequests, normalizePackageName, normalizedNamespace, pkg, root, setStartEmpty, startEmpty, syncWorkspaceFromResponse, workspaceBranch]);

  const latestLoadGraph = useRef(loadGraph);
  useEffect(() => { latestLoadGraph.current = loadGraph; }, [loadGraph]);

  const resetEmptyCanvas = useCallback(async () => {

    const targetPkg = scratchPackage;
    // Also guard imperative callers and clicks before React renders disabled state.
    if (pendingMutationsRef.current[targetPkg]) return;
    invalidateGraphRequests();
    canvasIdentityRef.current = { package: targetPkg, root: "", namespace: normalizedNamespace, branch: workspaceBranch ?? "", empty: true };
    const epoch = canvasEpochRef.current;
    // Capture only entries this deletion covers; later edits must retain their history.
    const archivedIds = new Set(auditTrail.filter(entry =>
      normalizePackageName(entry.package || graph?.package || pkg) === normalizePackageName(targetPkg)
    ).map(entry => entry.id));
    try {
      setCanvasStatus("Resetting canvas…");
      setErr(null);
      await withPendingMutation(targetPkg, () => api.delete("/schema/edits", { params: { package: targetPkg } }));
      setAuditTrail(prev => prev.map(entry => archivedIds.has(entry.id) ? { ...entry, replayable: false } : entry));
      if (epoch !== canvasEpochRef.current) return;
      setGraph(null);
      setBaseGraph(null);
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      const reload = latestLoadGraph.current({ pkg: targetPkg, root: "", namespace: normalizedNamespace, branch: workspaceBranch, forceEmpty: true, expand: [], keepView: true });
      setCanvasKey(key => key + 1);
      const reloadRequest = graphRequestRef.current;
      const loaded = await reload;
      if (epoch === canvasEpochRef.current && reloadRequest === graphRequestRef.current) {
        const status = loaded ? "Canvas reset to empty." : "Reset failed: edits were cleared, but the canvas could not be reloaded.";
        setCanvasStatus(status);
        if (!loaded) setErr(status);
      }
    } catch (e: unknown) {
      if (epoch !== canvasEpochRef.current) return;
      setCanvasStatus(`Reset failed: ${formatApiError(e)}`);
    }
  }, [api, auditTrail, graph?.package, invalidateGraphRequests, normalizePackageName, normalizedNamespace, pkg, scratchPackage, setSelected, withPendingMutation, workspaceBranch]);


  const applySchemaProfile = useCallback(async (profileKey: string) => {
    const selected = schemaProfiles.find((profile) => profile.key === profileKey);
    const fallbackPreset = WORKSPACE_PRESETS.find((preset) => preset.key === profileKey);
    const nextPackage = selected?.default_package ?? fallbackPreset?.pkg;
    const nextNamespace = selected?.default_base_namespace ?? fallbackPreset?.namespace;
    const nextBranch = selected?.default_branch ?? fallbackPreset?.branch ?? DEFAULT_BRANCH;
    const nextRoot = selected?.default_root ?? fallbackPreset?.root ?? DEFAULT_ROOT;
    if (!nextPackage || !nextNamespace) return;

    setSchemaProfileKey(profileKey);
    setPkg(nextPackage);
    setRoot(nextRoot);

    applyWorkspace({ branch: nextBranch, package: nextPackage, base_namespace: nextNamespace });
    await updateWorkspace({
      branch: nextBranch,
      package: nextPackage,
      base_namespace: nextNamespace,
    });
  }, [applyWorkspace, schemaProfiles, setPkg, updateWorkspace]);

  const databases = useMemo<DatabaseButton[]>(
    () => (schemaProfiles.length
      ? schemaProfiles
      : WORKSPACE_PRESETS.map((preset) => ({
        key: preset.key, label: preset.label, available: true, draft: preset.draft, default_branch: preset.branch,
      }))),
    [schemaProfiles]
  );
  const selectedDatabaseKey = schemaProfileKey ?? inferProfileKey(pkg);
  // Only bam-masterdata offers the whole data model; the NOMAD schemas are too large to draw at once.
  const wholeModelOffered = selectedDatabaseKey?.startsWith("bam-masterdata") ?? false;
  const selectedDatabaseLabel = databases.find((entry) => entry.key === selectedDatabaseKey)?.label ?? null;

  // A database button opens the bird's-eye view of that schema; a class there opens its diagram.
  const showOverview = useCallback(() => {
    canvasIdentityRef.current = null;
    invalidateGraphRequests();
    setMode("overview");
  }, [invalidateGraphRequests]);

  const openDatabase = useCallback(async (profileKey: string) => {
    showOverview();
    setOverviewQuery("");
    await applySchemaProfile(profileKey);
  }, [applySchemaProfile, showOverview]);

  // Keeps the package one of the schema's modules on the selected branch.
  const loadPackages = useCallback(async () => {

    setErr(null);
    try {
      const r = await api.get("/git/packages", {
        params: {
          branch: undefined,
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
      syncWorkspaceFromResponse(r.data);

      // if current pkg is not in the list, default to the first entry (keep scratch when empty and the whole model)
      if (unique.length > 0 && !unique.includes(pkg) && pkg !== wholeModelPackage) {
        setPkg(startEmpty && scratchPackage ? scratchPackage : unique[0]);
      }
    } catch (e) {
      console.error("Failed to load packages", e);
      setErr(formatApiError(e));
    }
  }, [api, normalizedNamespace, pkg, scratchPackage, setPkg, startEmpty, syncWorkspaceFromResponse, wholeModelPackage]);

  useEffect(() => {
    if (!workspace) return;

    loadSchemaProfiles();
    loadPackages();
    loadRoots();
  }, [loadPackages, loadRoots, loadSchemaProfiles, workspace]);


  const seedAuditFromAppliedEdits = useCallback(
    (graphWithEdits: ApiGraph | null) => {
      if (!graphWithEdits) return;

      setAuditTrail((prev) => {
        // Never keep snapshot persisted entries in the client audit panel.
        const pruned = prev.filter(
          (entry) => !(typeof entry.id === "string" && entry.id.startsWith("persisted-"))
        );
        return pruned.length === prev.length ? prev : pruned;
      });
    },
    [setAuditTrail]
  );

  const toggleEmptyMode = useCallback(async () => {
    const nextShouldBeEmpty = !emptyCanvasActive;
    setStartEmpty(nextShouldBeEmpty);
    if (nextShouldBeEmpty) {
      const targetPkg = scratchPackage;
      const persistedCustom = auditTrail.length === 0 && (graph?.package === targetPkg || baseGraph?.package === targetPkg);
      if (persistedCustom) {
        // If we have stale custom edits but no audit trail (e.g., after refresh), wipe them so the canvas truly starts empty.
        await resetEmptyCanvas();
        return;
      }
      const blankGraph: ApiGraph = { package: targetPkg, root: "", nodes: [], edges: [] };
      setMode("graph");

      archiveAuditTrail();
      graphRequestRef.current += 1;
      setGraph(blankGraph);
      setBaseGraph(blankGraph);
      setCanvasKey((key) => key + 1);
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setRoot("");
      setPkg(targetPkg);
      setCanvasStatus(null);
      await loadGraph({ pkg: targetPkg, root: "", namespace: normalizedNamespace, forceEmpty: true, expand: [] });
    } else {
      await loadGraph({ forceEmpty: false });
    }
  }, [archiveAuditTrail, auditTrail.length, baseGraph?.package, emptyCanvasActive, graph?.package, loadGraph, normalizedNamespace, resetEmptyCanvas, scratchPackage, setPkg, setSelected, setStartEmpty]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writePreference("schema-uml-theme", theme);
  }, [theme]);

  useEffect(() => {
    writePreference(LAYOUT_DIRECTION_STORAGE_KEY, layoutDirection);
  }, [layoutDirection]);

  useEffect(() => {
    expandedRef.current = [];
    expandIntentRef.current = [];
    setExpandedClasses([]);
  }, [pkg, root]);

  useEffect(() => {
    seedAuditFromAppliedEdits(graph);
  }, [graph, seedAuditFromAppliedEdits]);

  useEffect(() => {
    if (!auditTrail.length && graph) {
      setBaseGraph(graph);
    }
  }, [auditTrail.length, graph]);

  // Archive audit entries that are already reflected in the snapshot baseline graph
  // (so the "active" list only shows changes not yet persisted). We purposely compare against
  // the baseline graph, not the current in-memory graph, otherwise freshly applied edits would
  // be mis-flagged as archived immediately after the user makes them.
  const archiveStaleAuditEntries = useCallback(
    (baseline: ApiGraph | null) => {
      if (!baseline) return;
      const classIds = new Set(
        baseline.nodes.filter((n) => n.kind === "section").map((n) => normalizeId(n.id))
      );
      const quantityIds = new Set(
        baseline.nodes.filter((n) => n.kind === "quantity").map((n) => normalizeId(n.id))
      );

      setAuditTrail((prev) => {
        let mutated = false;
        const next = prev.map((entry) => {
          if (entry.replayable === false) return entry;
          const isServerSeeded = typeof entry.id === "string" && entry.id.startsWith("persisted-");
          if (!isServerSeeded) return entry;
          const change = entry.change;
          const applied = (() => {
            switch (change.type) {
              case "add-class":
                // Change is already reflected if class is present.
                return classIds.has(normalizeId(change.cls.id));
              case "remove-class":
                // Reflected if class is gone.
                return !classIds.has(normalizeId(change.cls.id));
              case "edit-class":
                // Reflected if the edited class is present.
                return classIds.has(normalizeId(change.after.id));
              case "add-quantity":
                // Reflected if quantity is present.
                return quantityIds.has(normalizeId(change.quantity.id));
              case "remove-quantity":
                // Do not auto-archive removals; keep them active so users can undo
                // even when the baseline graph is missing that quantity (e.g., filtered loads).
                return false;
              case "edit-quantity":
                // Reflected if the updated quantity exists.
                return quantityIds.has(normalizeId(change.after.id));
              default:
                return false;
            }
          })();
          // If the change is already applied in the browser backend graph, archive it.
          if (applied) {
            mutated = true;
            return { ...entry, replayable: false };
          }
          return entry;
        });
        return mutated ? next : prev;
      });
    },
    [setAuditTrail]
  );

  useEffect(() => {
    archiveStaleAuditEntries(baseGraph);
  }, [archiveStaleAuditEntries, baseGraph]);

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
            inherited: q.inherited ?? false,
            inheritedFromId: q.inheritedFromId ?? null,
            inheritedFromName: q.inheritedFromName ?? null,
            sourceId: q.sourceId ?? null,
            details: q.details ?? null,
          })),
          details: cls.details ?? null,
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
        inherited: qty.inherited ?? false,
        inheritedFromId: qty.inheritedFromId ?? null,
        inheritedFromName: qty.inheritedFromName ?? null,
        sourceId: qty.sourceId ?? null,
        details: qty.details ?? null,
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
        inherited: q.inherited ?? false,
        inheritedFromId: q.inheritedFromId ?? null,
        inheritedFromName: q.inheritedFromName ?? null,
        sourceId: q.sourceId ?? null,
        details: q.details ?? null,
      })),
      details: cls.details ?? null,
    });
  }, [selectedClassId, selectedQuantityId, setSelected, umlState]);

  type EditRequest = { op: string; target: string; payload: Record<string, unknown> };

  const editIdsOf = (updated: ApiGraph): string[] =>
    (updated.persisted_edits ?? []).map((edit) => edit.id).filter((id): id is string => Boolean(id));

  // Store edits on the browser backend (all or none) and show the graph it rebuilds from the edited schema.
  const submitEdits = async (edits: EditRequest[]): Promise<ApiGraph> => {
    const targetPackage = graph?.package || pkg;
    // A failed save leaves pending reads and expansion intent intact. Only success
    // supersedes pre-mutation reads; navigation is tracked independently.
    const expand = expandIntentRef.current;
    const epoch = canvasEpochRef.current;
    const request = graphRequestRef.current;
    const res = await withPendingMutation(targetPackage, () => api.post(
      "/schema/edits",
      { package: targetPackage, edits },
      {
        params: {
          root,
          include_quantities: includeQuantities,
          include_subsections: includeSubsections,
          include_inheritance: includeInheritance,
          allow_cross_module: crossModules,
          base_namespace: normalizedNamespace || undefined,
          empty: startEmpty ? true : undefined,
          expand: expand.length ? expand.join(",") : undefined,
          branch: undefined,
        },
      }
    ));
    const updated = ensureGraphResponse(res.data);
    if (epoch !== canvasEpochRef.current) return updated;
    // A renamed root follows its class even when the graph needs reconciliation.
    if ((updated.root ?? "") !== (root ?? "")) setRoot(updated.root ?? "");
    if (canvasIdentityRef.current) canvasIdentityRef.current = { ...canvasIdentityRef.current, root: updated.root ?? "" };
    if (request !== graphRequestRef.current) {
      // A refresh may have read before persistence. Re-read after the mutation,
      // retaining the user's latest expansion/filter choices in this canvas.
      void latestLoadGraph.current({ keepView: true, root: updated.root ?? "", expand: expandIntentRef.current });
      return updated;
    }
    graphRequestRef.current += 1;
    syncWorkspaceFromResponse(res.data);
    const merged = replayGraphWithAudit(updated);
    expandedRef.current = expand;
    expandIntentRef.current = expand;
    setExpandedClasses(expand);
    setBaseGraph(updated);
    setGraph(merged);
    setLoading(false);
    return updated;
  };

  const createQuantityOnCanvas = async (classId: string, data: QuantityFormData) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }

    const targetClass = umlState?.classes.find((c) => c.id === classId);
    if (!targetClass) {
      const message = "Select a class to add the quantity.";
      setQuantityActionErr(message);
      throw new Error(message);
    }

    const uiIsCurrent = beginEditUiOperation();
    const epoch = canvasEpochRef.current;
    const creation = ++quantityCreationRef.current;
    setCreatingQuantityFor(classId);
    setQuantityActionErr(null);
    try {
      const trimmedName = data.quantityName.trim();
      const code = data.code?.trim() || "";
      const description = data.docstring.trim() || undefined;
      const isVocabulary = editRules.codes && targetClass.quantities.some((q) => q.dtype === VOCAB_TERM);
      let edit: EditRequest;
      if (isVocabulary) {
        edit = { op: "add_enum_value", target: classId, payload: { value: code, label: data.label?.trim() || undefined, description } };
      } else if (editRules.codes) {
        edit = {
          op: "add_attribute",
          target: classId,
          payload: {
            code,
            name: trimmedName || undefined,
            data_type: data.dtype,
            range: data.range || undefined,
            mandatory: Boolean(data.mandatory),
            label: data.label?.trim() || undefined,
            description,
          },
        };
      } else {
        const visibleNameConflict = targetClass.quantities.find((q) => q.name === trimmedName);
        if (visibleNameConflict) {
          const inheritedFrom = visibleNameConflict.inheritedFromName || visibleNameConflict.inheritedFromId;
          const message = visibleNameConflict.inherited
            ? `Quantity '${trimmedName}' is inherited from ${inheritedFrom || "a parent class"} and cannot be redefined on ${targetClass.name}.`
            : `A quantity named '${trimmedName}' already exists on ${targetClass.name}.`;
          setQuantityActionErr(message);
          throw new Error(message);
        }
        edit = { op: "add_attribute", target: classId, payload: { name: trimmedName, kind: "quantity", dtype: data.dtype, description } };
      }

      const updated = await submitEdits([edit]);
      const stored = updated.persisted_edits?.[0];
      const addedName = String(stored?.payload?.name ?? trimmedName);
      const addedId = `${classId}.${addedName}`;
      const addedNode = updated.nodes.find((n) => n.id === addedId);
      const addedQuantity: QuantityNode = {
        id: addedId,
        name: addedName,
        dtype: addedNode?.dtype ?? undefined,
        doc: addedNode?.doc ?? description ?? null,
        ownerId: classId,
        shape: addedNode?.shape ?? null,
        card: addedNode?.card ?? null,
        path: null,
        line: null,
      };
      appendAudit(
        { type: "add-quantity", classId, quantity: addedQuantity },
        `Added ${isVocabulary ? "term" : "quantity"} ${addedQuantity.name}${addedQuantity.dtype ? `: ${addedQuantity.dtype}` : ""} to class ${targetClass.name}`,
        editIdsOf(updated),
        updated.package
      );
      if (uiIsCurrent()) setSelectedClassId(classId);
      if (uiIsCurrent()) setSelectedQuantityId(addedId);
    } catch (e: unknown) {
      const message = formatApiError(e);
      if (uiIsCurrent()) setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      if (epoch === canvasEpochRef.current && creation === quantityCreationRef.current) setCreatingQuantityFor(null);
    }
  };

  const createClassOnCanvas = async ({ name, parentId, docstring, relation, card }: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection"; card?: string }) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }

    const uiIsCurrent = beginEditUiOperation();
    const epoch = canvasEpochRef.current;
    const creation = ++classCreationRef.current;
    setCreatingClass(true);
    setQuantityActionErr(null);
    try {
      const classRelation = parentId ? relation || "inherits" : "inherits";
      const subsectionCard = classRelation === "hasSubSection" ? card?.trim() : null;
      const targetPackage = currentGraph.package || pkg;
      const edits: EditRequest[] = [];
      if (editRules.codes) {
        if (classRelation === "hasSubSection") {
          throw new Error("bam-masterdata has no subsections; link object types with an OBJECT property instead.");
        }
        // bam-masterdata names a new object type by its code; the class name follows from it.
        edits.push({ op: "add_class", target: "", payload: { code: name, is_a: parentId || undefined, description: docstring || undefined } });
      } else {
        edits.push({
          op: "add_class",
          target: "",
          payload: { name, is_a: classRelation === "inherits" ? parentId || undefined : undefined, description: docstring || undefined },
        });
        if (parentId && classRelation === "hasSubSection") {
          const upper = subsectionCard?.split("..").pop() ?? "";
          edits.push({
            op: "add_attribute",
            target: parentId,
            payload: {
              name: subsectionName(name),
              kind: "subsection",
              range: `${targetPackage}.${name}`,
              multivalued: upper === "*" || Number(upper) > 1,
            },
          });
        }
      }
      const next = await submitEdits(edits);
      const newClassId = next.persisted_edits?.[0]?.target || normalizeId(`${targetPackage}.${name}`);
      const newNode = next.nodes.find((n) => n.kind === "section" && n.id === newClassId);
      const newCls: UmlClassNode = {
        id: newClassId,
        name: newNode?.label || name,
        doc: docstring,
        module: targetPackage,
        parentId: parentId,
        parentRelation: parentId ? classRelation : null,
        parentCard: subsectionCard,
        quantities: [],
        path: null,
        line: null,
      };
      appendAudit(
        { type: "add-class", cls: newCls },
        parentId ? `Added class ${newCls.name} extending ${parentId}` : `Added class ${newCls.name}`,
        editIdsOf(next),
        next.package
      );
      if (uiIsCurrent()) setSelectedClassId(newCls.id);
      if (uiIsCurrent()) setSelectedQuantityId(null);
    } catch (e: unknown) {
      const message = formatApiError(e);
      if (uiIsCurrent()) setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      if (epoch === canvasEpochRef.current && creation === classCreationRef.current) setCreatingClass(false);
    }
  };

  const removeQuantityFromGraphState = useCallback((g: ApiGraph, quantityId: string): ApiGraph => {
    const nodes = (g.nodes || []).filter((n) => n.id !== quantityId);
    const edges = (g.edges || []).filter((e) => e.source !== quantityId && e.target !== quantityId);
    return { ...g, nodes, edges };
  }, []);

  const addQuantityToGraphState = useCallback((g: ApiGraph, quantity: QuantityNode): ApiGraph => {
    const qNode: ApiNode = {
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
    const hasNode = (g.nodes || []).some((n) => n.id === quantity.id);
    const nodes: ApiNode[] = hasNode
      ? (g.nodes || []).map((n) => (n.id === quantity.id ? { ...n, ...qNode } : n))
      : [...(g.nodes || []), qNode];
    const edgeExists = (g.edges || []).some((e) => e.source === quantity.ownerId && e.target === quantity.id);
    const edges: ApiEdge[] = edgeExists
      ? g.edges || []
      : [...(g.edges || []), { source: quantity.ownerId, target: quantity.id, type: "hasQuantity" as const, card: quantity.card ?? null }];
    return { ...g, nodes, edges };
  }, []);

  const removeClassFromGraphState = useCallback((g: ApiGraph, classId: string): ApiGraph => {
    const removedQuantityIds = (g.nodes || []).filter((n) => n.owner === classId).map((n) => n.id);
    const nodes = (g.nodes || []).filter(
      (n) => n.id !== classId && !removedQuantityIds.includes(n.id)
    );
    const edges = (g.edges || []).filter(
      (e) =>
        e.source !== classId &&
        e.target !== classId &&
        !removedQuantityIds.includes(e.source) &&
        !removedQuantityIds.includes(e.target)
    );
    return { ...g, nodes, edges };
  }, []);

  const editClassInGraphState = useCallback((g: ApiGraph, cls: UmlClassNode): ApiGraph => {
    const nodes = (g.nodes || []).map((n) => {
      if (n.kind !== "section" || n.id !== cls.id) return n;
      return { ...n, doc: cls.doc ?? null };
    });
    return { ...g, nodes };
  }, []);

  const addClassToGraphState = useCallback((g: ApiGraph, cls: UmlClassNode): ApiGraph => {
    const nodesWithoutClass = (g.nodes || []).filter((n) => !(n.kind === "section" && n.id === cls.id));
    const sectionNode: ApiNode = {
      id: cls.id,
      kind: "section",
      label: cls.name,
      module: cls.module ?? g.package,
      doc: cls.doc ?? null,
      path: cls.path ?? null,
      line: cls.line ?? null,
    };
    const ownedQuantities = cls.quantities.filter((q) => !q.inherited);
    const qtyNodes: ApiNode[] = ownedQuantities.map((q) => ({
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
    const qtyEdges: ApiEdge[] = ownedQuantities.map((q) => ({
      source: q.ownerId,
      target: q.id,
      type: "hasQuantity" as const,
      card: q.card ?? null,
    }));
    const relationType: ApiEdge["type"] = cls.parentRelation === "hasSubSection" ? "hasSubSection" : "inherits";
    const parentLinkEdge: ApiEdge[] = cls.parentId
      ? relationType === "inherits"
        ? [{ source: cls.id, target: cls.parentId, type: relationType, card: null }]
        : [{ source: cls.parentId, target: cls.id, type: relationType, card: cls.parentCard ?? null }]
      : [];

    return {
      ...g,
      nodes: [...nodesWithoutClass, sectionNode, ...qtyNodes],
      edges: [
        ...(g.edges || []).filter(
          (e) =>
            !((e.type === "inherits" && e.source === cls.id) || (e.type === "hasSubSection" && e.target === cls.id))
        ),
        ...qtyEdges,
        ...parentLinkEdge
      ],
    };
  }, []);

  const applyForwardChange = useCallback((current: ApiGraph, change: AuditTrailEntry["change"]): ApiGraph => {
    switch (change.type) {
      case "add-class":
        return addClassToGraphState(current, change.cls);
      case "remove-class":
        return removeClassFromGraphState(current, change.cls.id);
      case "edit-class":
        return editClassInGraphState(current, change.after);
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
  }, [addClassToGraphState, addQuantityToGraphState, editClassInGraphState, removeClassFromGraphState, removeQuantityFromGraphState]);

  const replayGraphWithAudit = useCallback(
    (snapshotGraph: ApiGraph, extraChange?: AuditTrailEntry["change"]): ApiGraph => {
      const targetPackage = normalizePackageName(snapshotGraph.package) || normalizePackageName(pkg);
      // Stored edits are already in the snapshot graph; only local changes are replayed.
      const scopedEntries = filterActiveAuditForPackage(auditTrail, targetPackage).filter((a) => !a.editIds?.length);
      const changes = scopedEntries.map((a) => a.change).filter(Boolean) as AuditTrailEntry["change"][];
      const allChanges = extraChange ? [...changes, extraChange] : changes;
      return allChanges.reduce((acc, change) => applyForwardChange(acc, change), snapshotGraph);
    },
    [applyForwardChange, auditTrail, filterActiveAuditForPackage, normalizePackageName, pkg]
  );

  // Shows or hides a class's subclasses: the browser core rebuilds the graph with the new set of expanded
  // classes, and the canvas adds or removes only the classes that differ. A quick second click builds
  // on the first; only the answer to the latest request is shown.
  const toggleSubclasses = useCallback(
    async (classId: string) => {
      if (loading) return;
      const current = expandIntentRef.current;
      const next = current.includes(classId) ? current.filter((id) => id !== classId) : [...current, classId];
      expandIntentRef.current = next;
      const request = ++graphRequestRef.current;
      setErr(null);
      try {
        const parsed = await fetchGraph({
          pkg: graph?.package || pkg, root: startEmpty ? "" : root, namespace: normalizedNamespace,
          branch: workspaceBranch ?? "", empty: startEmpty, expand: next,
        });
        if (request !== graphRequestRef.current) return;
        syncWorkspaceFromResponse(parsed);
        expandedRef.current = next;
        setExpandedClasses(next);
        setBaseGraph(parsed);
        setGraph(replayGraphWithAudit(parsed));
      } catch (e: unknown) {
        if (request !== graphRequestRef.current) return;
        expandIntentRef.current = expandedRef.current;
        setErr(formatApiError(e) || "Failed to load graph");
      }
    },
    [fetchGraph, graph?.package, loading, normalizedNamespace, pkg, replayGraphWithAudit, root, startEmpty, syncWorkspaceFromResponse, workspaceBranch]
  );

  const rebuildGraphWithAudit = useCallback(
    (entries: AuditTrailEntry[]) => {
      const baseline = baseGraph ?? graph;
      if (!baseline) return;
      const targetPackage = normalizePackageName(baseline.package || pkg);
      const applicable = filterActiveAuditForPackage(entries, targetPackage).filter((a) => !a.editIds?.length);
      const rebuilt = applicable.reduce((acc, curr) => applyForwardChange(acc, curr.change), baseline);
      setGraph(rebuilt);
    },
    [applyForwardChange, baseGraph, filterActiveAuditForPackage, graph, normalizePackageName, pkg]
  );

  // Deletes the stored edits of audit entries (and a module's own edits) in one request: all or none.
  const deleteStoredEdits = useCallback(
    async (ids: string[], packageName?: string) => {
      await withPendingMutation(packageName || graph?.package || pkg, () => api.delete("/schema/edits", { params: { package: packageName }, data: { ids } }));
    },
    [api, graph?.package, pkg, withPendingMutation]
  );

  const undoAuditEntry = async (id: string) => {
    const entry = auditTrail.find((a) => a.id === id);
    if (!entry || !entry.change) return;
    setQuantityActionErr(null);
    const epoch = canvasEpochRef.current;

    if (entry.editIds?.length) {
      try {
        await deleteStoredEdits(entry.editIds);
      } catch (e: unknown) {
        // Nothing was deleted; the entry stays so the undo can be tried again.
        if (epoch === canvasEpochRef.current) setQuantityActionErr(`Undo failed: ${formatApiError(e)}`);
        return;
      }
      setAuditTrail(prev => prev.filter(item => item.id !== id && item.change));
      if (epoch === canvasEpochRef.current) await latestLoadGraph.current({ keepView: true });
      return;
    }

    const remaining = auditTrail.filter((a) => a.id !== id && a.change);
    setAuditTrail(remaining as AuditTrailEntry[]);
    rebuildGraphWithAudit(remaining as AuditTrailEntry[]);
  };

  // Clears what the audit panel shows: this module's stored edits and the edits its entries made.
  const clearAuditTrail = async () => {
    const targetPackage = currentPackageForAudit || pkg;
    if (pendingMutationsRef.current[targetPackage]) return;
    const hasLocalAudit = auditEntriesForCurrentPackage.length > 0;
    const hasPersistedEdits = (graph?.applied_edits?.length ?? 0) > 0 || (graph?.edit_conflicts?.length ?? 0) > 0;
    if (!hasLocalAudit && !hasPersistedEdits) return;
    const epoch = canvasEpochRef.current;
    const ids = auditEntriesForCurrentPackage.flatMap((entry) => entry.editIds ?? []);
    setQuantityActionErr(null);
    try {
      await deleteStoredEdits(ids, targetPackage);
    } catch (e: unknown) {
      if (epoch === canvasEpochRef.current) setQuantityActionErr(`Clear failed: ${formatApiError(e)}`);
      return;
    }
    setAuditTrail((prev) => prev.filter((entry) => !auditEntriesForCurrentPackage.includes(entry)));
    if (epoch === canvasEpochRef.current) await latestLoadGraph.current({ keepView: true });
  };

  useEffect(() => {
    loadRoots();
  }, [pkg, startEmpty, loadRoots]);

  // If user switches away from the scratch package, exit empty mode to restore schema-backed behavior.
  useEffect(() => {
    if (startEmpty && pkg !== scratchPackage) {
      setStartEmpty(false);
      setCanvasStatus(null);
    }
  }, [pkg, scratchPackage, setStartEmpty, startEmpty]);

  useEffect(() => {

    loadPackages();
  }, [loadPackages, normalizedNamespace]);

  const addBlockedReason =
    mode !== "graph"
      ? "Switch to diagram view to modify quantities"
      : !graph
          ? "Build a graph first to modify quantities"
          : wholeModelActive
            ? "The whole data model is view only; open a class from the class list to edit it"
            : null;

  const currentGraph = graph;
  const currentPackageForAudit = normalizePackageName(currentGraph?.package || pkg);
  const auditEntriesForCurrentPackage = useMemo(
    () =>
      auditTrail.filter(
        (entry) => entry?.change && (!entry.package || normalizePackageName(entry.package) === currentPackageForAudit)
      ),
    [auditTrail, currentPackageForAudit, normalizePackageName]
  );
  const activeAuditEntries = useMemo(
    () => filterActiveAuditForPackage(auditEntriesForCurrentPackage, currentPackageForAudit),
    [auditEntriesForCurrentPackage, currentPackageForAudit, filterActiveAuditForPackage]
  );
  const activeAuditCount = activeAuditEntries.length;
  const archivedAuditCount = auditEntriesForCurrentPackage.length - activeAuditCount;

  const restoreArchivedEntry = (id: string) => {
    const updated = auditTrail.map((entry) =>
      entry.id === id
        ? { ...entry, replayable: true, package: currentPackageForAudit }
        : entry
    );
    setAuditTrail(updated);
    rebuildGraphWithAudit(updated);
  };

  const restoreAllArchivedToCurrent = () => {
    if (!auditTrail.length) return;
    const updated = auditTrail.map((entry) => {
      const onCurrentCanvas = !entry.package || normalizePackageName(entry.package) === currentPackageForAudit;
      if (!onCurrentCanvas || entry.replayable !== false) return entry;
      return {
        ...entry,
        replayable: true,
        package: currentPackageForAudit,
      };
    });
    setAuditTrail(updated);
    rebuildGraphWithAudit(updated);
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

  // Selects the root class of a graph once the canvas has laid it out, leaving the fitted view as it is.
  const focusRootSection = useCallback((handle: GraphExportHandle) => {
    const targetRoot = normalizeId(currentGraph?.root || root);
    if (!targetRoot) return;

    const handled = handle.focusNode(targetRoot, { moveViewport: false });
    if (handled) return;

    const fallbackNode = currentGraph?.nodes?.find?.((n) => {
      const label = n.label || (n as { rawName?: string }).rawName || "";
      return normalizeId(n.id) === targetRoot || normalizeId(label) === targetRoot;
    });

    if (fallbackNode) {
      const fallbackId = normalizeId(fallbackNode.id);
      const fallbackName = normalizeLabel(
        fallbackNode.label || (fallbackNode as { rawName?: string }).rawName || "",
        fallbackId
      );
      setSelected({
        id: fallbackId,
        kind: "class",
        name: fallbackName,
        doc: fallbackNode.doc || "",
        path: fallbackNode.path || "",
        line: typeof fallbackNode.line === "number" ? fallbackNode.line : undefined,
        fqid: fqidFromParts(fallbackNode.module, fallbackName, fallbackId),
      });
      setSelectedClassId(fallbackId);
      setSelectedQuantityId(null);
    }
  }, [currentGraph, root, setSelected, setSelectedClassId, setSelectedQuantityId]);

  const returnToHome = useCallback(() => {
    canvasIdentityRef.current = null;
    invalidateGraphRequests();
    setErr(null);
    setMode("graph");
    setGraph(null);
    setBaseGraph(null);

    setSelectedClassId(null);
    setSelectedQuantityId(null);
    setSelected(null);
    setCanvasStatus(null);
    setQuantityActionErr(null);
    setCreatingQuantityFor(null);
    setCreatingClass(false);
  }, [invalidateGraphRequests, setSelected]);

  const handleOverviewClassSelect = (pkgName: string, className: string) => {
    setMode("graph");
    setPkg(pkgName);
    setRoot(className);
    loadGraph({
      pkg: pkgName,
      root: className,
      namespace: normalizedNamespace,
      branch: overviewBranch,
    });
  };

  const showWholeModel = () => {
    setMode("graph");
    setPkg(wholeModelPackage);
    setRoot("");
    loadGraph({
      pkg: wholeModelPackage,
      root: "",
      namespace: normalizedNamespace,
      branch: overviewBranch,
      expand: [],
    });
  };

  const ensureEditableReady = () => {
    if (addBlockedReason) {
      setQuantityActionErr(addBlockedReason);
      return null;
    }
    if (!graph) {
      setQuantityActionErr("Build a graph first to make changes.");
      return null;
    }
    return graph;
  };

  const findQuantityInUml = useCallback(
    (quantityId: string, ownerHint?: string | null): { cls: UmlClassNode; qty: QuantityNode } | null => {
      if (!umlState) return null;

      const ownerClass = ownerHint ? umlState.classes.find((c) => c.id === ownerHint) ?? null : null;
      const classes = ownerClass ? [ownerClass, ...umlState.classes.filter((c) => c.id !== ownerHint)] : umlState.classes;

      for (const cls of classes) {
        const qty = cls.quantities.find((q) => q.id === quantityId);
        if (qty) return { cls, qty };
      }
      for (const cls of classes) {
        const qty = cls.quantities.find((q) => q.inherited && q.sourceId === quantityId);
        if (qty) return { cls, qty };
      }
      return null;
    },
    [umlState]
  );

  const editClassDoc = async (classId: string, updates: { docstring: string }) => {
    const current = ensureEditableReady();
    if (!current) return;

    const target = current.nodes.find((n) => n.id === classId && n.kind === "section");
    if (!target) {
      setQuantityActionErr("Class not found in current graph.");
      return;
    }

    const targetClass = umlState?.classes.find((c) => c.id === classId);
    const before: UmlClassNode = targetClass ?? {
      id: target.id,
      name: target.label,
      doc: target.doc ?? null,
      module: target.module ?? current.package,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      quantities: [],
      parentId: null,
      parentRelation: null,
      parentCard: null,
    };
    const after: UmlClassNode = {
      ...before,
      doc: updates.docstring,
    };

    const uiIsCurrent = beginEditUiOperation();
    let updated: ApiGraph;
    try {
      updated = await submitEdits([
        { op: "set_description", target: classId, payload: { description: updates.docstring } },
      ]);
    } catch (e: unknown) {
      const message = formatApiError(e);
      if (uiIsCurrent()) setQuantityActionErr(message);
      throw new Error(message);
    }

    if (uiIsCurrent()) setQuantityActionErr(null);
    appendAudit(
      { type: "edit-class", before, after },
      `Edited class ${before.name} docstring`,
      editIdsOf(updated),
      updated.package
    );

    if (selected?.kind === "class" && selected.id === classId) {
      if (uiIsCurrent()) setSelected({
        ...selected,
        doc: updates.docstring || "",
      });
    }
  };

  const renameClassOnCanvas = async (classId: string, name: string): Promise<string> => {
    if (!ensureEditableReady()) throw new Error(addBlockedReason || "Enable editing first.");
    const before = umlState?.classes.find(c => c.id === classId);
    if (!before) throw new Error("Class not found.");
    const uiIsCurrent = beginEditUiOperation();
    const updated = await submitEdits([{ op: "rename_class", target: classId, payload: { new_name: name } }]);
    const newId = before.module ? `${before.module}.${name}` : name;
    const after = buildUmlStateFromGraph(updated)?.classes.find(c => c.id === newId);
    if (after) appendAudit({ type: "edit-class", before, after }, `Renamed class ${before.name} to ${name}`, editIdsOf(updated), updated.package);
    if (uiIsCurrent()) setSelectedClassId(newId);
    if (uiIsCurrent()) setSelectedQuantityId(null);
    if (uiIsCurrent()) setQuantityActionErr(null);
    return newId;
  };

  // The quantity the user picked, if it can be edited: not inherited, with an owner.
  const editableQuantity = (current: ApiGraph, quantityId: string, verb: string): ApiNode | null => {
    const ownerHint = selected?.kind === "quantity" ? selected.owner : selectedClassId;
    const umlQuantity = findQuantityInUml(quantityId, ownerHint);
    if (umlQuantity?.qty.inherited) {
      const inheritedFrom = umlQuantity.qty.inheritedFromName || umlQuantity.qty.inheritedFromId || "a parent class";
      setQuantityActionErr(
        `Quantity '${umlQuantity.qty.name}' is inherited from ${inheritedFrom} and cannot be ${verb} on ${umlQuantity.cls.name}.`
      );
      return null;
    }
    const target = current.nodes.find((n) => n.id === quantityId && n.kind === "quantity");
    if (!target) {
      setQuantityActionErr("Quantity not found in current graph.");
      return null;
    }
    if (!target.owner) {
      setQuantityActionErr(`Cannot ${verb === "edited" ? "edit" : "remove"} a quantity without an owner.`);
      return null;
    }
    return target;
  };

  const quantitySnapshot = (node: ApiNode): QuantityNode => ({
    id: node.id,
    name: node.label,
    dtype: node.dtype ?? node.data_type ?? node.type ?? undefined,
    shape: node.shape ?? null,
    card: node.card ?? null,
    doc: node.doc ?? null,
    path: node.path ?? null,
    line: typeof node.line === "number" ? node.line : null,
    ownerId: node.owner ?? "",
  });

  const editQuantity = async (quantityId: string, updates: QuantityFormData) => {
    const current = ensureEditableReady();
    if (!current) return false;
    const target = editableQuantity(current, quantityId, "edited");
    if (!target?.owner) return false;

    const trimmedName = updates.quantityName.trim();
    if (!trimmedName) {
      setQuantityActionErr("Quantity name cannot be empty.");
      return false;
    }
    const owner = target.owner;
    const description = updates.docstring.trim();
    const docChanged = (target.doc ?? null) !== description;
    const edits: EditRequest[] = [];
    if (target.dtype === VOCAB_TERM) {
      const code = target.details?.code;
      if (!code) {
        setQuantityActionErr("This term has no code to edit it by.");
        return false;
      }
      if (trimmedName !== target.label) {
        setQuantityActionErr("A vocabulary term is named by its code; remove it and add a new term instead.");
        return false;
      }
      if (docChanged) edits.push({ op: "set_description", target: owner, payload: { value: code, description } });
    } else {
      const attribute = target.label;
      const currentDtype = dtypeNameFor(editRules, target.dtype);
      const rangeChanged = editRules.codes && Boolean(updates.range) && updates.range !== undefined;
      if (updates.dtype && (updates.dtype !== currentDtype || rangeChanged)) {
        edits.push({
          op: "set_range",
          target: owner,
          payload: editRules.codes
            ? { attribute, data_type: updates.dtype, range: updates.range || undefined }
            : { attribute, dtype: updates.dtype },
        });
      }
      if (editRules.codes && typeof updates.mandatory === "boolean" && updates.mandatory !== Boolean(target.details?.mandatory)) {
        edits.push({ op: "set_required", target: owner, payload: { attribute, required: updates.mandatory } });
      }
      if (docChanged) edits.push({ op: "set_description", target: owner, payload: { attribute, description } });
      if (trimmedName !== attribute) {
        edits.push({ op: "rename_attribute", target: owner, payload: { attribute, new_name: trimmedName } });
      }
    }
    if (!edits.length) {
      setQuantityActionErr(null);
      return true;
    }

    const uiIsCurrent = beginEditUiOperation();
    let updated: ApiGraph;
    try {
      updated = await submitEdits(edits);
    } catch (e: unknown) {
      if (uiIsCurrent()) setQuantityActionErr(formatApiError(e));
      return false;
    }
    if (uiIsCurrent()) setQuantityActionErr(null);
    const newId = `${owner}.${target.dtype === VOCAB_TERM ? target.label : trimmedName}`;
    const before = quantitySnapshot(target);
    const afterNode = updated.nodes.find((n) => n.id === newId);
    const after: QuantityNode = afterNode ? quantitySnapshot(afterNode) : { ...before, id: newId, name: trimmedName, doc: description };
    appendAudit(
      { type: "edit-quantity", classId: owner, before, after },
      `Edited quantity ${before.name} on ${owner}`,
      editIdsOf(updated),
      updated.package
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      if (uiIsCurrent()) setSelectedQuantityId(newId);
    }
    return true;
  };

  const removeQuantity = async (quantityId: string) => {
    const current = ensureEditableReady();
    if (!current) return;
    const target = editableQuantity(current, quantityId, "removed");
    if (!target?.owner) return;

    let edit: EditRequest;
    if (target.dtype === VOCAB_TERM) {
      if (!target.details?.code) {
        setQuantityActionErr("This term has no code to remove it by.");
        return;
      }
      edit = { op: "remove_enum_value", target: target.owner, payload: { value: target.details.code } };
    } else {
      edit = { op: "remove_attribute", target: target.owner, payload: { attribute: target.label } };
    }
    const uiIsCurrent = beginEditUiOperation();
    let updated: ApiGraph;
    try {
      updated = await submitEdits([edit]);
    } catch (e: unknown) {
      if (uiIsCurrent()) setQuantityActionErr(formatApiError(e));
      return;
    }
    if (uiIsCurrent()) setQuantityActionErr(null);
    const removed = quantitySnapshot(target);
    appendAudit(
      { type: "remove-quantity", classId: target.owner, quantity: removed },
      `Removed quantity ${removed.name} from ${target.owner}`,
      editIdsOf(updated),
      updated.package
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      if (uiIsCurrent()) setSelectedQuantityId(null);
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

  const canExportLinkml = currentSchemaProfile?.linkml_export ?? true;
  const profileCapabilities = currentSchemaProfile?.capabilities;
  const showUsage = !profileCapabilities || profileCapabilities.includes("usage");
  const showMethods = !profileCapabilities || profileCapabilities.includes("methods");
  // Class methods are listed under the hood, not on the canvas cards.
  const selectedMethods = showMethods && selected?.kind === "class"
    ? graph?.nodes.find((n) => n.kind === "section" && n.id === selected.id)?.methods ?? []
    : [];

  const exportLinkml = async () => {
    if (!currentGraph?.package) return;
    setLinkmlStatus("Preparing LinkML export...");
    try {
      const res = await api.get("/schema/linkml", {
        params: { package: currentGraph.package, branch: undefined },
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentGraph.package}.linkml.yaml`;
      a.click();
      URL.revokeObjectURL(url);
      setLinkmlStatus(null);
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      const data = axios.isAxiosError(error) ? error.response?.data : null;
      if (data instanceof Blob) {
        try {
          const parsed = JSON.parse(await data.text());
          if (typeof parsed?.detail === "string") detail = parsed.detail;
        } catch {
          // keep the generic message
        }
      }
      setLinkmlStatus(`LinkML export failed: ${detail}`);
    }
  };

  const handleImportJson = () => {
    setImportStatus(null);
    importFileRef.current?.click();
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    type ImportGraphShape = {
      package?: unknown;
      root?: unknown;
      nodes: unknown[];
      edges: unknown[];
    };

    const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    const hasGraphShape = (value: unknown): value is ImportGraphShape =>
      isObjectRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);

    const extractGraphCandidate = (raw: unknown): Record<string, unknown> => {
      if (Array.isArray(raw)) {
        const looksLikeAuditLog = raw.every(
          (entry) => isObjectRecord(entry) && "change" in entry && "timestamp" in entry
        );
        if (looksLikeAuditLog) {
          throw new Error("This file is an audit log. Import expects a graph export JSON.");
        }
        throw new Error("Expected a graph object, received a JSON array.");
      }
      if (!isObjectRecord(raw)) {
        throw new Error("File is empty or invalid JSON.");
      }
      if (hasGraphShape(raw)) return raw;
      if (hasGraphShape(raw.schema)) return raw.schema;
      if (hasGraphShape(raw.graph)) return raw.graph;
      if (isObjectRecord(raw.head) && hasGraphShape(raw.head.graph)) return raw.head.graph;
      throw new Error("Expected nodes[] and edges[] in the workspace file.");
    };

    const request = graphRequestRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (request !== graphRequestRef.current) return;
        const raw = JSON.parse(String(reader.result ?? "{}"));
        const candidate = extractGraphCandidate(raw);
        const nextGraph = ensureImportedGraph({
          ...candidate,
          package: typeof candidate.package === "string" ? candidate.package : pkg,
        });
        setMode("graph");

        invalidateGraphRequests();
        canvasIdentityRef.current = {
          package: nextGraph.package, root: nextGraph.root ?? "", namespace: normalizedNamespace,
          branch: workspaceBranch ?? "", empty: startEmpty && nextGraph.package === scratchPackage,
        };
        setGraph(nextGraph);
        setBaseGraph(nextGraph);
        setCanvasKey((key) => key + 1);
        archiveAuditTrail();
        setSelectedClassId(null);
        setSelectedQuantityId(null);
        setSelected(null);
        if (nextGraph.package) setPkg(nextGraph.package);
        setRoot(nextGraph.root ?? "");
        setImportStatus(`Imported ${file.name}`);
        setErr(null);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Invalid workspace file.";
        setImportStatus(`Import failed: ${message}`);
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

  const exportPdf = async () => {
    if (!currentGraph || !graphHandle) return;

    let png: string | null;
    try { png = await graphHandle.toPng(); }
    catch (error) { setErr(`PDF export failed: ${formatApiError(error)}`); return; }
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
      className={`app-shell responsive-studio canvas-studio ${workspaceExpanded ? "workspace-expanded" : "workspace-collapsed"} ${mobilePanel ? `mobile-${mobilePanel}-open` : ""}`}
      ref={appShellRef}
      style={{ gridTemplateColumns: `${workspaceExpanded ? sidebarWidth + 72 : 72}px ${workspaceExpanded ? 10 : 0}px minmax(0, 1fr)` }}
    >
      <nav className="workbench-rail" aria-label="Studio navigation">
        <button className="rail-brand" type="button" onClick={returnToHome} title="Schema home" aria-label="Schema home"><WorkbenchIcon name="schema" /></button>
        <span className="rail-divider" />
        <button type="button" aria-label="Toggle workspace settings" title="Workspace settings" aria-expanded={workspaceExpanded && leftPanel === "workspace"} aria-controls="mobile-workspace" onClick={() => { setLeftPanel("workspace"); setWorkspaceExpanded(v => leftPanel !== "workspace" || !v); }}><WorkbenchIcon name="controls" /><span>Setup</span></button>
        <button type="button" aria-label="Show edit history" title="Edit history" aria-expanded={workspaceExpanded && leftPanel === "history"} onClick={() => focusAndOpen("audit")}><WorkbenchIcon name="history" /><span>History</span></button>
        <button className="rail-theme" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Switch appearance" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><WorkbenchIcon name="theme" /><span>Theme</span></button>
      </nav>
      {<header className="mobile-bar">
        <button type="button" aria-label="Open workspace" aria-expanded={mobilePanel === "workspace"} aria-controls="mobile-workspace" onClick={() => setMobilePanel("workspace")}>☰</button>
        <strong>SchemaStudio</strong>
        {graph && mode !== "overview" && <button type="button" aria-expanded={mobilePanel === "tools"} aria-controls="mobile-tools" onClick={() => setMobilePanel("tools")}>Tools</button>}
        <button type="button" aria-expanded={mobilePanel === "details"} aria-controls="mobile-details" onClick={() => { setMobilePanel("details"); }}>Details</button>
      </header>}
      {isMobile && mobilePanel && <button className="mobile-backdrop" type="button" aria-label="Close panel" tabIndex={-1} onClick={() => setMobilePanel(null)} />}
      <aside id="mobile-workspace" className="sidebar" inert={!isMobile && !workspaceExpanded} data-mobile-panel="workspace" role={isMobile && mobilePanel === "workspace" ? "dialog" : undefined} aria-modal={isMobile && mobilePanel === "workspace" || undefined} aria-label="Workspace" tabIndex={-1}>
        <header className="tool-panel-header">
          <h2>{leftPanel === "workspace" ? "Workspace" : "History"}</h2>
          <button type="button" className="mobile-theme" aria-label="Switch appearance" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><WorkbenchIcon name="theme" /></button>
          <button type="button" className="panel-close" aria-label="Close workspace" onClick={() => { setWorkspaceExpanded(false); setMobilePanel(null); }}>×</button>
        </header>
        <div className="panel-switcher" role="group" aria-label="Workspace panels">
          <button type="button" aria-pressed={leftPanel === "workspace"} onClick={() => setLeftPanel("workspace")}>Workspace</button>
          <button type="button" aria-pressed={leftPanel === "history"} onClick={() => setLeftPanel("history")}>History</button>
        </div>
        <section className="tool-panel-body" id="section-workspace" hidden={leftPanel !== "workspace"}>
          <h3 className="panel-section-label">Diagram options</h3>
          <div className="action-stack">
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
                  checked={showBaseSections}
                  onChange={(e) => setShowBaseSections(e.target.checked)}
                />
                Show base sections
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
              <button className="btn" onClick={() => loadGraph()} disabled={!startEmpty && !selectedSchemaReady}>
                Build graph
              </button>
              <ActionMenu label="Import / export">
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
                    {canExportLinkml ? (
                      <button
                        className="btn secondary"
                        onClick={exportLinkml}
                        disabled={!currentGraph.package}
                        title="Download the schema of this module as LinkML YAML"
                      >
                        Export LinkML
                      </button>
                    ) : null}
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
              </ActionMenu>
              {linkmlStatus ? (
                <div className="small" style={{ color: linkmlStatus.startsWith("LinkML export failed") ? "var(--danger)" : "var(--muted)", textAlign: "right" }}>
                  {linkmlStatus}
                </div>
              ) : null}
              {importStatus ? (
                <div className="small" style={{ color: importStatus.startsWith("Import failed") ? "var(--danger)" : "var(--muted)", textAlign: "right" }}>
                  {importStatus}
                </div>
              ) : null}
            </div>
            {schemaSelectionRequired ? (
              <div className="small" style={{ color: "var(--muted)" }}>
                Select a schema family above before building a graph.
              </div>
            ) : null}

            {err ? (
              <p style={{ color: "var(--danger)", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
            ) : null}
          </div>
        </section>
        <section className="tool-panel-body" id="section-audit" hidden={leftPanel !== "history"}>
          <h3 className="panel-section-label">Edit history</h3>
            {(
              <Suspense fallback={null}>
                <StaticSitePanel
                  onEditsChanged={() => void loadGraph({ keepView: true })}
                  onBackupRestored={() => {
                    // Replacement may reuse IDs for unrelated edits in any schema.
                    // Clear rather than archive: archived entries can be reactivated.
                    setAuditTrail([]);
                    void loadGraph({ keepView: true });
                  }}
                />
              </Suspense>
            )}

          <div className="action-stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn secondary"
                type="button"
                onClick={restoreAllArchivedToCurrent}
                disabled={archivedAuditCount === 0}
                title="Reactivate archived edits on this canvas"
              >
                Restore archived
              </button>
              <ActionMenu label="History actions">
              <button
                className="danger-action"
                type="button"
                onClick={clearAuditTrail}
                disabled={Boolean(pendingMutations[currentPackageForAudit || pkg]) || (!auditTrail.length && !(graph?.applied_edits?.length) && !(graph?.edit_conflicts?.length))}
              >
                Clear
              </button>
              </ActionMenu>
            </div>
            {graph?.edit_conflicts?.length ? (
              <div className="small" role="status" style={{ color: "var(--pill-warning-fg)" }}>
                <div>
                  {graph.edit_conflicts.filter((c) => !c.applied).length} stored edit(s) could not be applied,{" "}
                  {graph.edit_conflicts.filter((c) => c.applied).length} applied over a change in the schema source:
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                  {graph.edit_conflicts.map((conflict, index) => (
                    <li key={`${conflict.edit.id ?? index}-${conflict.reason}`}>
                      {conflict.edit.op} {conflict.edit.target.split(".").pop()}: {conflict.detail} ({conflict.reason})
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="small" style={{ color: "var(--muted)" }}>
              {auditEntriesForCurrentPackage.length
                ? `${activeAuditCount} active edits${archivedAuditCount > 0 ? ` (${archivedAuditCount} archived)` : ""}`
                : "No edits on this canvas yet"}
            </div>
            <div
              style={{
                maxHeight: "none",
                overflowY: "auto",
                border: 0,
                padding: 0,
                background: "var(--panel)",
                fontSize: 12
              }}
            >
              {[...auditEntriesForCurrentPackage].reverse().map((entry) => {
                const archived = Boolean(
                  entry.replayable === false ||
                  (entry.package ? normalizePackageName(entry.package) !== currentPackageForAudit : false)
                );
                return (
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
                      disabled={archived}
                      title={archived ? "Archived for a different canvas; undo disabled" : "Undo this change"}
                      style={{ padding: "6px 10px" }}
                    >
                      Undo
                    </button>
                    {archived ? (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => restoreArchivedEntry(entry.id)}
                        style={{ padding: "6px 10px" }}
                        title="Reactivate this edit on the current canvas"
                      >
                        Restore
                      </button>
                    ) : null}
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {entry.description}
                        {archived ? " (archived)" : ""}
                      </div>
                      <div style={{ color: "var(--muted)" }}>
                        {new Date(entry.timestamp).toLocaleString()}
                      </div>
                      <div style={{ color: "var(--subtitle)" }}>Change: {entry.change.type}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
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
        style={{
          gridTemplateColumns: docPanelCollapsed
            ? "minmax(0, 1fr) auto"
            : `minmax(0, 1fr) 10px ${docPanelWidth}px`,
        }}
      >
        {/* Persistent help button */}
        <div className="floating-help">
          <details
            open={helpOpen}
            onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setHelpOpen(e.currentTarget.open)}
          >
            <summary aria-label="Help"><span className="help-mark" aria-hidden>?</span> Help</summary>
            <div className="help-body">
              <div className="help-close-row">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setHelpOpen(false)}
                  aria-label="Close help panel"
                >
                  ×
                </button>
              </div>
              <div className="help-grid">
                {helpSummary.map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
              <div className="help-links">
                <button className="link-button" type="button" onClick={() => focusAndOpen("workspace")}>Workspace</button>
                <button className="link-button" type="button" onClick={() => focusAndOpen("documentation")}>Documentation</button>
                <button className="link-button" type="button" onClick={() => focusAndOpen("audit")}>Audit trail</button>
                <button className="link-button" type="button" onClick={showOverview}>Overview</button>
              </div>
            </div>
          </details>
        </div>

        {/* Left: graph area */}
        <div
          className="workspace-content"
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            overflow: mode === "overview" ? "auto" : "hidden",
          }}
        >
          {graph && mode !== "overview" && <header className="canvas-heading">
            <div><span className="canvas-kicker">SCHEMA STUDIO / EXPLORER</span><h1>{selectedDatabaseLabel || graph.package || "Untitled schema"}</h1></div>
            <div className="canvas-summary"><span>{umlState?.classes.length ?? 0} classes</span><span>{umlState?.edges.length ?? 0} relationships</span></div>
          </header>}
          {mode === "overview" ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="workspace-toolbar">
                <HomeButton onClick={returnToHome} />
                {wholeModelOffered ? (
                  <button
                    className="btn"
                    type="button"
                    onClick={showWholeModel}
                    title="One diagram with every class of the data model"
                  >
                    Whole data model
                  </button>
                ) : null}
              </div>
              <OverviewGrid

                branch={overviewBranch}
                base={normalizedNamespace}

                onClassSelect={handleOverviewClassSelect}
                query={overviewQuery}
                onQueryChange={setOverviewQuery}
              />
            </div>
          ) : graph ? (
            <>
              <div style={{ position: "relative", flex: 1 }}>
                <div id="mobile-tools" className="graph-toolbar" data-mobile-panel="tools" role={isMobile && mobilePanel === "tools" ? "dialog" : undefined} aria-modal={isMobile && mobilePanel === "tools" || undefined} aria-label="Canvas tools" tabIndex={-1}>
                  <div className="mobile-panel-heading"><strong>Canvas tools</strong><button type="button" onClick={() => setMobilePanel(null)} aria-label="Close tools">✕</button></div>
                  <div className="row" style={{ gap: 6, alignSelf: "flex-start" }}>
                    <HomeButton onClick={returnToHome} />
                    {!emptyCanvasActive ? (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={showOverview}
                        title="Back to the class list of this schema"
                      >
                        {selectedDatabaseLabel ? `← ${selectedDatabaseLabel}` : "← Classes"}
                      </button>
                    ) : null}
                  </div>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => graphHandle?.refit()}
                    disabled={!graphHandle}
                    title="Fit the whole diagram into view"
                    style={{ alignSelf: "flex-start" }}
                  >
                    Fit to view
                  </button>
                  <select
                    className="select"
                    value={layoutDirection}
                    onChange={(e) => setLayoutDirection(e.target.value as LayoutDirection)}
                    aria-label="Layout direction"
                    title="Where the most general class goes; the diagram is laid out again"
                    style={{ width: "auto", alignSelf: "flex-start" }}
                  >
                    {LAYOUT_DIRECTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  {startEmpty ? (
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={resetEmptyCanvas}
                        disabled={Boolean(pendingMutations[scratchPackage])}
                        title="Clear saved custom schema edits for this empty canvas"
                        style={{ padding: "6px 10px", whiteSpace: "nowrap" }}
                      >
                        Reset canvas
                      </button>
                      {canvasStatus ? (
                        <span className="small" style={{ color: canvasStatus.startsWith("Reset failed") ? "var(--danger)" : "var(--muted)" }}>
                          {canvasStatus}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {editableMode && addBlockedReason ? (
                    <div className="small" style={{ color: "var(--muted)" }}>{addBlockedReason}</div>
                  ) : null}
                </div>
                <FlowGraphView
                  key={`flow-${canvasKey}`}
                  positionStorageKey={canvasPositionKey(schemaProfileKey || "default", graph.package, layoutDirection)}
                  mobile={isMobile}
                  onInspect={() => { if (!isMobile) { setDocPanelCollapsed(false); } }}
                  onRenameClass={renameClassOnCanvas}
                  onEditQuantity={editQuantity}
                  nodes={graph.nodes}
                  edges={graph.edges}
                  umlState={umlState}
                  baseNamespaces={namespaceFilters}
                  showBaseSections={showBaseSections}
                  pinnedClassIds={pinnedClassIds}
                  selectedClassId={selectedClassId}
                  showQuantityMetadata={showQuantityMetadata}
                  compact={wholeModelActive}
                  showInheritance={includeInheritance}
                  theme={theme}
                  layoutDirection={layoutDirection}
                  onReady={setGraphHandle}
                  layoutKey={canvasKey}
                  onLayoutReady={focusRootSection}
                  onSelectClass={handleCanvasClassSelect}
                  onCreateQuantity={createQuantityOnCanvas}
                  onCreateClass={createClassOnCanvas}
                  editRules={editRules}
                  creatingQuantityFor={creatingQuantityFor}
                  creatingClass={creatingClass}
                  onClearSelection={handleCanvasClear}
                  editableMode={editableMode && !addBlockedReason}
                  expandedClassIds={expandedClasses}
                  onToggleSubclasses={toggleSubclasses}
                />
              </div>
            </>
          ) : (
            <div className="start-page">
              <div className="start-heading">
                <p className="eyebrow">Schema Studio / Workbench</p>
                <h1 className="start-title">Pick a schema to get started</h1>
                <p className="subdued">Explore classes, inspect relationships, and edit your schema.</p>
              </div>
              <div className="start-choices">
                <div className="schema-grid">
                  {databases.map((profile) => {
                    const isSelected = selectedDatabaseKey === profile.key;
                    return (
                      <button
                        key={profile.key}
                        type="button"
                        className={`btn ${isSelected ? "" : "secondary"}`}
                        onClick={() => void openDatabase(profile.key)}
                        disabled={profile.empty}
                        style={{ justifyContent: "space-between", textAlign: "left" }}
                        title={
                          [
                            profile.empty
                              ? EMPTY_DATABASE_NOTE
                              : profile.version
                                ? `Schema as of commit ${profile.version.slice(0, 9)}`
                                : null,
                            profile.draft
                              ? `Draft schema, read from the ${profile.default_branch ?? "draft"} branch`
                              : null,
                          ].filter(Boolean).join(". ") || undefined
                        }
                      >
                        <span>
                          {profile.label}
                          {profile.draft ? <span className="draft-tag"> (draft)</span> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {databases.some((profile) => profile.empty) ? (
                  <div className="small" style={{ color: "var(--muted)" }}>
                    {databases.filter((profile) => profile.empty).map((profile) => profile.label).join(", ")}: {EMPTY_DATABASE_NOTE}
                  </div>
                ) : null}
                {currentSchemaProfile && !currentSchemaProfile.available ? (
                  <div className="small" style={{ color: "var(--danger)" }}>
                    {currentSchemaProfile.error || "This schema has no snapshot in this site build."}
                  </div>
                ) : null}
                {schemaProfileError ? (
                  <div className="small" style={{ color: "var(--danger)" }}>{schemaProfileError}</div>
                ) : null}
                <button className="btn ghost start-empty" type="button" onClick={() => toggleEmptyMode()}>
                  {emptyCanvasActive ? "Back to schema graph" : "+ Start from empty canvas"}
                </button>
              </div>
            </div>
          )}
        </div>

        {detailsHidden ? null : (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize documentation panel"
            onMouseDown={startDocResize}
          />
        )}

        {/* Right: Documentation, Under the hood; collapses to a thin rail */}
        <div
          id="mobile-details"
          className="documentation-panel"
          data-mobile-panel="details"
          role={isMobile && mobilePanel === "details" ? "dialog" : undefined}
          aria-modal={isMobile && mobilePanel === "details" || undefined}
          aria-label="Details"
          tabIndex={-1}
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            borderLeft: "1px solid var(--panel-border)",
            padding: "10px",
            gap: "10px",
            overflowY: detailsHidden ? "hidden" : "auto"
          }}
        >
          <div className="mobile-panel-heading"><strong>Inspector</strong><button type="button" onClick={() => setMobilePanel(null)} aria-label="Close details">×</button></div>
          {isMobile ? null : docPanelCollapsed ? (
            <button
              type="button"
              className="side-rail-tab"
              onClick={() => setDocPanelCollapsed(false)}
              aria-expanded={false}
              aria-controls="right-panel-sections"
              title="Open Documentation"
            >
              <span aria-hidden>«</span>
              <span>Inspector</span>
            </button>
          ) : (
            <header className="tool-panel-header">
              <h2>Inspector</h2>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setDocPanelCollapsed(true)}
                aria-expanded
                aria-controls="right-panel-sections"
                aria-label="Collapse right panel"
                title="Hide panel"
              >
                ×
              </button>
            </header>
          )}

          {/* Kept mounted while collapsed so the sections keep their state */}
          <div
            id="right-panel-sections"
            style={{ display: detailsHidden ? "none" : "flex", flexDirection: "column", gap: "10px" }}
          >
            {/* TOP PANEL — content-stacked like left sidebar */}
            <div
              style={{
                flex: "0 0 auto"
              }}
            >
              <section id="section-documentation">
                <DocPanel
                  editRules={editRules}
                  editableMode={editableMode}
                  onRemoveQuantity={removeQuantity}
                  onEditQuantity={async (id, data) => { await editQuantity(id, data); }}
                  onEditClass={editClassDoc}
                  blockedReason={addBlockedReason}
                  actionError={quantityActionErr}
                  clearActionError={clearQuantityActionError}
                />
              </section>
            </div>

            {showUsage ? (
              <div style={{ flex: "0 0 auto" }}>
                <CollapsibleSection
                  title="Under the hood"
                  hint="Raw schema structure"
                  className="panel"
                  id="section-under"
                  open={openUnderTheHood}
                  onToggle={setOpenUnderTheHood}
                >
                  <UnderTheHoodPanel   branch={undefined} methods={selectedMethods} />
                </CollapsibleSection>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

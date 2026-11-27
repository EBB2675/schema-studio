import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";
import { useGraphNavigation } from "./hooks/useGraphNavigation";
import { applyForwardChange } from "./utils/auditReplay";
import { useAuditTrail } from "./hooks/useAuditTrail";
import { getBrowserEditStore } from "./static/editStore";
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
  VOCAB_TERM,
  dtypeNameFor,
  subsectionName,
  type QuantityFormData,
} from "./components/quantityShared";
import CollapsibleSection from "./components/CollapsibleSection";
import HomeButton from "./components/HomeButton";
import ActionMenu from "./components/ActionMenu";
import WorkbenchIcon from "./components/WorkbenchIcon";
import "./workbench.css";
import { useSelection } from "./store/selection";
import type { AuditTrailEntry, QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";
import {
  ensureGraphResponse,
  ensureImportedGraph,
  type ApiGraph,
  type ApiNode,
  type AppliedEdit
} from "./types/api";
import { fqidFromParts, normalizeId, normalizeLabel, normalizePackageName } from "./utils/identifier";
import { formatApiError } from "./utils/errors";
import { describeSavedEdit, packagesListingAppliedEdits, unlistedAppliedEdits } from "./utils/savedEdits";
import { buildUmlStateFromGraph } from "./utils/umlState";
import { initialTheme } from "./utils/theme";
import { canvasPositionKey } from "./utils/canvasPositions";
import { initialLayoutDirection, LAYOUT_DIRECTION_STORAGE_KEY, LAYOUT_DIRECTIONS, type LayoutDirection } from "./utils/layoutDirection";

// Loaded on demand when the static site information panel is opened.
const StaticSitePanel = lazy(() => import("./components/StaticSitePanel"));

const EMPTY_DATABASE_NOTE = "not released on the tracked branch yet";

export default function App() {
  const [err, setErr] = useState<string | null>(null);
  const workspaceNavigation = useWorkspaceNavigation(setErr);
  const {
    workspace, api, workspaceBranch, pkg, startEmpty, setPkg, setStartEmpty, root, setRoot,
    normalizedNamespace, namespaceFilters, scratchPackage, wholeModelActive,
    schemaProfileKey, schemaProfileError, currentSchemaProfile, editRules,
    schemaSelectionRequired, selectedSchemaReady, databases, selectedDatabaseKey,
    wholeModelOffered, selectedDatabaseLabel, overviewBranch,
    syncWorkspaceFromResponse,
  } = workspaceNavigation;

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [includeInheritance, setIncludeInheritance] = useState<boolean>(true);
  const [showBaseSections, setShowBaseSections] = useState<boolean>(false);
  const [showQuantityMetadata, setShowQuantityMetadata] = useState<boolean>(false);

  const [crossModules, setCrossModules] = useState<boolean>(true);

  const [auditTrail, setAuditTrail] = useAuditTrail();

  const [quantityActionErr, setQuantityActionErr] = useState<string | null>(null);
  // Failures of History actions (Undo, Clear), shown in the History panel: unlike the class
  // panel's action error, they must stay visible when nothing is selected.
  const [historyActionErr, setHistoryActionErr] = useState<string | null>(null);
  const [creatingQuantityFor, setCreatingQuantityFor] = useState<string | null>(null);
  const [creatingClass, setCreatingClass] = useState<boolean>(false);

  const clearQuantityActionError = useCallback(() => setQuantityActionErr(null), []);

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
    []
  );

  const replayGraphWithAudit = useCallback(
    (snapshotGraph: ApiGraph, extraChange?: AuditTrailEntry["change"]): ApiGraph => {
      const targetPackage = normalizePackageName(snapshotGraph.package) || normalizePackageName(pkg);
      // Stored edits are already in the snapshot graph; only local changes are replayed.
      const scopedEntries = filterActiveAuditForPackage(auditTrail, targetPackage).filter((a) => !a.editIds?.length);
      const changes = scopedEntries.map((a) => a.change).filter(Boolean) as AuditTrailEntry["change"][];
      const allChanges = extraChange ? [...changes, extraChange] : changes;
      return allChanges.reduce((acc, change) => applyForwardChange(acc, change), snapshotGraph);
    },
    [auditTrail, filterActiveAuditForPackage, pkg]
  );

  const onCanvasContextChange = useCallback(() => {
    setCreatingQuantityFor(null);
    setCreatingClass(false);
  }, []);
  const {
    graph, setGraph, baseGraph, setBaseGraph, canvasKey, setCanvasKey, canvasStatus, setCanvasStatus,
    expandedClasses, canvasSession, invalidateGraphRequests,
    loadGraph, latestLoadGraph, toggleSubclasses, getExpansionIntent, commitMutationGraph,
    mode, setMode, overviewQuery, setOverviewQuery, showOverview, openDatabase,
    handleOverviewClassSelect, showWholeModel, closeCanvas,
  } = useGraphNavigation({
    workspace: workspaceNavigation,
    filters: { includeQuantities, includeSubsections, includeInheritance, crossModules },
    auditTrail, setAuditTrail, replayGraphWithAudit, setErr,
    onContextChange: onCanvasContextChange, onLoadStart: clearQuantityActionError,
  });
  // Built from the graph in the same render, so cards and canvas never disagree.
  const umlState = useMemo<UmlGraphState | null>(() => buildUmlStateFromGraph(graph), [graph]);

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
    const contextIsCurrent = canvasSession.captureContext();
    const operation = ++editUiOperationRef.current;
    return () => contextIsCurrent() && operation === editUiOperationRef.current;
  };
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedQuantityId, setSelectedQuantityId] = useState<string | null>(null);
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
  const [packagesExpanded, setPackagesExpanded] = useState(() => typeof matchMedia !== "function" || !matchMedia("(max-width: 900px)").matches);
  const detailsHidden = isMobile ? mobilePanel !== "details" : docPanelCollapsed;
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [linkmlStatus, setLinkmlStatus] = useState<string | null>(null);
  // collapsible controls for accessibility / quick-open links
  const [leftPanel, setLeftPanel] = useState<"workspace" | "history">("workspace");
  const [openUnderTheHood, setOpenUnderTheHood] = useState<boolean>(false);

  const [graphHandle, setGraphHandle] = useState<GraphExportHandle | null>(null);

  const { selected, setSelected } = useSelection();

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
  useEffect(() => { setMobilePanel(null); }, [canvasKey, mode, graph?.package, setMobilePanel]);
  const emptyCanvasActive = startEmpty && graph?.package === scratchPackage && (graph?.root === "" || graph?.root === null);

  const pinnedClassIds = useMemo(
    () =>
      auditTrail
        .filter((entry) => entry.replayable !== false && entry.change?.type === "add-class")
        .map((entry) => (entry.change.type === "add-class" ? entry.change.cls.id : ""))
        .filter(Boolean),
    [auditTrail]
  );

  type StoredRefs = { editIds: string[]; editGeneration?: string };

  const archiveAuditTrail = useCallback(() => {
    setAuditTrail((prev) => prev.map((entry) => ({ ...entry, replayable: false })));
  }, [setAuditTrail]);

  const appendAudit = useCallback(
    (change: AuditTrailEntry["change"], description: string, refs?: StoredRefs, packageName?: string) => {
      const now = new Date().toISOString();
      const id = `${now}-${Math.random().toString(16).slice(2)}`;
      const pkgForEntry = packageName || graph?.package || pkg;
      const editIds = refs?.editIds;
      const currentGeneration = getBrowserEditStore().getGeneration();
      // The save finished after its log was replaced (restore, discard all): its edits are
      // gone, so an entry would point at nothing, or at unrelated edits with the same ids.
      if (editIds?.length && refs?.editGeneration && refs.editGeneration !== currentGeneration) return;
      const editGeneration = refs?.editGeneration ?? currentGeneration;
      setAuditTrail((prev) => [
        ...prev,
        { change, description, id, timestamp: now, package: pkgForEntry, replayable: true, editIds, editGeneration },
      ]);
    },
    [graph, pkg, setAuditTrail]
  );

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

  const resetEmptyCanvas = useCallback(async () => {

    const targetPkg = scratchPackage;
    // Also guard imperative callers and clicks before React renders disabled state.
    if (pendingMutationsRef.current[targetPkg]) return;
    invalidateGraphRequests({ package: targetPkg, root: "", namespace: normalizedNamespace, branch: workspaceBranch ?? "", empty: true });
    const contextIsCurrent = canvasSession.captureContext();
    // Capture only entries this deletion covers; later edits must retain their history.
    const archivedIds = new Set(auditTrail.filter(entry =>
      normalizePackageName(entry.package || graph?.package || pkg) === normalizePackageName(targetPkg)
    ).map(entry => entry.id));
    try {
      setCanvasStatus("Resetting canvas…");
      setErr(null);
      await withPendingMutation(targetPkg, () => api.delete("/schema/edits", { params: { package: targetPkg } }));
      setAuditTrail(prev => prev.map(entry => archivedIds.has(entry.id) ? { ...entry, replayable: false } : entry));
      if (!contextIsCurrent()) return;
      setGraph(null);
      setBaseGraph(null);
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      const reload = latestLoadGraph.current({ pkg: targetPkg, root: "", namespace: normalizedNamespace, branch: workspaceBranch, forceEmpty: true, expand: [], keepView: true });
      setCanvasKey(key => key + 1);
      const reloadIsCurrent = canvasSession.captureRequest();
      const loaded = await reload;
      if (contextIsCurrent() && reloadIsCurrent()) {
        const status = loaded ? "Canvas reset to empty." : "Reset failed: edits were cleared, but the canvas could not be reloaded.";
        setCanvasStatus(status);
        if (!loaded) setErr(status);
      }
    } catch (e: unknown) {
      if (!contextIsCurrent()) return;
      setCanvasStatus(`Reset failed: ${formatApiError(e)}`);
    }
  }, [canvasSession, setAuditTrail, api, auditTrail, graph?.package, invalidateGraphRequests, normalizedNamespace, pkg, scratchPackage, setSelected, withPendingMutation, workspaceBranch, latestLoadGraph, setBaseGraph, setCanvasKey, setCanvasStatus, setGraph]);

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
      canvasSession.invalidateRequests();
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
  }, [canvasSession, archiveAuditTrail, auditTrail.length, baseGraph?.package, emptyCanvasActive, graph?.package, loadGraph, normalizedNamespace, resetEmptyCanvas, scratchPackage, setPkg, setSelected, setStartEmpty, setBaseGraph, setCanvasKey, setCanvasStatus, setGraph, setRoot, setMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writePreference("schema-uml-theme", theme);
  }, [theme]);

  useEffect(() => {
    writePreference(LAYOUT_DIRECTION_STORAGE_KEY, layoutDirection);
  }, [layoutDirection]);

  useEffect(() => {
    if (!auditTrail.length && graph) {
      setBaseGraph(graph);
    }
  }, [auditTrail.length, graph, setBaseGraph]);

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

  // The stored edits a save response made, and the edit-log generation they belong to.
  const storedRefs = (updated: ApiGraph): StoredRefs => ({
    editIds: (updated.persisted_edits ?? []).map((edit) => edit.id).filter((id): id is string => Boolean(id)),
    editGeneration: updated.edit_generation,
  });

  // Store edits on the browser backend (all or none) and show the graph it rebuilds from the edited schema.
  const submitEdits = async (edits: EditRequest[]): Promise<ApiGraph> => {
    const targetPackage = graph?.package || pkg;
    // A failed save leaves pending reads and expansion intent intact. Only success
    // supersedes pre-mutation reads; navigation is tracked independently.
    const expand = getExpansionIntent();
    const contextIsCurrent = canvasSession.captureContext();
    const requestIsCurrent = canvasSession.captureRequest();
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
    // The log was replaced (restore, discard all, possibly in another tab) after this save
    // committed: its edits and ids are gone or now name unrelated edits. Show nothing from it,
    // refresh from the current log, and stop the caller's own updates (selection, History).
    if (updated.edit_generation && updated.edit_generation !== getBrowserEditStore().getGeneration()) {
      if (contextIsCurrent()) void reloadAfterEditsRemoved(shownAppliedEdits());
      throw new Error("This edit was not kept: the saved edits were replaced (backup restored or all edits discarded) while it was being saved.");
    }
    if (!contextIsCurrent()) return updated;
    // A renamed root follows its class even when the graph needs reconciliation.
    if ((updated.root ?? "") !== (root ?? "")) setRoot(updated.root ?? "");
    canvasSession.updateRoot(updated.root ?? "");
    if (!requestIsCurrent()) {
      // A refresh may have read before persistence. Re-read after the mutation,
      // retaining the user's latest expansion/filter choices in this canvas.
      void latestLoadGraph.current({ keepView: true, root: updated.root ?? "", expand: getExpansionIntent() });
      return updated;
    }
    syncWorkspaceFromResponse(res.data);
    commitMutationGraph(updated, replayGraphWithAudit(updated), expand);
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
    const contextIsCurrent = canvasSession.captureContext();
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
        storedRefs(updated),
        updated.package
      );
      if (uiIsCurrent()) setSelectedClassId(classId);
      if (uiIsCurrent()) setSelectedQuantityId(addedId);
    } catch (e: unknown) {
      const message = formatApiError(e);
      if (uiIsCurrent()) setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      if (contextIsCurrent() && creation === quantityCreationRef.current) setCreatingQuantityFor(null);
    }
  };

  const createClassOnCanvas = async ({ name, parentId, docstring, relation, card }: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection"; card?: string }) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }

    const uiIsCurrent = beginEditUiOperation();
    const contextIsCurrent = canvasSession.captureContext();
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
        storedRefs(next),
        next.package
      );
      if (uiIsCurrent()) setSelectedClassId(newCls.id);
      if (uiIsCurrent()) setSelectedQuantityId(null);
    } catch (e: unknown) {
      const message = formatApiError(e);
      if (uiIsCurrent()) setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      if (contextIsCurrent() && creation === classCreationRef.current) setCreatingClass(false);
    }
  };

  const rebuildGraphWithAudit = useCallback(
    (entries: AuditTrailEntry[]) => {
      const baseline = baseGraph ?? graph;
      if (!baseline) return;
      const targetPackage = normalizePackageName(baseline.package || pkg);
      const applicable = filterActiveAuditForPackage(entries, targetPackage).filter((a) => !a.editIds?.length);
      const rebuilt = applicable.reduce((acc, curr) => applyForwardChange(acc, curr.change), baseline);
      setGraph(rebuilt);
    },
    [baseGraph, filterActiveAuditForPackage, graph, pkg, setGraph]
  );

  // Deletes the stored edits of audit entries (and a module's own edits) in one request: all or none.
  const deleteStoredEdits = useCallback(
    // With `generation`, the store deletes nothing unless its log is still that generation.
    async (ids: string[], packageName?: string, generation?: string) => {
      await withPendingMutation(packageName || graph?.package || pkg, () => api.delete("/schema/edits", {
        params: { package: packageName },
        data: generation ? { ids, generation } : { ids },
      }));
    },
    [api, graph?.package, pkg, withPendingMutation]
  );

  // Best effort: in an error path the store may be unreadable for the same reason the
  // request failed, and that must not hide the original error.
  const readEditGeneration = (): string | undefined => {
    try {
      return getBrowserEditStore().getGeneration();
    } catch {
      return undefined;
    }
  };
  // Shows the current schema after stored edits were removed or replaced. The open root may
  // have been added or renamed by those edits: follow a removed rename back to the earlier
  // name, keep the root if the package still has it, else open the package's first root (as
  // loadRoots does). The root is passed explicitly: setRoot only applies on the next render.
  const reloadAfterEditsRemoved = async (removed: AppliedEdit[] = []) => {
    let nextRoot = root;
    if (root && !startEmpty) {
      for (const edit of [...removed].reverse()) {
        if (edit.op === "rename_class" && edit.payload?.new_name === nextRoot && edit.target) {
          nextRoot = edit.target.split(".").pop() || nextRoot;
        }
      }
      try {
        const response = await api.get("/roots", { params: { package: graph?.package || pkg, branch: undefined } });
        const sections: unknown = response.data?.sections;
        if (Array.isArray(sections) && !sections.includes(nextRoot)) nextRoot = String(sections[0] ?? "");
      } catch {
        // Keep the root; the graph load reports what is wrong.
      }
    }
    if (nextRoot === root) {
      await latestLoadGraph.current({ keepView: true });
      return;
    }
    // The same canvas following its class, as a save that renames the root does.
    setRoot(nextRoot);
    canvasSession.updateRoot(nextRoot);
    await latestLoadGraph.current({ root: nextRoot });
  };
  // Every applied edit of the shown graph, for when the whole log was replaced.
  const shownAppliedEdits = () => graph?.applied_edits ?? [];

  // History entries of a replaced log can never be undone or cleared by id.
  const dropReplacedHistory = (generation: string) =>
    setAuditTrail(prev => prev.filter(item => !item.editIds?.length || item.editGeneration === generation));

  const undoAuditEntry = async (id: string) => {
    const entry = auditTrail.find((a) => a.id === id);
    if (!entry || !entry.change) return;
    setHistoryActionErr(null);
    const contextIsCurrent = canvasSession.captureContext();

    if (entry.editIds?.length) {
      try {
        await deleteStoredEdits(entry.editIds, undefined, entry.editGeneration);
      } catch (e: unknown) {
        // Nothing was deleted. If the log was replaced, entries of the old one can never be
        // undone: drop them and show the current edits. Otherwise (or if the generation cannot
        // be read) keep the entry so the undo can be tried again. Always report why.
        const generation = readEditGeneration();
        if (generation !== undefined && entry.editGeneration && entry.editGeneration !== generation) {
          dropReplacedHistory(generation);
          if (contextIsCurrent()) await reloadAfterEditsRemoved(shownAppliedEdits());
        }
        if (contextIsCurrent()) setHistoryActionErr(`Undo failed: ${formatApiError(e)}`);
        return;
      }
      setAuditTrail(prev => prev.filter(item => item.id !== id && item.change));
      const ids = new Set(entry.editIds);
      if (contextIsCurrent()) await reloadAfterEditsRemoved(shownAppliedEdits().filter(edit => edit.id && ids.has(String(edit.id))));
      return;
    }

    const remaining = auditTrail.filter((a) => a.id !== id && a.change);
    setAuditTrail(remaining as AuditTrailEntry[]);
    rebuildGraphWithAudit(remaining as AuditTrailEntry[]);
  };

  // Undoes one applied edit that has no History entry. Only its id is sent, never the
  // package: a package scope would delete all of that package's edits.
  // Later edits that depend on it no longer apply and come back as edit conflicts.
  const undoSavedEdit = async (edit: AppliedEdit, generation?: string) => {
    const editId = String(edit.id);
    if (pendingMutationsRef.current[currentPackageForAudit || pkg]) return;
    setHistoryActionErr(null);
    const contextIsCurrent = canvasSession.captureContext();
    try {
      // The id is only valid in the log the shown graph was built from.
      await deleteStoredEdits([editId], undefined, generation);
    } catch (e: unknown) {
      if (contextIsCurrent()) {
        // The rows may be out of date (log replaced): show the current edits.
        await reloadAfterEditsRemoved(shownAppliedEdits());
        if (contextIsCurrent()) setHistoryActionErr(`Undo failed: ${formatApiError(e)}`);
      }
      return;
    }
    if (contextIsCurrent()) await reloadAfterEditsRemoved([edit]);
  };

  // Clears what the audit panel shows: this module's stored edits and the edits its entries made.
  const clearAuditTrail = async () => {
    const targetPackage = currentPackageForAudit || pkg;
    if (pendingMutationsRef.current[targetPackage]) return;
    const hasLocalAudit = auditEntriesForCurrentPackage.length > 0;
    const hasPersistedEdits = (graph?.applied_edits?.length ?? 0) > 0 || (graph?.edit_conflicts?.length ?? 0) > 0;
    if (!hasLocalAudit && !hasPersistedEdits) return;
    const contextIsCurrent = canvasSession.captureContext();
    // Clear acts on the log the shown graph was built from; the store refuses it if that log
    // was replaced since. Only ids recorded in that same log are sent: an id from another
    // generation can name an unrelated edit, even in another package.
    const generation = graph?.edit_generation ?? readEditGeneration();
    const ids = generation === undefined
      ? []
      : auditEntriesForCurrentPackage
        .filter((entry) => entry.editGeneration === generation)
        .flatMap((entry) => entry.editIds ?? []);
    setHistoryActionErr(null);
    try {
      await deleteStoredEdits(ids, targetPackage, generation);
    } catch (e: unknown) {
      const current = readEditGeneration();
      if (current !== undefined && current !== generation) {
        dropReplacedHistory(current);
        if (contextIsCurrent()) await reloadAfterEditsRemoved(shownAppliedEdits());
      }
      if (contextIsCurrent()) setHistoryActionErr(`Clear failed: ${formatApiError(e)}`);
      return;
    }
    setAuditTrail((prev) => prev.filter((entry) => !auditEntriesForCurrentPackage.includes(entry)));
    // Clear removed this package's edits and the listed ids.
    const cleared = new Set(ids);
    if (contextIsCurrent()) {
      await reloadAfterEditsRemoved(shownAppliedEdits().filter(edit =>
        (edit.id && cleared.has(String(edit.id))) || normalizePackageName(edit.package || "") === targetPackage));
    }
  };

  // If user switches away from the scratch package, exit empty mode to restore schema-backed behavior.
  useEffect(() => {
    if (startEmpty && pkg !== scratchPackage) {
      setStartEmpty(false);
      setCanvasStatus(null);
    }
  }, [pkg, scratchPackage, setStartEmpty, startEmpty, setCanvasStatus]);

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
    [auditTrail, currentPackageForAudit]
  );
  const activeAuditEntries = useMemo(
    () => filterActiveAuditForPackage(auditEntriesForCurrentPackage, currentPackageForAudit),
    [auditEntriesForCurrentPackage, currentPackageForAudit, filterActiveAuditForPackage]
  );
  const activeAuditCount = activeAuditEntries.length;
  // Applied edits with no History entry anywhere (any package): listed so none is invisible.
  const olderSavedEdits = useMemo(
    () => unlistedAppliedEdits(currentGraph?.applied_edits, auditTrail, currentGraph?.edit_generation),
    [auditTrail, currentGraph?.applied_edits, currentGraph?.edit_generation]
  );
  const listedElsewhere = useMemo(
    () => packagesListingAppliedEdits(
      currentGraph?.applied_edits, auditTrail, currentGraph?.edit_generation,
      (entryPackage) => normalizePackageName(entryPackage || "") === currentPackageForAudit,
    ),
    [auditTrail, currentGraph?.applied_edits, currentGraph?.edit_generation, currentPackageForAudit]
  );
  // A graph from the current log (e.g. after another tab restored a backup) retires History
  // entries of earlier logs: their ids now name other edits or nothing, so they would
  // miscount active edits and can never be undone. A graph from an older log than the
  // store's (a late response) changes nothing.
  const shownGeneration = currentGraph?.edit_generation;
  useEffect(() => {
    if (!shownGeneration) return;
    let current: string | undefined;
    try {
      current = getBrowserEditStore().getGeneration();
    } catch {
      return;
    }
    if (current !== shownGeneration) return;
    setAuditTrail(prev => (prev.some(entry => entry.editIds?.length && entry.editGeneration !== current)
      ? prev.filter(entry => !entry.editIds?.length || entry.editGeneration === current)
      : prev));
  }, [setAuditTrail, shownGeneration]);
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

  // After a backup restore or discarding all edits.
  // Replacement may reuse IDs for unrelated edits in any schema.
  // Clear rather than archive: archived entries can be reactivated.
  const resetAfterEditsReplaced = () => {
    // Keep only entries a save made in the new log after the replacement.
    const generation = getBrowserEditStore().getGeneration();
    setAuditTrail(prev => prev.filter(entry => entry.editIds?.length && entry.editGeneration === generation));
    void reloadAfterEditsRemoved(shownAppliedEdits());
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
    closeCanvas();
    setSelectedClassId(null);
    setSelectedQuantityId(null);
    setSelected(null);
    setCanvasStatus(null);
    setQuantityActionErr(null);
    setCreatingQuantityFor(null);
    setCreatingClass(false);
  }, [closeCanvas, setSelected, setCanvasStatus]);

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
      storedRefs(updated),
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
    if (after) appendAudit({ type: "edit-class", before, after }, `Renamed class ${before.name} to ${name}`, storedRefs(updated), updated.package);
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
      storedRefs(updated),
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
      storedRefs(updated),
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

    const requestIsCurrent = canvasSession.captureRequest();
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (!requestIsCurrent()) return;
        const raw = JSON.parse(String(reader.result ?? "{}"));
        const candidate = extractGraphCandidate(raw);
        const nextGraph = ensureImportedGraph({
          ...candidate,
          package: typeof candidate.package === "string" ? candidate.package : pkg,
        });
        setMode("graph");

        invalidateGraphRequests({
          package: nextGraph.package, root: nextGraph.root ?? "", namespace: normalizedNamespace,
          branch: workspaceBranch ?? "", empty: startEmpty && nextGraph.package === scratchPackage,
        });
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

    try {
      const png = await graphHandle.toPng();
      if (!png) return;
      const { savePngPdf } = await import("./utils/exportPdf");
      savePngPdf(png, `${currentGraph.package}_${currentGraph.root || "all"}.pdf`);
    } catch (error) {
      setErr(`PDF export failed: ${formatApiError(error)}`);
    }
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
                  onBackupRestored={resetAfterEditsReplaced}
                  onAllEditsDiscarded={resetAfterEditsReplaced}
                  discardBlocked={Object.values(pendingMutations).some(count => count > 0)}
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
            {historyActionErr ? (
              <div className="small" role="alert" style={{ color: "var(--danger)" }}>{historyActionErr}</div>
            ) : null}
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
              {auditEntriesForCurrentPackage.length || olderSavedEdits.length || listedElsewhere.count
                ? [
                    auditEntriesForCurrentPackage.length
                      ? `${activeAuditCount} active edits${archivedAuditCount > 0 ? ` (${archivedAuditCount} archived)` : ""}`
                      : null,
                    olderSavedEdits.length
                      ? `${olderSavedEdits.length} older saved edit${olderSavedEdits.length === 1 ? "" : "s"}`
                      : null,
                    listedElsewhere.count
                      ? `${listedElsewhere.count} applied edit${listedElsewhere.count === 1 ? " is" : "s are"} listed in the History of ${listedElsewhere.packages.join(", ")}`
                      : null,
                  ].filter(Boolean).join(" · ")
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
              {[...olderSavedEdits].reverse().map((edit, index) => {
                const otherPackage = edit.package && normalizePackageName(edit.package) !== currentPackageForAudit
                  ? edit.package
                  : null;
                return (
                  <div
                    key={edit.id ? `saved-${edit.id}` : `saved-unnamed-${index}`}
                    data-testid="older-saved-edit"
                    style={{ padding: "6px 8px", borderBottom: "1px solid var(--panel-border)" }}
                  >
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      {edit.id ? (
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => undoSavedEdit(edit, currentGraph?.edit_generation)}
                          disabled={Boolean(pendingMutations[currentPackageForAudit || pkg])}
                          title="Remove this saved edit"
                          style={{ padding: "6px 10px" }}
                        >
                          Undo
                        </button>
                      ) : null}
                      <div>
                        <div style={{ fontWeight: 700 }}>Older saved edit: {describeSavedEdit(edit)}</div>
                        <div style={{ color: "var(--muted)" }}>
                          {edit.created_at ? new Date(edit.created_at).toLocaleString() : "Date unknown"}
                          {otherPackage ? ` · in ${otherPackage}` : ""}
                        </div>
                        {edit.id ? null : (
                          <div style={{ color: "var(--subtitle)" }}>
                            This edit has no ID, so it cannot be undone on its own. Use &ldquo;Discard all saved edits&rdquo; above to remove it.
                          </div>
                        )}
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
            <div className="schema-graph-layout">
              {!emptyCanvasActive && <aside className={`package-sidebar${packagesExpanded ? "" : " is-collapsed"}`} aria-label="Packages">
                <button type="button" className="package-sidebar-toggle" aria-expanded={packagesExpanded} aria-controls="graph-packages" onClick={() => setPackagesExpanded(value => !value)}>
                  <span>Packages</span><span aria-hidden="true">{packagesExpanded ? "‹" : "›"}</span>
                </button>
                <div id="graph-packages" hidden={!packagesExpanded}>
                  <OverviewGrid layout="tree" activePackage={graph.package} branch={overviewBranch} base={normalizedNamespace} onClassSelect={handleOverviewClassSelect} query={overviewQuery} onQueryChange={setOverviewQuery} />
                </div>
              </aside>}
              <div className="schema-graph-canvas">
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
                  {addBlockedReason ? (
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
                  editableMode={!addBlockedReason}
                  expandedClassIds={expandedClasses}
                  onToggleSubclasses={toggleSubclasses}
                />
              </div>
            </div>
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
                  editableMode
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

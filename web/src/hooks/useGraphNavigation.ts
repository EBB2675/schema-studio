import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createCanvasSession, type CanvasIdentity } from "../utils/canvasSession";
import { ensureGraphResponse, type ApiGraph } from "../types/api";
import type { AuditTrailEntry } from "../types/uml";
import { normalizePackageName } from "../utils/identifier";
import { formatApiError } from "../utils/errors";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";

type GraphNavigationOptions = {
  workspace: WorkspaceNavigation;
  filters: { includeQuantities: boolean; includeSubsections: boolean; includeInheritance: boolean; crossModules: boolean };
  auditTrail: AuditTrailEntry[];
  setAuditTrail: Dispatch<SetStateAction<AuditTrailEntry[]>>;
  replayGraphWithAudit: (graph: ApiGraph) => ApiGraph;
  setErr: (error: string | null) => void;
  onContextChange: () => void;
  onLoadStart: () => void;
};

/** Owns graph reads and canvas freshness; edit persistence remains with the caller. */
export function useGraphNavigation({
  workspace, filters, auditTrail, setAuditTrail, replayGraphWithAudit, setErr, onContextChange, onLoadStart,
}: GraphNavigationOptions) {
  const { api, pkg, root, normalizedNamespace, workspaceBranch, startEmpty, setStartEmpty,
    syncWorkspaceFromResponse, preserveWorkspaceResponse, setPkg, setRoot,
    overviewBranch, wholeModelPackage, applySchemaProfile } = workspace;
  const { includeQuantities, includeSubsections, includeInheritance, crossModules } = filters;
  const [mode, setMode] = useState<"graph" | "overview">("graph");
  const [overviewQuery, setOverviewQuery] = useState("");
  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [baseGraph, setBaseGraph] = useState<ApiGraph | null>(null);
  // Classes whose subclasses the canvas shows; cleared when the module or root changes.
  const [expandedClasses, setExpandedClasses] = useState<string[]>([]);
  // Changes when a new graph is shown; the canvas then lays it out and fits it once.
  const [canvasKey, setCanvasKey] = useState(0);
  const [canvasSession] = useState(createCanvasSession);
  // expandedRef mirrors expandedClasses; expandIntentRef is what the latest request asked for.
  const expandedRef = useRef<string[]>([]);
  const expandIntentRef = useRef<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const invalidateGraphRequests = useCallback((identity?: CanvasIdentity | null) => {
    canvasSession.invalidate(identity);
    expandIntentRef.current = expandedRef.current;
    setLoading(false);
    onContextChange();
  }, [canvasSession, onContextChange]);

  const [canvasStatus, setCanvasStatus] = useState<string | null>(null);

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
    return preserveWorkspaceResponse(parsed, response.data);
  }, [api, crossModules, includeQuantities, includeSubsections, includeInheritance, preserveWorkspaceResponse]);

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
    const identityChanged = !canvasSession.matches(identity);
    if (identityChanged) invalidateGraphRequests(identity);
    if (!useEmpty) {
      setStartEmpty(false);
      setCanvasStatus(null);
    }
    setErr(null);
    onLoadStart();
    setLoading(true);

    const requestIsCurrent = canvasSession.beginRequest();
    const auditIds = new Set(auditTrail.filter(entry =>
      normalizePackageName(entry.package || pkg) === normalizePackageName(pkgToUse)
    ).map(entry => entry.id));
    // Another module or root starts with no class expanded.
    const expand = overrides?.expand ?? (identityChanged ? [] : expandIntentRef.current);
    try {
      const parsed = await fetchGraph({
        pkg: pkgToUse, root: rootToUse, namespace: namespaceToUse, branch: branchToUse, empty: useEmpty, expand,
      });
      if (!requestIsCurrent()) return false;
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
      if (!requestIsCurrent()) return false;
      const message = formatApiError(e);
      setErr(message || "Failed to load graph");
      setGraph(null);
      setBaseGraph(null);
      return false;
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
  }, [canvasSession, setAuditTrail, auditTrail, fetchGraph, invalidateGraphRequests, normalizedNamespace, pkg, root, setStartEmpty, startEmpty, syncWorkspaceFromResponse, workspaceBranch, onLoadStart, setErr]);

  const latestLoadGraph = useRef(loadGraph);
  useEffect(() => { latestLoadGraph.current = loadGraph; }, [loadGraph]);

  // Shows or hides a class's subclasses: the browser core rebuilds the graph with the new set of expanded
  // classes, and the canvas adds or removes only the classes that differ. A quick second click builds
  // on the first; only the answer to the latest request is shown.
  const toggleSubclasses = useCallback(
    async (classId: string) => {
      if (loading) return;
      const current = expandIntentRef.current;
      const next = current.includes(classId) ? current.filter((id) => id !== classId) : [...current, classId];
      expandIntentRef.current = next;
      const requestIsCurrent = canvasSession.beginRequest();
      setErr(null);
      try {
        const parsed = await fetchGraph({
          pkg: graph?.package || pkg, root: startEmpty ? "" : root, namespace: normalizedNamespace,
          branch: workspaceBranch ?? "", empty: startEmpty, expand: next,
        });
        if (!requestIsCurrent()) return;
        syncWorkspaceFromResponse(parsed);
        expandedRef.current = next;
        setExpandedClasses(next);
        setBaseGraph(parsed);
        setGraph(replayGraphWithAudit(parsed));
      } catch (e: unknown) {
        if (!requestIsCurrent()) return;
        expandIntentRef.current = expandedRef.current;
        setErr(formatApiError(e) || "Failed to load graph");
      }
    },
    [canvasSession, fetchGraph, graph?.package, loading, normalizedNamespace, pkg, replayGraphWithAudit, root, startEmpty, syncWorkspaceFromResponse, workspaceBranch, setErr]
  );

  useEffect(() => {
    expandedRef.current = [];
    expandIntentRef.current = [];
    setExpandedClasses([]);
  }, [pkg, root]);

  // A database button opens the bird's-eye view of that schema; a class there opens its diagram.
  const showOverview = useCallback(() => {
    invalidateGraphRequests(null);
    setMode("overview");
  }, [invalidateGraphRequests]);

  const openDatabase = useCallback(async (profileKey: string) => {
    showOverview();
    setOverviewQuery("");
    await applySchemaProfile(profileKey);
  }, [applySchemaProfile, showOverview]);

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

  const closeCanvas = useCallback(() => {
    invalidateGraphRequests(null);
    setErr(null);
    setMode("graph");
    setGraph(null);
    setBaseGraph(null);
  }, [invalidateGraphRequests, setErr]);

  const getExpansionIntent = useCallback(() => expandIntentRef.current, []);

  // Called only after a mutation's captured context/request checks succeed.
  const commitMutationGraph = useCallback((snapshot: ApiGraph, displayed: ApiGraph, expand: string[]) => {
    canvasSession.invalidateRequests();
    expandedRef.current = expand;
    expandIntentRef.current = expand;
    setExpandedClasses(expand);
    setBaseGraph(snapshot);
    setGraph(displayed);
    setLoading(false);
  }, [canvasSession]);

  return {
    graph, setGraph, baseGraph, setBaseGraph, canvasKey, setCanvasKey, canvasStatus, setCanvasStatus,
    mode, setMode, overviewQuery, setOverviewQuery, showOverview, openDatabase,
    handleOverviewClassSelect, showWholeModel, closeCanvas,
    expandedClasses, canvasSession, invalidateGraphRequests,
    loadGraph, latestLoadGraph, toggleSubclasses, getExpansionIntent, commitMutationGraph,
  };
}

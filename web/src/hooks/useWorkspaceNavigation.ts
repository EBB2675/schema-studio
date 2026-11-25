import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../client";
import { DEFAULT_BRANCH, DEFAULT_NAMESPACE, DEFAULT_ROOT, DEFAULT_PACKAGE, WORKSPACE_PRESETS } from "../constants/defaults";
import { useWorkspaceStore } from "../store/workspace";
import type { WorkspaceState } from "../types/workspace";
import { NOMAD_EDIT_RULES, parseEditRules, type EditRules } from "../components/quantityShared";
import { formatApiError } from "../utils/errors";
import { normalizePackageName } from "../utils/identifier";

type WorkspaceEnvelope = { workspace?: WorkspaceState };
// Responses carry the workspace the browser backend had when the request was handled.
// A response that was requested before the user's latest workspace change must
// not overwrite that change, however late it arrives.
const WORKSPACE_EPOCH = "__workspaceEpoch";
type EpochConfig = { workspaceEpoch?: number };

export type SchemaProfileSummary = {
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

type DatabaseButton = Pick<SchemaProfileSummary, "key" | "label" | "available" | "version" | "source" | "empty" | "draft">
  & Partial<Pick<SchemaProfileSummary, "default_branch">>;

/** Owns workspace preferences, profile discovery, and backend workspace synchronization. */
export function useWorkspaceNavigation(setErr: (error: string | null) => void) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(() => {
    // The store already restores saved preferences or supplies build defaults.
    // Reapplying defaults here would replace a saved scratch workspace on reload.
    const saved = useWorkspaceStore.getState();
    return { branch: saved.branch, package: saved.pkg, base_namespace: saved.baseNamespace };
  });

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

  const workspaceStateRef = useRef<WorkspaceState | null>(workspace);
  const workspaceEpochRef = useRef(0);
  const [schemaProfileKey, setSchemaProfileKey] = useState<string | null>(null);
  const [schemaProfileError, setSchemaProfileError] = useState<string | null>(null);
  const [schemaProfiles, setSchemaProfiles] = useState<SchemaProfileSummary[]>([]);

  const [overviewBranch, setOverviewBranch] = useState<string>(workspaceBranch || DEFAULT_BRANCH);

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

  // The schema's base namespace is no module itself; its graph is every class of the data model.
  const wholeModelPackage = basePackageForEmpty;
  const wholeModelActive = !startEmpty && pkg === wholeModelPackage;

  const inferProfileKey = useCallback((value?: string | null) => {
    const normalized = normalizePackageName(value);
    const within = (namespace: string) => normalized === namespace || normalized.startsWith(`${namespace}.`);
    // The preset whose namespace holds the package, else the first one of its top-level package.
    const preset = WORKSPACE_PRESETS.find((entry) => within(entry.namespace))
      ?? WORKSPACE_PRESETS.find((entry) => within(entry.namespace.split(".")[0]));
    return preset?.key ?? null;
  }, []);

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

  const preserveWorkspaceResponse = useCallback(<T extends object>(parsed: T, payload: unknown): T => {
    if (payload && typeof payload === "object") {
      Object.defineProperty(parsed, WORKSPACE_EPOCH, {
        value: (payload as Record<string, unknown>)[WORKSPACE_EPOCH],
      });
    }
    return parsed;
  }, []);

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
    void loadSchemaProfiles();
  }, [loadSchemaProfiles]);

  useEffect(() => {
    if (!workspace) return;
    const updates: Partial<WorkspaceState> = {};

    if (workspace.package !== pkg) updates.package = pkg;
    if (workspace.base_namespace !== normalizedNamespace) updates.base_namespace = normalizedNamespace;

    if (Object.keys(updates).length > 0) updateWorkspace(updates);
  }, [normalizedNamespace, pkg, updateWorkspace, workspace]);

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
  }, [api, pkg, root, startEmpty, syncWorkspaceFromResponse, wholeModelActive, setErr]);

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
  }, [api, normalizedNamespace, pkg, scratchPackage, setPkg, startEmpty, syncWorkspaceFromResponse, wholeModelPackage, setErr]);

  useEffect(() => {
    if (!workspace) return;

    loadSchemaProfiles();
    loadPackages();
    loadRoots();
  }, [loadPackages, loadRoots, loadSchemaProfiles, workspace]);

  useEffect(() => {
    loadRoots();
  }, [pkg, startEmpty, loadRoots]);

  useEffect(() => {

    loadPackages();
  }, [loadPackages, normalizedNamespace]);

  return {
    workspace, api, workspaceBranch, pkg, startEmpty, setPkg, setStartEmpty, root, setRoot,
    normalizedNamespace, namespaceFilters, scratchPackage, wholeModelPackage, wholeModelActive,
    schemaProfileKey, schemaProfileError, currentSchemaProfile, editRules,
    schemaSelectionRequired, selectedSchemaReady, databases, selectedDatabaseKey,
    wholeModelOffered, selectedDatabaseLabel, overviewBranch, applySchemaProfile,
    syncWorkspaceFromResponse, preserveWorkspaceResponse,
  };
}

export type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;

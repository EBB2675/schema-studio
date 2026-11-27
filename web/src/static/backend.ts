/**
 * The backend of the static site, inside the browser: it answers the requests the web app sends
 * through the browser-local client, from the site's snapshot files, the Python core and the edits stored
 * in this browser.
 *
 * Graphs for a module without edits come ready-made from the site when the build made them;
 * everything else goes to the Python core (see `pythonRunner.ts`).
 */
import type { CoreAnswer, CoreRequest } from "./pythonRunner";
import { browserStorage } from "../utils/browserStorage";
import { createEditStore, getBrowserEditStore, type EditStore, type StoredEdit } from "./editStore";
import { catalogEditKey, changesClassNames } from "./catalogEdits";

export type SiteModule = {
  package: string;
  sections: string[];
  snapshot: string;
  // Ready-made graphs without edits, with the default filters, by root ("" for none).
  graphs?: Record<string, string>;
};

export type SiteProfile = {
  key: string;
  label: string;
  default_branch: string;
  draft?: boolean;
  default_package: string;
  default_base_namespace: string;
  default_root: string;
  version: string;
  source: string;
  package_version?: string | null;
  commit?: string | null;
  capabilities: string[];
  edit_rule_set: string;
  edit_rules: Record<string, unknown>;
  snapshot: string;
  overview: { package: string; sections: string[] }[];
  modules: SiteModule[];
};

export type SiteIndex = { format: number; static: boolean; generated_at: string; profiles: SiteProfile[] };

export type StaticAnswer = { status: number; data: unknown; contentType?: string };

export const EDITS_REPLACED = "The saved edits were replaced (backup restored or all edits discarded, possibly in another tab). Nothing was deleted; the view now shows the current edits.";

export class StaticHttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export type StaticBackendOptions = {
  readJson: (path: string) => Promise<unknown>;
  runCore: (request: CoreRequest) => Promise<CoreAnswer>;
  edits?: EditStore;
  storage?: Storage | null;
  now?: () => string;
};

type Workspace = { profile: string; branch: string; package: string; base_namespace: string };
type Params = Record<string, unknown>;

export const WORKSPACE_STORAGE_KEY = "schema-studio-static-workspace";
const SCRATCH_SUFFIX = ".custom_schema";
const FLAG_NAMES = ["include_quantities", "include_subsections", "include_inheritance", "allow_cross_module"] as const;

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function text(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

/** The namespace used for a module: its first three dotted parts. */
function rootNamespace(pkg: string): string {
  return pkg.split(".").slice(0, 3).join(".");
}

function inNamespace(name: string, namespace: string): boolean {
  return name === namespace || name.startsWith(`${namespace}.`);
}

export function createStaticBackend(options: StaticBackendOptions) {
  const edits = options.edits ?? (options.storage === undefined ? getBrowserEditStore() : createEditStore(options.storage));
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? (() => new Date().toISOString());
  let site: Promise<SiteIndex> | null = null;
  let workspace: Workspace | null = null;

  const index = (): Promise<SiteIndex> => {
    site ??= options.readJson("index.json").then((value) => {
      const data = value as SiteIndex;
      if (data?.format !== 1 || !data.static || !Array.isArray(data.profiles) || data.profiles.length === 0) {
        throw new StaticHttpError(500, "The site's schema index is missing or has an unknown format.");
      }
      return data;
    });
    site.catch(() => {
      site = null;
    });
    return site;
  };

  /** The profile of a module (or the one whose namespace is given). */
  const profileFor = (data: SiteIndex, pkg?: string, namespace?: string): SiteProfile => {
    const byNamespace = namespace ? data.profiles.find(p => namespace.split(",").some(ns => inNamespace(ns.trim(), p.default_base_namespace))) : undefined;
    const byPackage = pkg ? data.profiles.find(p => inNamespace(pkg, p.default_base_namespace)) : undefined;
    return byPackage ?? byNamespace ?? data.profiles[0];
  };

  const saveWorkspace = (next: Workspace) => {
    workspace = next;
    try {
      storage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the workspace lasts for this page
    }
    return next;
  };

  const setWorkspace = (data: SiteIndex, pkg: string, namespace: string) => {
    const profile = profileFor(data, pkg, namespace);
    return saveWorkspace({ profile: profile.key, branch: profile.default_branch, package: pkg, base_namespace: namespace });
  };

  const currentWorkspace = (data: SiteIndex): Workspace => {
    if (!workspace) {
      try {
        const saved = JSON.parse(storage?.getItem(WORKSPACE_STORAGE_KEY) || "null") as Workspace | null;
        if (saved && typeof saved.package === "string" && typeof saved.base_namespace === "string") workspace = saved;
      } catch {
        // unreadable: start from the default
      }
    }
    if (!workspace || !data.profiles.some(p => inNamespace(workspace!.package, p.default_base_namespace))) {
      const first = data.profiles[0];
      return setWorkspace(data, first.default_package, first.default_base_namespace);
    }
    return workspace;
  };

  const workspacePayload = (ws: Workspace) => ({ ...ws });

  const statusPayload = (data: SiteIndex, ws: Workspace) => {
    const profile = profileFor(data, ws.package, ws.base_namespace);
    return {
      schema_profile: profile.key,
      schema_profile_label: profile.label,
      schema_ready: true,
      schema_version: profile.version,
      schema_source: "static",
      schema_error: null,
    };
  };

  const moduleOf = (profile: SiteProfile, pkg: string) => profile.modules.find(m => m.package === pkg);

  /** The snapshot file a module's answers are computed from: its own, or the profile's for the empty canvas. */
  const snapshotOf = (profile: SiteProfile, pkg: string): string | undefined =>
    pkg.endsWith(SCRATCH_SUFFIX) || pkg === profile.default_base_namespace ? profile.snapshot : moduleOf(profile, pkg)?.snapshot;

  // Packages of applied edits that this site cannot open (e.g. a module a newer snapshot
  // removed or renamed): their edits still apply, but no canvas of their own lists them.
  const withUnavailablePackages = <T extends Record<string, unknown>>(result: T, profile: SiteProfile): T => {
    const applied = Array.isArray(result.applied_edits) ? result.applied_edits as { package?: unknown }[] : [];
    const missing = [...new Set(applied.map(edit => edit.package).filter((pkg): pkg is string => typeof pkg === "string" && pkg !== ""))]
      .filter(pkg => !snapshotOf(profile, pkg)).sort();
    return missing.length ? { ...result, unavailable_packages: missing } : result;
  };

  const profileRequest = (profile: SiteProfile) => ({
    key: profile.key, default_base_namespace: profile.default_base_namespace, edit_rule_set: profile.edit_rule_set,
  });

  const core = async (request: CoreRequest): Promise<unknown> => {
    const answer = await options.runCore(request);
    if (answer.error !== undefined) throw new StaticHttpError(answer.status ?? 500, answer.error);
    return answer.ok;
  };

  // Retain only the current catalog per profile; share pending work between
  // overview/roots callers. Invalidate profile-wide because modules share classes.
  const catalogs = new Map<string, { key: string; sections: Map<string, Promise<string[]>> }>();
  const sectionsFor = (profile: SiteProfile, pkg: string, stored: StoredEdit[]): Promise<string[]> => {
    const key = JSON.stringify([edits.getGeneration(), catalogEditKey(stored)]);
    let catalog = catalogs.get(profile.key);
    if (!catalog || catalog.key !== key) {
      catalog = { key, sections: new Map() };
      catalogs.set(profile.key, catalog);
    }
    const cached = catalog.sections.get(pkg);
    if (cached) return cached;
    const module = moduleOf(profile, pkg);
    const snapshot = snapshotOf(profile, pkg);
    const result = snapshot && (stored.some(changesClassNames) || pkg.endsWith(SCRATCH_SUFFIX) || !module)
      ? core({ op: "sections", snapshots: [snapshot], snapshot, profile: profileRequest(profile), package: pkg, stored }) as Promise<string[]>
      : Promise.resolve([...(module?.sections ?? [])].sort());
    const sections = catalog.sections;
    sections.set(pkg, result);
    void result.catch(() => { if (sections.get(pkg) === result) sections.delete(pkg); });
    return result;
  };

  const graphFlags = (params: Params, root: string | undefined, namespace: string) => ({
    root: root ?? null,
    include_quantities: flag(params.include_quantities, true),
    include_subsections: flag(params.include_subsections, true),
    include_inheritance: flag(params.include_inheritance, true),
    allow_cross_module: flag(params.allow_cross_module, true),
    base_namespace: namespace,
    expand: (text(params.expand) ?? "").split(",").map(name => name.trim()).filter(Boolean),
  });

  const emptyGraph = (pkg: string, root: string | undefined) => ({ package: pkg, root: root ?? null, nodes: [], edges: [] });

  /** A module's graph: ready-made when nothing differs from the build, else from the core. */
  const graph = async (
    profile: SiteProfile, pkg: string, params: Params, namespace: string, stored: StoredEdit[],
  ): Promise<Record<string, unknown>> => {
    const root = text(params.root);
    const empty = flag(params.empty, false);
    const snapshot = snapshotOf(profile, pkg);
    if (!snapshot) return emptyGraph(pkg, root); // not a module of the site
    const flags = graphFlags(params, root, namespace);
    const plain = FLAG_NAMES.every(name => flags[name]) && flags.expand.length === 0
      && namespace === profile.default_base_namespace;
    const ready = moduleOf(profile, pkg)?.graphs?.[root ?? ""];
    if (ready && plain && !empty && stored.length === 0) {
      return { ...(await options.readJson(ready) as Record<string, unknown>), root: root ?? null };
    }
    return await core({
      op: "graph", snapshots: [snapshot], snapshot, profile: profileRequest(profile), package: pkg, stored, flags, empty,
    }) as Record<string, unknown>;
  };

  const request = async (method: string, url: string, params: Params = {}, body?: unknown): Promise<StaticAnswer> => {
    const parsed = new URL(url, "http://static.invalid");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const query: Params = { ...Object.fromEntries(parsed.searchParams), ...params };
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const data = await index();
    let ws = currentWorkspace(data);
    const ok = (value: unknown, contentType?: string): StaticAnswer => ({ status: 200, data: value, contentType });
    const route = `${method.toUpperCase()} ${path}`;

    if (route === "GET /health") {
      return ok({ ok: true, mode: "static", static: true, workspace: workspacePayload(ws), ...statusPayload(data, ws) });
    }
    if (route === "GET /workspace") {
      return ok({ workspace: workspacePayload(ws), ...statusPayload(data, ws) });
    }
    if (route === "PUT /workspace") {
      const pkg = text(query.package) ?? text(payload.package) ?? ws.package;
      const namespace = text(query.base_namespace) ?? text(payload.base_namespace) ?? ws.base_namespace;
      const branch = text(query.branch) ?? text(payload.branch);
      const profile = profileFor(data, pkg, namespace);
      if (branch && branch !== profile.default_branch) {
        throw new StaticHttpError(400, `Snapshots have fixed branches; only '${profile.default_branch}' is allowed for the selected schema profile.`);
      }
      ws = setWorkspace(data, pkg, namespace);
      return ok({ workspace: workspacePayload(ws) });
    }
    if (route === "GET /schema/profiles") {
      const current = profileFor(data, ws.package, ws.base_namespace);
      return ok({
        profiles: data.profiles.map(profile => ({
          key: profile.key,
          label: profile.label,
          default_branch: profile.default_branch,
          draft: profile.draft === true,
          default_package: profile.default_package,
          default_base_namespace: profile.default_base_namespace,
          default_root: profile.default_root,
          available: true,
          current: profile.key === current.key,
          version: profile.version,
          source: "static",
          error: null,
          linkml_export: true,
          capabilities: profile.capabilities,
          editable: true,
          edit_rules: profile.edit_rules,
          package_version: profile.package_version ?? null,
          commit: profile.commit ?? null,
          // A namespace the package does not have yet (bam-masterdata v1 before its release).
          empty: profile.modules.length === 0,
        })),
        workspace: workspacePayload(ws),
        current_profile: current.key,
        static: true,
        generated_at: data.generated_at,
      });
    }
    if (route === "GET /schema/version") {
      const profile = profileFor(data, ws.package, ws.base_namespace);
      return ok({ version: profile.version, source: "static", schema_profile: profile.key });
    }
    if (route === "GET /git/packages") {
      const base = text(query.base_package) ?? ws.base_namespace;
      const profile = profileFor(data, ws.package, base);
      const branch = text(query.branch);
      if (branch && branch !== profile.default_branch) {
        throw new StaticHttpError(400, `Snapshots have fixed branches; only '${profile.default_branch}' is allowed for the selected schema profile.`);
      }
      const packages = base === profile.default_base_namespace
        ? profile.overview.map(m => m.package).sort()
        : profile.overview.map(m => m.package).filter(name => inNamespace(name, base)).sort();
      return ok({ packages: packages.length ? packages : [ws.package], base_package: base, branch: profile.default_branch, workspace: workspacePayload(ws) });
    }
    if (route === "GET /overview") {
      const base = text(query.base) ?? ws.base_namespace;
      const bases = base.split(",").map(b => b.trim()).filter(Boolean);
      const items = (await Promise.all(bases.map(async b => {
        const profile = data.profiles.find(p => inNamespace(b, p.default_base_namespace));
        if (!profile) return [];
        const stored = edits.list(profile.key);
        return Promise.all(profile.overview
          .filter(m => inNamespace(m.package, b))
          .map(async m => ({ package: m.package, classes: stored.some(changesClassNames) ? await sectionsFor(profile, m.package, stored) : [...m.sections].sort() })));
      }))).flat();
      return ok({ branch: profileFor(data, ws.package, ws.base_namespace).default_branch, base, items, workspace: workspacePayload(ws) });
    }
    if (route === "GET /roots") {
      const pkg = text(query.package) ?? ws.package;
      const profile = profileFor(data, pkg, ws.base_namespace);
      const stored = edits.list(profile.key);
      const sections = await sectionsFor(profile, pkg, stored);
      return ok({ package: pkg, sections, workspace: workspacePayload(ws) });
    }
    if (route === "GET /schema") {
      const pkg = text(query.package) ?? ws.package;
      const namespace = text(query.base_namespace) ?? ws.base_namespace;
      const profile = profileFor(data, pkg, namespace);
      if (text(query.package) || text(query.base_namespace)) ws = setWorkspace(data, pkg, namespace);
      const { edits: stored, generation } = edits.snapshot(profile.key);
      const result = await graph(profile, pkg, query, namespace, stored);
      // The ids in applied_edits are only meaningful within this generation.
      return ok({ ...withUnavailablePackages(result as Record<string, unknown>, profile), edit_generation: generation, workspace: workspacePayload(ws) });
    }
    if (route === "GET /schema/edits") {
      const pkg = text(query.package) ?? ws.package;
      const profile = profileFor(data, pkg, ws.base_namespace);
      return ok({ package: pkg, profile: profile.key, edits: edits.list(profile.key, pkg), rules: profile.edit_rules, workspace: workspacePayload(ws) });
    }
    if (route === "POST /schema/edits") {
      const pkg = text(payload.package) ?? ws.package;
      const namespace = text(query.base_namespace) ?? (pkg === ws.package ? ws.base_namespace : undefined) ?? rootNamespace(pkg);
      const profile = profileFor(data, pkg, namespace);
      const snapshot = snapshotOf(profile, pkg);
      if (!snapshot) throw new StaticHttpError(404, `No schema module named '${pkg}' on this site.`);
      ws = setWorkspace(data, pkg, namespace);
      const requested = Array.isArray(payload.edits) ? payload.edits as Record<string, unknown>[] : [];
      return edits.transaction(async edits => {
        const stored = edits.list(profile.key);
        const result = await core({
          op: "add_edits", snapshots: [snapshot], snapshot, profile: profileRequest(profile), package: pkg, stored,
          edits: requested.map(edit => ({ op: edit.op, target: edit.target ?? "", payload: edit.payload ?? {} })),
          flags: graphFlags(query, text(query.root), namespace), empty: flag(query.empty, false),
          ids: edits.nextIds(requested.length), created_at: now(),
        }) as Record<string, unknown>;
        edits.add((result.persisted_edits as StoredEdit[]) ?? []);
        // Read under the same lock as the save: History stamps its entry with it and drops
        // the entry if the log was replaced (restore, discard all) before the response landed.
        return ok({ ...withUnavailablePackages(result, profile), edit_generation: edits.generation(), workspace: workspacePayload(ws) });
      });
    }
    if (method.toUpperCase() === "DELETE" && path.startsWith("/schema/edits/")) {
      const id = Number(path.slice("/schema/edits/".length));
      return ok({ deleted: Number.isInteger(id) ? await edits.remove([id]) : 0, workspace: workspacePayload(ws) });
    }
    if (route === "DELETE /schema/edits") {
      const pkg = text(query.package);
      const all = flag(query.all_packages, false);
      const profile = profileFor(data, pkg ?? ws.package, ws.base_namespace);
      const ids = Array.isArray(payload.ids) ? (payload.ids as unknown[]).map(Number).filter(Number.isInteger) : [];
      const expected = text(payload.generation);
      const deleted = await edits.transaction(tx => {
        // Ids name edits only within one log: after a restore or discard (here or in another
        // tab) the same id can be an unrelated edit, so never delete across generations.
        if (expected !== undefined && tx.generation() !== expected) throw new StaticHttpError(409, EDITS_REPLACED);
        return tx.remove(ids, pkg || all ? { profile: profile.key, package: pkg, allPackages: all } : undefined);
      });
      return ok({ deleted, workspace: workspacePayload(ws) });
    }
    if (route === "GET /usage") {
      const sectionId = text(query.section_id);
      if (!sectionId) throw new StaticHttpError(422, "section_id is required");
      const profile = profileFor(data, sectionId, ws.base_namespace);
      const own = profileFor(data, ws.package, ws.base_namespace);
      // The usage comes from the module's snapshot, else the profile's.
      const usageSnapshots = [own.key === profile.key ? snapshotOf(profile, ws.package) : undefined, profile.snapshot]
        .filter((p, i, all): p is string => Boolean(p) && all.indexOf(p) === i);
      const snapshot = snapshotOf(own, ws.package);
      const usage = await core({
        op: "usage", snapshots: [...new Set([...(snapshot ? [snapshot] : []), ...usageSnapshots])],
        usage_snapshots: usageSnapshots, snapshot, profile: profileRequest(own), package: ws.package,
        stored: snapshot ? edits.list(own.key) : [], section_id: sectionId,
      });
      return ok({ usage, workspace: workspacePayload(ws) });
    }
    if (route === "GET /schema/linkml") {
      const pkg = text(query.package) ?? ws.package;
      const profile = profileFor(data, pkg);
      const snapshot = snapshotOf(profile, pkg);
      if (!snapshot) throw new StaticHttpError(404, `No schema module named '${pkg}' on this site.`);
      const stored = flag(query.edits, true) ? edits.list(profile.key) : [];
      const yaml = await core({ op: "linkml_yaml", snapshots: [snapshot], snapshot, profile: profileRequest(profile), package: pkg, stored });
      return ok(String(yaml), "application/yaml");
    }
    throw new StaticHttpError(404, `Not available on the static site: ${route}`);
  };

  return { request, index, edits };
}

export type StaticBackend = ReturnType<typeof createStaticBackend>;

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:5179";
const DEFAULT_PACKAGE = import.meta.env.VITE_DEFAULT_PACKAGE ?? "nomad_simulations.schema_packages.model_method";

const authHeaders = (): Record<string, string> => {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("schema-uml-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function listBranches(): Promise<string[]> {
  const r = await fetch(`${BASE}/git/branches`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.branches as string[];
}

export type GraphPayload = {
  branch: string; sha: string;
  graph: { nodes: any[]; edges: any[] };
};

export type DiffResponse = {
  base: GraphPayload;
  head: GraphPayload;
  diff: {
    nodes: {
      added: any[];
      removed: any[];
      changed: { id: string; before: any; after: any }[];
    };
    edges: {
      added: { source: string; target: string; type?: string }[];
      removed: { source: string; target: string; type?: string }[];
    };
  };
};

export async function getDiff(base: string, head: string, pkg = DEFAULT_PACKAGE) {
  const r = await fetch(`${BASE}/graph/diff`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ base, head, package: pkg })
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as DiffResponse;
}

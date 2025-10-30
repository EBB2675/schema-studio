const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:5179";

export async function listBranches(): Promise<string[]> {
  const r = await fetch(`${BASE}/git/branches`);
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

export async function getDiff(base: string, head: string, pkg = "nomad_simulations.model_method") {
  const r = await fetch(`${BASE}/graph/diff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base, head, package: pkg })
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as DiffResponse;
}

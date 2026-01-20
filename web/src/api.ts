import { API_FEATURE_HEADER, API_VERSION, API_VERSION_HEADER, DEFAULT_FEATURE_FLAGS } from "./constants/api";
import { ensureDiffResponse, type DiffResponse } from "./types/api";

const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:5179";
const DEFAULT_PACKAGE = import.meta.env.VITE_DEFAULT_PACKAGE ?? "nomad_simulations.schema_packages.model_method";

const authHeaders = (): Record<string, string> => {
  const base: Record<string, string> = {
    [API_VERSION_HEADER]: API_VERSION,
    [API_FEATURE_HEADER]: DEFAULT_FEATURE_FLAGS.join(","),
  };
  if (typeof window === "undefined") return base;
  const token = window.localStorage.getItem("schema-uml-token");
  if (token) {
    base.Authorization = `Bearer ${token}`;
  }
  return base;
};

export async function listBranches(): Promise<string[]> {
  const r = await fetch(`${BASE}/git/branches`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.branches as string[];
}

export async function getDiff(base: string, head: string, pkg = DEFAULT_PACKAGE): Promise<DiffResponse> {
  const r = await fetch(`${BASE}/graph/diff`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ base, head, package: pkg })
  });
  if (!r.ok) throw new Error(await r.text());
  return ensureDiffResponse(await r.json());
}

export type { DiffResponse };

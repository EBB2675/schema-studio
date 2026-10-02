import { DEFAULT_PACKAGE } from "./constants/defaults";
import { ensureDiffResponse, type DiffResponse } from "./types/api";
import { apiFetch } from "./client";

export async function listBranches(): Promise<string[]> {
  const r = await apiFetch("/git/branches");
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.branches as string[];
}

export async function getDiff(base: string, head: string, pkg = DEFAULT_PACKAGE): Promise<DiffResponse> {
  const r = await apiFetch("/graph/diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base, head, package: pkg }),
  });
  if (!r.ok) throw new Error(await r.text());
  return ensureDiffResponse(await r.json());
}

export type { DiffResponse };

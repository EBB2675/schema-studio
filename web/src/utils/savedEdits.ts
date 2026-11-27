import type { AppliedEdit } from "../types/api";
import type { AuditTrailEntry } from "../types/uml";
import { belongsToPackage } from "./identifier";

/**
 * Applied edits that no History entry accounts for. History is a separate, optional
 * log (its entries can be dropped for another edit generation or failed validation),
 * so these are listed on their own as "older saved edits" to keep every applied edit
 * visible and removable. An edit without an id never matches a History entry.
 *
 * An id names an edit only within one log generation (a restore can reuse it for an
 * unrelated edit), so with `generation` (the one the graph was built from) only History
 * entries of that generation count.
 */
export function unlistedAppliedEdits(
  applied: AppliedEdit[] | undefined,
  history: AuditTrailEntry[],
  generation?: string,
): AppliedEdit[] {
  if (!applied?.length) return [];
  const sameLog = generation === undefined ? history : history.filter(entry => entry.editGeneration === generation);
  const listed = new Set(sameLog.flatMap(entry => entry.editIds ?? []));
  return applied.filter(edit => !edit.id || !listed.has(String(edit.id)));
}

const shortName = (target: string) => target.split(".").pop() || target;

/** A one-line description of a stored edit, such as "add attribute user_defined on AtomsState". */
export function describeSavedEdit(edit: AppliedEdit): string {
  const op = edit.op.replace(/_/g, " ");
  const payload = edit.payload ?? {};
  const pick = (key: string) => (typeof payload[key] === "string" && payload[key] ? String(payload[key]) : null);
  const target = edit.target ? shortName(edit.target) : "";
  if (edit.op.startsWith("rename_")) {
    const from = pick("attribute") ?? target;
    const to = pick("new_name");
    return to ? `${op} ${from} to ${to}${pick("attribute") && target ? ` on ${target}` : ""}` : `${op} ${from}`;
  }
  const name = pick("name") ?? pick("attribute") ?? pick("value");
  if (name && target) return `${op} ${name} on ${target}`;
  return `${op} ${name ?? target}`.trim();
}

/**
 * Whether a canvas of `pkg` lists an applied edit: the package's own edits, and edits of
 * packages this site cannot open (listed nowhere else). Exactly these are removed by Clear.
 */
export function listedOnCanvas(edit: AppliedEdit, pkg: string, unavailable: string[] = []): boolean {
  return belongsToPackage(edit.package, pkg) || (Boolean(edit.package) && unavailable.includes(edit.package!));
}

/** The canvas's older saved edits: listed on it, and not covered by its History rows. */
export function olderSavedEditsOf(
  graph: { applied_edits?: AppliedEdit[]; edit_generation?: string; unavailable_packages?: string[] } | null | undefined,
  pkg: string,
  canvasHistory: AuditTrailEntry[],
): AppliedEdit[] {
  const own = (graph?.applied_edits ?? []).filter(edit => listedOnCanvas(edit, pkg, graph?.unavailable_packages));
  return unlistedAppliedEdits(own, canvasHistory, graph?.edit_generation);
}

/** Applied edits of other packages the site has: they are listed on those packages' canvases. */
export function editsOfOtherPackages(
  graph: { applied_edits?: AppliedEdit[]; unavailable_packages?: string[] } | null | undefined,
  pkg: string,
): { count: number; packages: string[] } {
  const others = (graph?.applied_edits ?? []).filter(edit => !listedOnCanvas(edit, pkg, graph?.unavailable_packages));
  return { count: others.length, packages: [...new Set(others.map(edit => edit.package!))].sort() };
}

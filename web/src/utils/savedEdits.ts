import type { AppliedEdit } from "../types/api";
import type { AuditTrailEntry } from "../types/uml";

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
 * The other packages whose History lists edits applied to this graph: such edits are
 * neither History rows here (History is per package) nor older saved edits (they are
 * listed), so the panel names where to find them.
 */
export function packagesListingAppliedEdits(
  applied: AppliedEdit[] | undefined,
  history: AuditTrailEntry[],
  generation: string | undefined,
  isCurrentPackage: (pkg: string | undefined) => boolean,
): { count: number; packages: string[] } {
  const ids = new Set((applied ?? []).map(edit => edit.id).filter((id): id is string => Boolean(id)).map(String));
  const elsewhere = history.filter(entry => entry.package && !isCurrentPackage(entry.package)
    && (generation === undefined || entry.editGeneration === generation));
  const listed = new Set<string>();
  const packages = new Set<string>();
  for (const entry of elsewhere) {
    for (const id of entry.editIds ?? []) {
      if (ids.has(id)) {
        listed.add(id);
        packages.add(entry.package!);
      }
    }
  }
  return { count: listed.size, packages: [...packages].sort() };
}

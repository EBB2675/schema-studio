import type { StoredEdit } from "./editStore";

export const changesClassNames = (edit: StoredEdit): boolean =>
  edit.op === "add_class" || edit.op === "rename_class" || edit.op === "remove_class";

/** Edits that can change the roots offered by a module, in replay order. */
export function catalogEditKey(edits: StoredEdit[]): string {
  const lastRemoval = edits.reduce((last, edit, index) => edit.op === "remove_class" ? index : last, -1);
  // Removing a class can fail when it still has references. Undoing an earlier
  // attribute/range edit can change that outcome even with identical class edits.
  const referenceOps = new Set(["add_attribute", "remove_attribute", "rename_attribute", "set_range"]);
  return JSON.stringify(edits.filter((edit, index) =>
    changesClassNames(edit) || (index < lastRemoval && referenceOps.has(edit.op))));
}

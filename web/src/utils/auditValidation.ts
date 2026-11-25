import type { NodeDetails } from "../types/api";
import type { AuditChange, QuantityNode, UmlClassNode } from "../types/uml";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, accepts: (value: unknown) => boolean) =>
  value === undefined || accepts(value);
const nullable = (value: unknown, accepts: (value: unknown) => boolean) =>
  value === null || optional(value, accepts);

function isDetails(value: unknown): value is NodeDetails {
  return isRecord(value) &&
    ["code", "title", "titleDe", "docDe", "section", "iri", "unit"].every(key => optional(value[key], isString)) &&
    optional(value.mandatory, isBoolean);
}

function hasNodeFields(value: Record<string, unknown>): boolean {
  return isString(value.id) && isString(value.name) &&
    ["doc", "path"].every(key => nullable(value[key], isString)) &&
    nullable(value.line, isNumber) && nullable(value.details, isDetails);
}

function isQuantity(value: unknown): value is QuantityNode {
  return isRecord(value) && hasNodeFields(value) && isString(value.ownerId) &&
    optional(value.dtype, isString) && optional(value.inherited, isBoolean) &&
    ["shape", "card", "inheritedFromId", "inheritedFromName", "sourceId"].every(key => nullable(value[key], isString));
}

function isClass(value: unknown): value is UmlClassNode {
  return isRecord(value) && hasNodeFields(value) &&
    Array.isArray(value.quantities) && value.quantities.every(isQuantity) &&
    ["module", "parentId", "parentCard"].every(key => nullable(value[key], isString)) &&
    nullable(value.subclasses, isNumber) &&
    nullable(value.parentRelation, relation => relation === "inherits" || relation === "hasSubSection");
}

/** Stored history is untrusted, including nested snapshots used during undo/replay. */
export function isAuditChange(value: unknown): value is AuditChange {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "add-class":
    case "remove-class":
      return isClass(value.cls);
    case "edit-class":
      return isClass(value.before) && isClass(value.after);
    case "add-quantity":
    case "remove-quantity":
      return isString(value.classId) && isQuantity(value.quantity);
    case "edit-quantity":
      return isString(value.classId) && isQuantity(value.before) && isQuantity(value.after);
    default:
      return false;
  }
}

/** Reject partial undo references rather than silently changing their meaning. */
export function hasValidAuditMetadata(value: Record<string, unknown>): boolean {
  return optional(value.package, isString) && optional(value.editGeneration, isString) &&
    optional(value.replayable, isBoolean) &&
    optional(value.editIds, ids => Array.isArray(ids) && ids.every(isString));
}

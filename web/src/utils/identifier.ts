export const normalizeId = (value: string | null | undefined): string => (value ?? "").trim();

export const normalizeLabel = (value: string | null | undefined, fallback: string): string => {
  const normalized = normalizeId(value);
  return normalized || fallback;
};

export const normalizeModule = (value: string | null | undefined): string => {
  const cleaned = normalizeId(value);
  return cleaned.replace(/\.+$/, "");
};

export const fqidFromParts = (module: string | null | undefined, name: string | null | undefined, fallbackId?: string): string => {
  const base = normalizeLabel(name, normalizeId(fallbackId));
  const mod = normalizeModule(module);
  if (mod && base) return `${mod}.${base}`;
  return base;
};

/** Canonical package comparison shared by workspace selection and local history. */
export function normalizePackageName(value?: string | null): string {
  return value ? normalizeModule(value) || value : "";
}

/**
 * Whether a stored edit belongs to a package. The one test for both what History lists on
 * a canvas and what Clear deletes there, so a listed edit is always one Clear removes.
 * An edit without a package belongs to every package, as in the core's replay.
 */
export function belongsToPackage(editPackage: string | null | undefined, pkg: string): boolean {
  return !editPackage || normalizePackageName(editPackage) === normalizePackageName(pkg);
}

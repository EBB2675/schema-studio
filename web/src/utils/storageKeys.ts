/**
 * localStorage keys of this deployment. Sites on the same origin (for example two
 * GitHub Pages projects under one github.io domain) share localStorage, so every
 * key carries the site's base path (VITE_BASE_PATH, exposed by Vite as BASE_URL).
 */
const BASE_PATH = import.meta.env.BASE_URL || "/";

export const scopedStorageKey = (key: string, basePath: string = BASE_PATH): string => `${key}@${basePath}`;

// Keys used before they were scoped to the base path.
export const LEGACY_EDITS_STORAGE_KEY = "schema-studio-static-edits";
export const LEGACY_AUDIT_STORAGE_KEY = "schema-uml-audit";

export const EDITS_STORAGE_KEY = scopedStorageKey(LEGACY_EDITS_STORAGE_KEY);
export const AUDIT_STORAGE_KEY = scopedStorageKey(LEGACY_AUDIT_STORAGE_KEY);

/**
 * Reads `key`, or the unscoped `legacyKey` when `key` was never written, so data saved
 * before keys were scoped is not lost. It never writes: an unlocked write here could copy
 * the old value over a newer save from another tab. The scoped key is created by the next
 * save (for edits, inside the edit lock). The legacy value is kept, so another deployment
 * on the same origin can still pick it up. Errors from reading storage are left to the caller.
 *
 * Migration only: this fallback (and the LEGACY_* keys) can be removed once saved
 * data under the unscoped keys is no longer expected.
 */
export function readWithLegacyFallback(storage: Storage, key: string, legacyKey: string): string | null {
  return storage.getItem(key) ?? storage.getItem(legacyKey);
}

import { hasValidAuditMetadata, isAuditChange } from "../utils/auditValidation";
import { useEffect, useState } from "react";
import { getBrowserEditStore, LEGACY_EDIT_GENERATION } from "../static/editStore";
import type { AuditTrailEntry } from "../types/uml";
import { browserStorage, writePreference } from "../utils/browserStorage";
import { AUDIT_STORAGE_KEY, LEGACY_AUDIT_STORAGE_KEY, readWithLegacyFallback } from "../utils/storageKeys";

// UI history is optional; the edit store remains the source of truth for edits.
// Keep generation checks and migration of old history at this storage boundary.
const parseAuditEntry = (value: unknown): AuditTrailEntry | null => {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.timestamp !== "string" || typeof entry.description !== "string") {
    return null;
  }
  if (!isAuditChange(entry.change) || !hasValidAuditMetadata(entry)) return null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    description: entry.description,
    change: entry.change,
    replayable: entry.replayable === false ? false : true,
    package: typeof entry.package === "string" ? entry.package : undefined,
    editGeneration: typeof entry.editGeneration === "string" ? entry.editGeneration : LEGACY_EDIT_GENERATION,
    editIds: Array.isArray(entry.editIds)
      ? entry.editIds.filter((item): item is string => typeof item === "string")
      : undefined,
  };
};

export function useAuditTrail() {
  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const storage = browserStorage();
      const raw = storage ? readWithLegacyFallback(storage, AUDIT_STORAGE_KEY, LEGACY_AUDIT_STORAGE_KEY) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const generation = getBrowserEditStore().getGeneration();
      return parsed
        .map(parseAuditEntry)
        .filter((e): e is AuditTrailEntry => Boolean(e))
        .filter(e => e.editGeneration === generation)
        .filter((e) => !(typeof e.id === "string" && e.id.startsWith("persisted-")));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      writePreference(AUDIT_STORAGE_KEY, JSON.stringify(auditTrail));
    } catch {
      // ignore storage errors
    }
  }, [auditTrail]);

  return [auditTrail, setAuditTrail] as const;
}

import { browserStorage } from "../utils/browserStorage";
import { EDITS_STORAGE_KEY, LEGACY_EDITS_STORAGE_KEY, readWithLegacyFallback } from "../utils/storageKeys";
import { catalogEditKey } from "./catalogEdits";

/**
 * Schema edits of the static site, kept in this browser (localStorage).
 *
 * Stored edit fields: `id`, `profile`, `package`,
 * `commit`, `op`, `target`, `payload`, `created_at`. They can be downloaded as
 * a JSON file and loaded again, so work is not tied to one browser.
 */

export type StoredEdit = {
  id: number;
  profile: string;
  package: string;
  commit: string | null;
  op: string;
  target: string;
  payload: Record<string, unknown>;
  created_at: string | null;
};

export type EditLogFile = {
  format: "schema-studio-edits";
  version: 1;
  exported_at: string;
  edits: StoredEdit[];
};

type Saved = { nextId: number; edits: StoredEdit[]; generation: string };

// Older logs and history share this generation until the first replacement.
export const LEGACY_EDIT_GENERATION = "legacy";

// Scoped to the site's base path; see utils/storageKeys.
export { EDITS_STORAGE_KEY };

export interface EditTransaction {
  list(profile: string, pkg?: string): StoredEdit[];
  /** The generation of the log this transaction reads and writes. */
  generation(): string;
  nextIds(count: number): number[];
  add(edits: StoredEdit[]): void;
  remove(ids: number[], scope?: { profile: string; package?: string; allPackages?: boolean }): number;
  exportLog(): EditLogFile;
  importLog(file: unknown): number;
}

export interface EditStore {
  getRevision(): number;
  getCatalogRevision(): number;
  getGeneration(): string;
  hasUnsavedChanges(): boolean;
  subscribe(listener: () => void): () => void;
  list: EditTransaction["list"];
  /** A profile's edits and the generation of the log they come from, in one read. */
  snapshot(profile: string): { edits: StoredEdit[]; generation: string };
  exportLog: EditTransaction["exportLog"];
  transaction<T>(operation: (edits: EditTransaction) => T | Promise<T>): Promise<T>;
  remove(...args: Parameters<EditTransaction["remove"]>): Promise<number>;
  importLog(file: unknown): Promise<number>;
  restoreLog(file: unknown): Promise<number>;
  /** Removes every saved edit of every schema; returns how many there were (0 if unreadable). */
  discardAll(): Promise<number>;
  retrySave(): Promise<boolean>;
}

// Shared by store instances in this page when Web Locks are unavailable.
// This fallback cannot coordinate other browser tabs.
let mutationQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs a mutation under the edit lock of this deployment. Until the scoped log exists, edits
 * are still read from the legacy record, which tabs of the previous version (still open)
 * guard with the legacy lock: the mutation then holds that lock too, from its first read
 * through its first scoped write, so the log it validates against is the log it extends.
 * Old tabs only ever take the legacy lock, so taking scoped then legacy cannot deadlock.
 *
 * Migration only: the legacy lock can be dropped with the legacy fallback (utils/storageKeys).
 */
async function serialize<T>(operation: () => T | Promise<T>, readsLegacy: () => boolean = () => false): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    const locks = navigator.locks;
    return locks.request(EDITS_STORAGE_KEY, { mode: "exclusive" }, () => readsLegacy()
      ? locks.request(LEGACY_EDITS_STORAGE_KEY, { mode: "exclusive" }, operation)
      : operation());
  }
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function isEdit(value: unknown): value is StoredEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.profile === "string" && typeof edit.package === "string" && typeof edit.op === "string"
    && typeof edit.target === "string" && typeof edit.payload === "object" && edit.payload !== null;
}

export function createEditStore(storage: Storage | null = browserStorage()): EditStore {
  let memory: Saved = { nextId: 1, edits: [], generation: LEGACY_EDIT_GENERATION };
  let unsaved = false;
  let revision = 0;
  let catalogRevision = 0;
  const listeners = new Set<() => void>();
  // Checked under the scoped lock. An unreadable record also takes the legacy lock: safe.
  const readsLegacy = () => {
    if (!storage) return false;
    try {
      return storage.getItem(EDITS_STORAGE_KEY) === null;
    } catch {
      return true;
    }
  };

  const read = (): Saved => {
    if (unsaved || !storage) return memory;
    try {
      const raw = readWithLegacyFallback(storage, EDITS_STORAGE_KEY, LEGACY_EDITS_STORAGE_KEY);
      if (raw === null) {
        memory = { nextId: 1, edits: [], generation: LEGACY_EDIT_GENERATION };
        return memory;
      }
      const saved = JSON.parse(raw) as Saved;
      if (!saved || !Array.isArray(saved.edits) || !saved.edits.every(isEdit)
        || !Number.isSafeInteger(saved.nextId) || saved.nextId < 1) throw new Error("Invalid edit log");
      if (saved.generation !== undefined && (typeof saved.generation !== "string" || !saved.generation)) {
        throw new Error("Invalid edit generation");
      }
      memory = { ...saved, generation: saved.generation ?? LEGACY_EDIT_GENERATION };
    } catch {
      // Never turn an unknown persistent log into an empty successful read.
      throw new Error("Saved edits could not be read. Try again when browser storage is available, or restore a backup. Existing saved edits have not been changed.");
    }
    return memory;
  };

  const write = (saved: Saved) => {
    if (saved.generation !== memory.generation || catalogEditKey(saved.edits) !== catalogEditKey(memory.edits)) {
      catalogRevision += 1;
    }
    memory = saved;
    let persisted = false;
    try {
      if (storage) {
        storage.setItem(EDITS_STORAGE_KEY, JSON.stringify(saved));
        persisted = true;
      }
    } catch {
      // Keep memory authoritative until the entire current log is saved.
    }
    unsaved = !persisted;
    revision += 1;
    listeners.forEach(listener => listener());
  };

  const access: EditTransaction = {
    list(profile, pkg) {
      return read().edits.filter(edit => edit.profile === profile && (pkg === undefined || edit.package === pkg));
    },
    generation() {
      return read().generation;
    },
    nextIds(count) {
      const start = read().nextId;
      return Array.from({ length: count }, (_, index) => start + index);
    },
    add(edits) {
      const saved = read();
      const ids = new Set(saved.edits.map(edit => edit.id));
      for (const edit of edits) {
        if (ids.has(edit.id)) throw new Error(`Duplicate edit ID: ${edit.id}`);
        ids.add(edit.id);
      }
      const nextId = Math.max(saved.nextId, ...edits.map(edit => edit.id + 1));
      write({ ...saved, nextId, edits: [...saved.edits, ...edits] });
    },
    remove(ids, scope) {
      const saved = read();
      const byId = new Set(ids);
      const goes = (edit: StoredEdit) =>
        byId.has(edit.id)
        || (scope !== undefined && edit.profile === scope.profile
          && (scope.allPackages === true || (scope.package !== undefined && edit.package === scope.package)));
      const kept = saved.edits.filter(edit => !goes(edit));
      write({ ...saved, edits: kept });
      return saved.edits.length - kept.length;
    },
    exportLog() {
      return { format: "schema-studio-edits", version: 1, exported_at: new Date().toISOString(), edits: read().edits };
    },
    importLog(file) {
      const log = file as Partial<EditLogFile> | null;
      if (!log || log.format !== "schema-studio-edits" || !Array.isArray(log.edits) || !log.edits.every(isEdit)) {
        throw new Error("This file is not a Schema Studio edit log.");
      }
      // Loaded edits come after the ones here, in their own order, with new ids.
      const saved = read();
      let nextId = saved.nextId;
      const loaded = log.edits.map(edit => ({ ...edit, id: nextId++ }));
      write({ ...saved, nextId, edits: [...saved.edits, ...loaded] });
      return loaded.length;
    },
  };
  // Read IDs and existing edits only inside this callback, and hold the lock
  // through asynchronous validation and the final write. Do not nest transactions.
  const transaction: EditStore["transaction"] = operation => serialize(() => operation(access), readsLegacy);
  return {
    restoreLog: file => serialize(() => {
      const log = file as Partial<EditLogFile> | null;
      if (!log || log.format !== "schema-studio-edits" || log.version !== 1
        || !Array.isArray(log.edits) || !log.edits.every(isEdit)
        || log.edits.some(edit => !Number.isSafeInteger(edit.id) || edit.id < 1 || edit.id >= Number.MAX_SAFE_INTEGER)
        || new Set(log.edits.map(edit => edit.id)).size !== log.edits.length) {
        throw new Error("This file is not a valid Schema Studio backup.");
      }
      // Explicit replacement can recover even an unreadable existing log.
      const edits = structuredClone(log.edits);
      const nextId = edits.reduce((next, edit) => Math.max(next, edit.id + 1), 1);
      // A backup never supplies its identity: every replacement gets a fresh one.
      write({ nextId, edits, generation: crypto.randomUUID() });
      return edits.length;
    }, readsLegacy),
    discardAll: () => serialize(() => {
      let count = 0;
      let nextId = memory.nextId;
      try {
        const saved = read();
        count = saved.edits.length;
        nextId = saved.nextId;
      } catch {
        // Discarding is also the way out of a log that cannot be read.
      }
      // A fresh generation drops history entries that point at the discarded edits;
      // ids keep counting up so a late reference cannot name a new edit.
      write({ nextId, edits: [], generation: crypto.randomUUID() });
      return count;
    }, readsLegacy),
    retrySave: () => serialize(() => {
      if (unsaved) write(memory);
      return !unsaved;
    }, readsLegacy),
    getGeneration: () => read().generation,
    getRevision: () => revision,
    getCatalogRevision: () => catalogRevision,
    hasUnsavedChanges: () => unsaved,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    list: access.list,
    snapshot(profile) {
      const saved = read();
      return { edits: saved.edits.filter(edit => edit.profile === profile), generation: saved.generation };
    },
    exportLog: access.exportLog,
    transaction,
    remove: (...args) => transaction(store => store.remove(...args)),
    importLog: file => transaction(store => store.importLog(file)),
  };
}

// The UI and default backend must see the same generation even before it is saved.
let browserEditStore: EditStore | undefined;
export function getBrowserEditStore(): EditStore {
  return browserEditStore ??= createEditStore();
}

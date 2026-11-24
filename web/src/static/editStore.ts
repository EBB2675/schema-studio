import { browserStorage } from "../utils/browserStorage";

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

type Saved = { nextId: number; edits: StoredEdit[] };

export const EDITS_STORAGE_KEY = "schema-studio-static-edits";

export interface EditTransaction {
  list(profile: string, pkg?: string): StoredEdit[];
  nextIds(count: number): number[];
  add(edits: StoredEdit[]): void;
  remove(ids: number[], scope?: { profile: string; package?: string; allPackages?: boolean }): number;
  exportLog(): EditLogFile;
  importLog(file: unknown): number;
}

export interface EditStore {
  hasUnsavedChanges(): boolean;
  subscribe(listener: () => void): () => void;
  list: EditTransaction["list"];
  exportLog: EditTransaction["exportLog"];
  transaction<T>(operation: (edits: EditTransaction) => T | Promise<T>): Promise<T>;
  remove(...args: Parameters<EditTransaction["remove"]>): Promise<number>;
  importLog(file: unknown): Promise<number>;
  restoreLog(file: unknown): Promise<number>;
  retrySave(): Promise<boolean>;
}

// Shared by store instances in this page when Web Locks are unavailable.
// This fallback cannot coordinate other browser tabs.
let mutationQueue: Promise<unknown> = Promise.resolve();

async function serialize<T>(operation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(EDITS_STORAGE_KEY, { mode: "exclusive" }, operation);
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
  let memory: Saved = { nextId: 1, edits: [] };
  let unsaved = false;
  const listeners = new Set<() => void>();

  const read = (): Saved => {
    if (unsaved || !storage) return memory;
    try {
      const raw = storage.getItem(EDITS_STORAGE_KEY);
      if (raw === null) {
        memory = { nextId: 1, edits: [] };
        return memory;
      }
      const saved = JSON.parse(raw) as Saved;
      if (!saved || !Array.isArray(saved.edits) || !saved.edits.every(isEdit)
        || !Number.isSafeInteger(saved.nextId) || saved.nextId < 1) throw new Error("Invalid edit log");
      memory = saved;
    } catch {
      // Never turn an unknown persistent log into an empty successful read.
      throw new Error("Saved edits could not be read. Try again when browser storage is available, or restore a backup. Existing saved edits have not been changed.");
    }
    return memory;
  };

  const write = (saved: Saved) => {
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
    if (unsaved !== !persisted) {
      unsaved = !persisted;
      listeners.forEach(listener => listener());
    }
  };

  const access: EditTransaction = {
    list(profile, pkg) {
      return read().edits.filter(edit => edit.profile === profile && (pkg === undefined || edit.package === pkg));
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
      write({ nextId, edits: [...saved.edits, ...edits] });
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
      write({ nextId, edits: [...saved.edits, ...loaded] });
      return loaded.length;
    },
  };
  // Read IDs and existing edits only inside this callback, and hold the lock
  // through asynchronous validation and the final write. Do not nest transactions.
  const transaction: EditStore["transaction"] = operation => serialize(() => operation(access));
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
      write({ nextId, edits });
      return edits.length;
    }),
    retrySave: () => serialize(() => {
      if (unsaved) write(memory);
      return !unsaved;
    }),
    hasUnsavedChanges: () => unsaved,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    list: access.list,
    exportLog: access.exportLog,
    transaction,
    remove: (...args) => transaction(store => store.remove(...args)),
    importLog: file => transaction(store => store.importLog(file)),
  };
}

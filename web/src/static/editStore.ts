/**
 * Schema edits of the static site, kept in this browser (localStorage).
 *
 * The same rows the Light Mode server stores: `id`, `profile`, `package`,
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

export interface EditStore {
  list(profile: string, pkg?: string): StoredEdit[];
  nextIds(count: number): number[];
  add(edits: StoredEdit[]): void;
  remove(ids: number[], scope?: { profile: string; package?: string; allPackages?: boolean }): number;
  exportLog(): EditLogFile;
  importLog(file: unknown): number;
}

function isEdit(value: unknown): value is StoredEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.profile === "string" && typeof edit.package === "string" && typeof edit.op === "string"
    && typeof edit.target === "string" && typeof edit.payload === "object" && edit.payload !== null;
}

export function createEditStore(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage): EditStore {
  let memory: Saved = { nextId: 1, edits: [] };

  const read = (): Saved => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(EDITS_STORAGE_KEY);
      if (!raw) return memory;
      const saved = JSON.parse(raw) as Saved;
      if (Array.isArray(saved.edits) && typeof saved.nextId === "number") memory = saved;
    } catch {
      // unreadable storage: keep what this page has
    }
    return memory;
  };

  const write = (saved: Saved) => {
    memory = saved;
    if (!storage) return;
    try {
      storage.setItem(EDITS_STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // storage full or blocked: the edits stay for this page only
    }
  };

  return {
    list(profile, pkg) {
      return read().edits.filter(edit => edit.profile === profile && (pkg === undefined || edit.package === pkg));
    },
    nextIds(count) {
      const start = read().nextId;
      return Array.from({ length: count }, (_, index) => start + index);
    },
    add(edits) {
      const saved = read();
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
}

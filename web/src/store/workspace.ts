import { create } from "zustand";
import { DEFAULT_BRANCH, DEFAULT_NAMESPACE, DEFAULT_PACKAGE } from "../constants/defaults";
import type { WorkspaceState } from "../types/workspace";

type WorkspaceStore = {
  branch: string;
  pkg: string;
  baseNamespace: string;
  startEmpty: boolean;
  setBranch: (branch: string) => void;
  setPkg: (pkg: string) => void;
  setBaseNamespace: (namespace: string) => void;
  setStartEmpty: (empty: boolean) => void;
  applyWorkspace: (ws: WorkspaceState | null | undefined) => void;
};

const STORAGE_KEYS = {
  branch: "schema-uml-branch",
  pkg: "schema-uml-package",
  baseNamespace: "schema-uml-base-namespace",
  startEmpty: "schema-uml-start-empty",
} as const;

const readString = (key: keyof typeof STORAGE_KEYS, fallback: string) => {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(STORAGE_KEYS[key]);
  return stored || fallback;
};

const readBool = (key: keyof typeof STORAGE_KEYS, fallback: boolean) => {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(STORAGE_KEYS[key]);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return fallback;
};

const persist = (key: keyof typeof STORAGE_KEYS, value: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEYS[key], value);
  } catch {
    // ignore storage failures
  }
};

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  branch: readString("branch", DEFAULT_BRANCH),
  pkg: readString("pkg", DEFAULT_PACKAGE),
  baseNamespace: readString("baseNamespace", DEFAULT_NAMESPACE),
  startEmpty: readBool("startEmpty", false),
  setBranch: (branch) => {
    persist("branch", branch);
    set({ branch });
  },
  setPkg: (pkg) => {
    persist("pkg", pkg);
    set({ pkg });
  },
  setBaseNamespace: (namespace) => {
    persist("baseNamespace", namespace);
    set({ baseNamespace: namespace });
  },
  setStartEmpty: (empty) => {
    persist("startEmpty", String(empty));
    set({ startEmpty: empty });
  },
  applyWorkspace: (ws) => {
    if (!ws) return;
    set((current) => {
      const nextBranch = ws.branch || current.branch;
      const nextPkg = ws.package || current.pkg;
      const nextNamespace = ws.base_namespace || current.baseNamespace;
      persist("branch", nextBranch);
      persist("pkg", nextPkg);
      persist("baseNamespace", nextNamespace);
      return {
        branch: nextBranch,
        pkg: nextPkg,
        baseNamespace: nextNamespace,
      };
    });
  },
}));

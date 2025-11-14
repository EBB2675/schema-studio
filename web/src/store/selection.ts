import { create } from 'zustand';

export type Selected = null | {
  id: string;
  kind: 'class' | 'quantity';
  name: string;
  doc: string;
  path?: string;
  line?: number;
};

export type UsageEntry = {
  kind: 'normalize_method' | 'normalize_function' | 'utility_function';
  qualname: string;
  module: string;
  short_name: string;
  doc?: string | null;
};

type SelectionState = {
  selected: Selected;
  usage: UsageEntry[] | null;
  loadingUsage: boolean;
  setSelected: (s: Selected) => void;
};

export const useSelection = create<SelectionState>((set) => ({
  selected: null,
  usage: null,
  loadingUsage: false,

  setSelected: (s: Selected) => {
    // Always update the selected node
    set({ selected: s, usage: null, loadingUsage: false });

    // Only classes have "under the hood" info
    if (!s || s.kind !== 'class') {
      return;
    }

    // Start loading
    set({ loadingUsage: true });

    const url = `/usage?section_id=${encodeURIComponent(s.id)}`;

    fetch(url)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: UsageEntry[]) => {
        set({ usage: data, loadingUsage: false });
      })
      .catch(() => {
        // On error: show empty list so the panel can say "none found"
        set({ usage: [], loadingUsage: false });
      });
  },
}));
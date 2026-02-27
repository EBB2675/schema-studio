import { create } from 'zustand';

export type QtySnapshot = {
  name?: string;
  dtype?: string;
  shape?: string | null;
  card?: string | null;
  doc?: string | null;
};

export type QtyMeta = {
  id: string;
  name: string;
  dtype?: string;
  shape?: string | null;
  card?: string | null;
  doc?: string;
  path?: string;
  line?: number;
  owner: string;
  inherited?: boolean;
  inheritedFromId?: string | null;
  inheritedFromName?: string | null;
  sourceId?: string | null;
  diff?: { state: 'added' | 'removed' | 'changed'; before?: QtySnapshot; after?: QtySnapshot };
};

export type Selected = null | {
  id: string;                    // fully-qualified id from backend
  kind: 'class' | 'quantity';
  name: string;
  doc: string;
  path?: string;
  line?: number;
  quantities?: QtyMeta[];
  dtype?: string;
  shape?: string | null;
  card?: string | null;
  owner?: string;
  inherited?: boolean;
  inheritedFromId?: string | null;
  inheritedFromName?: string | null;
  sourceId?: string | null;
  fqid?: string;
  diff?: QtyMeta['diff'];
};

type SelectionState = {
  selected: Selected;
  setSelected: (s: Selected) => void;
};

export const useSelection = create<SelectionState>((set) => ({
  selected: null,
  setSelected: (s: Selected) => set({ selected: s }),
}));

import { create } from 'zustand';

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
};

export type Selected = null | {
  id: string;                    // fully-qualified id from backend
  kind: 'class' | 'quantity';
  name: string;
  doc: string;
  path?: string;
  line?: number;
  quantities?: QtyMeta[];
};

type SelectionState = {
  selected: Selected;
  setSelected: (s: Selected) => void;
};

export const useSelection = create<SelectionState>((set) => ({
  selected: null,
  setSelected: (s: Selected) => set({ selected: s }),
}));

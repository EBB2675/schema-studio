import { create } from "zustand";

export type QtyMeta = {
  id: string;
  name: string;
  dtype?: string;
  shape?: string | null;
  card?: string | null;
  doc?: string;
  path?: string;
  line?: number;
  owner?: string;
};

type Selected =
  | null
  | {
      id: string;
      kind: "class" | "quantity";
      name: string;
      doc: string;
      path?: string;
      line?: number;
      // class view
      quantities?: QtyMeta[];
      // quantity view
      dtype?: string;
      shape?: string | null;
      card?: string | null;
      owner?: string;
    };

export const useSelection = create<{
  selected: Selected;
  setSelected: (s: Selected) => void;
}>((set) => ({
  selected: null,
  setSelected: (s) => set({ selected: s }),
}));

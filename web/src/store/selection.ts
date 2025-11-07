import { create } from "zustand";

type Selected =
  | null
  | {
      id: string;
      kind: "class" | "quantity";
      name: string;
      doc: string;
      path?: string;
      line?: number;
    };

export const useSelection = create<{
  selected: Selected;
  setSelected: (s: Selected) => void;
}>(set => ({
  selected: null,
  setSelected: (s) => set({ selected: s }), // <-- important
}));

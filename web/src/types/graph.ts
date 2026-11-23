import type { ApiNode, ApiEdge } from "./api";
import type { UmlClassNode, UmlGraphState } from "./uml";
import type { EditRules, QuantityFormData } from "../components/quantityShared";
import type { LayoutDirection } from "../utils/layoutDirection";

export type GraphExportHandle = {
  toPng: () => string | null | Promise<string | null>;
  // Selects a class; moveViewport: false leaves pan and zoom as they are.
  focusNode: (name: string, options?: { moveViewport?: boolean }) => boolean;
  refit: () => void;
};


export type GraphViewProps = {
  nodes: ApiNode[];
  edges: ApiEdge[];
  onReady?: (handle: GraphExportHandle | null) => void;
  // A new value means a new graph: the canvas lays it out and fits it once. Other
  // changes keep the classes where they are and place only the ones that join.
  layoutKey?: string | number;
  // Called when that layout ends, also when its fit was cancelled, but not after a
  // layout for a new layoutDirection.
  onLayoutReady?: (handle: GraphExportHandle) => void;
  showQuantityMetadata?: boolean;
  // Cards show only the class name; the side panel still lists what a class holds.
  compact?: boolean;
  showInheritance?: boolean;
  theme?: "dark" | "light";
  // A change lays the canvas out again and fits it.
  layoutDirection?: LayoutDirection;
  umlState?: UmlGraphState | null;
  baseNamespaces?: string[];
  showBaseSections?: boolean;
  pinnedClassIds?: string[];
  selectedClassId?: string | null;
  onSelectClass?: (cls: UmlClassNode) => void;
  onCreateQuantity?: (classId: string, data: QuantityFormData) => Promise<void>;
  onCreateClass?: (data: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection"; card?: string }) => Promise<void>;
  creatingQuantityFor?: string | null;
  creatingClass?: boolean;
  onClearSelection?: () => void;
  editableMode?: boolean;
  // What the schema lets the user add (types; bam-masterdata codes).
  editRules?: EditRules;
  // Classes whose subclasses are shown, and the +/- on a card that shows or hides them.
  expandedClassIds?: string[];
  onToggleSubclasses?: (classId: string) => void | Promise<void>;
};

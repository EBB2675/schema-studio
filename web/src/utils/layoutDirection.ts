// Edges point from subclasses toward their base classes.
export type LayoutDirection = "UP" | "LEFT" | "RIGHT" | "DOWN";

export const LAYOUT_DIRECTIONS: { value: LayoutDirection; label: string }[] = [
  { value: "UP", label: "Root at top" },
  { value: "LEFT", label: "Root at left" },
  { value: "RIGHT", label: "Root at right" },
  { value: "DOWN", label: "Root at bottom" },
];

// Root at the top, as in UML class diagrams.
export const DEFAULT_LAYOUT_DIRECTION: LayoutDirection = "UP";

export const LAYOUT_DIRECTION_STORAGE_KEY = "schema-uml-layout-direction";

export const initialLayoutDirection = (stored: string | null | undefined): LayoutDirection =>
  LAYOUT_DIRECTIONS.find((option) => option.value === stored)?.value ?? DEFAULT_LAYOUT_DIRECTION;

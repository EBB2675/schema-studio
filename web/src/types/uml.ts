export type QuantityNode = {
  id: string;
  name: string;
  dtype?: string;
  shape?: string | null;
  card?: string | null;
  doc?: string | null;
  path?: string | null;
  line?: number | null;
  ownerId: string;
  inherited?: boolean;
  inheritedFromId?: string | null;
  inheritedFromName?: string | null;
  sourceId?: string | null;
};

export type UmlClassNode = {
  id: string;
  name: string;
  doc?: string | null;
  module?: string | null;
  path?: string | null;
  line?: number | null;
  quantities: QuantityNode[];
  parentId?: string | null;
  parentRelation?: "inherits" | "hasSubSection" | null;
  parentCard?: string | null;
};

export type UmlEdge = {
  source: string;
  target: string;
  type: string;
  card?: string | null;
};

export type UmlGraphState = {
  package: string;
  root: string | null;
  classes: UmlClassNode[];
  edges: UmlEdge[];
};

export type AuditChange =
  | { type: "add-class"; cls: UmlClassNode }
  | { type: "remove-class"; cls: UmlClassNode }
  | { type: "edit-class"; before: UmlClassNode; after: UmlClassNode }
  | { type: "add-quantity"; classId: string; quantity: QuantityNode }
  | { type: "remove-quantity"; classId: string; quantity: QuantityNode }
  | { type: "edit-quantity"; classId: string; before: QuantityNode; after: QuantityNode };

export type AuditTrailEntry = {
  id: string;
  timestamp: string;
  description: string;
  package?: string;
  replayable?: boolean;
  change: AuditChange;
};

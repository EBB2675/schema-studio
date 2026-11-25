import { describe, expect, it } from 'vitest';
import type { ApiGraph } from '../src/types/api';
import type { AuditChange, QuantityNode, UmlClassNode } from '../src/types/uml';
import { applyForwardChange } from '../src/utils/auditReplay';

const quantity: QuantityNode = { id: 'pkg.A.q', name: 'q', ownerId: 'pkg.A' };
const cls: UmlClassNode = { id: 'pkg.A', name: 'A', quantities: [quantity] };
const baseline: ApiGraph = {
  package: 'pkg', root: null,
  nodes: [{ id: 'pkg.Base', label: 'Base', kind: 'section' }], edges: [],
};

function freezeDeep(value: object) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') freezeDeep(nested);
  }
}

describe('local history replay', () => {
  it('replays all change types without mutating snapshots or payloads', () => {
    const renamed = { ...quantity, id: 'pkg.A.renamed', name: 'renamed' };
    const changes: AuditChange[] = [
      { type: 'add-class', cls },
      { type: 'edit-class', before: cls, after: { ...cls, doc: 'Updated' } },
      { type: 'edit-quantity', classId: cls.id, before: quantity, after: renamed },
      { type: 'remove-quantity', classId: cls.id, quantity: renamed },
      { type: 'add-quantity', classId: cls.id, quantity },
      { type: 'remove-class', cls },
    ];
    freezeDeep(changes);
    let graph = structuredClone(baseline);
    const snapshots: ApiGraph[] = [];
    for (const change of changes) {
      freezeDeep(graph);
      graph = applyForwardChange(graph, change);
      snapshots.push(graph);
    }
    expect(snapshots[0].nodes.map(n => n.id)).toEqual(['pkg.Base', cls.id, quantity.id]);
    expect(snapshots[1].nodes.find(n => n.id === cls.id)?.doc).toBe('Updated');
    expect(snapshots[2].nodes.some(n => n.id === quantity.id)).toBe(false);
    expect(snapshots[2].edges).toContainEqual({ source: cls.id, target: renamed.id, type: 'hasQuantity', card: null });
    expect(snapshots[3].edges).toEqual([]);
    expect(snapshots[4].nodes.some(n => n.id === quantity.id)).toBe(true);
    expect(graph).toEqual(baseline);
  });

  it.each(['inherits', 'hasSubSection'] as const)('preserves %s direction and excludes inherited quantities', parentRelation => {
    const graph = applyForwardChange(baseline, { type: 'add-class', cls: {
      ...cls, parentId: 'pkg.Base', parentRelation, parentCard: '0..*',
      quantities: [quantity, { ...quantity, id: 'pkg.Base.inherited', inherited: true }],
    } });
    expect(graph.nodes.map(n => n.id)).not.toContain('pkg.Base.inherited');
    expect(graph.edges).toContainEqual(parentRelation === 'inherits'
      ? { source: cls.id, target: 'pkg.Base', type: 'inherits', card: null }
      : { source: 'pkg.Base', target: cls.id, type: 'hasSubSection', card: '0..*' });
  });
});

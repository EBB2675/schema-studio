import { describe, expect, it } from 'vitest';
import { isAuditChange } from '../src/utils/auditValidation';
import type { AuditChange, QuantityNode, UmlClassNode } from '../src/types/uml';

const quantity: QuantityNode = { id: 'pkg.A.q', name: 'q', ownerId: 'pkg.A', dtype: 'str' };
const cls: UmlClassNode = { id: 'pkg.A', name: 'A', quantities: [quantity] };
const changes: AuditChange[] = [
  { type: 'add-class', cls }, { type: 'remove-class', cls },
  { type: 'edit-class', before: cls, after: cls },
  { type: 'add-quantity', classId: cls.id, quantity },
  { type: 'remove-quantity', classId: cls.id, quantity },
  { type: 'edit-quantity', classId: cls.id, before: quantity, after: quantity },
];

describe('stored audit changes', () => {
  it.each(changes)('accepts complete $type snapshots after JSON roundtrip', change => {
    expect(isAuditChange(JSON.parse(JSON.stringify(change)))).toBe(true);
  });

  it.each(changes)('rejects missing payloads for $type', change => {
    for (const key of Object.keys(change).filter(key => key !== 'type')) {
      const broken = { ...change } as Record<string, unknown>;
      delete broken[key];
      expect(isAuditChange(broken)).toBe(false);
    }
  });

  it.each([
    null, [], { type: 'future-operation' }, { type: 'add-class', cls: null },
    { type: 'add-class', cls: { ...cls, id: 123 } },
    { type: 'add-class', cls: { ...cls, quantities: [null] } },
    { type: 'add-class', cls: { ...cls, quantities: [{ ...quantity, ownerId: [] }] } },
    { type: 'add-class', cls: { ...cls, parentRelation: 'unknown' } },
    { type: 'add-class', cls: { ...cls, details: { code: [] } } },
    { type: 'add-class', cls: { ...cls, line: Infinity } },
    { type: 'add-quantity', classId: cls.id, quantity: { ...quantity, inherited: 'false' } },
    { type: 'edit-quantity', classId: cls.id, before: quantity, after: { ...quantity, dtype: {} } },
  ])('rejects malformed nested data (%#)', change => {
    expect(isAuditChange(change)).toBe(false);
  });

  it('accepts nullable display metadata and inherited quantities', () => {
    expect(isAuditChange({ type: 'add-class', cls: {
      ...cls, module: null, parentRelation: null, subclasses: null, details: null,
      quantities: [{ ...quantity, shape: null, inherited: true, inheritedFromId: 'pkg.Base' }],
    } })).toBe(true);
  });
});

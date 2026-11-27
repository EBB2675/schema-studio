import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAuditTrail } from '../src/hooks/useAuditTrail';
import { getBrowserEditStore } from '../src/static/editStore';
import type { AuditTrailEntry } from '../src/types/uml';
import { AUDIT_STORAGE_KEY } from '../src/utils/storageKeys';

const key = AUDIT_STORAGE_KEY;
const entry = (id: string): AuditTrailEntry => ({
  id, timestamp: '2026-11-24T00:00:00Z', description: id,
  editGeneration: getBrowserEditStore().getGeneration(),
  change: { type: 'add-class', cls: { id: 'pkg.A', name: 'A', quantities: [] } },
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('audit history storage boundary', () => {
  it('migrates obsolete snapshot history while retaining local undo entries across reopening', () => {
    localStorage.setItem(key, JSON.stringify([entry('persisted-1'), entry('local-1')]));
    const first = renderHook(useAuditTrail);
    expect(first.result.current[0].map(e => e.id)).toEqual(['local-1']);
    act(() => first.result.current[1](previous => [...previous, entry('local-2')]));
    first.unmount();
    const reopened = renderHook(useAuditTrail);
    expect(reopened.result.current[0].map(e => e.id)).toEqual(['local-1', 'local-2']);
  });

  it('discards undo references from a replaced edit log', () => {
    localStorage.setItem(key, JSON.stringify([
      { ...entry('old'), editGeneration: 'replaced-generation' }, entry('current'),
    ]));
    const { result } = renderHook(useAuditTrail);
    expect(result.current[0].map(e => e.id)).toEqual(['current']);
  });

  it.each([
    { change: { type: 'add-class', cls: null } },
    { change: { type: 'unknown' } },
    { editIds: ['1', 2] },
    { editGeneration: 123 },
    { package: [] },
    { replayable: 'false' },
  ])('drops corrupt entries without losing neighboring valid history (%#)', broken => {
    localStorage.setItem(key, JSON.stringify([
      entry('before'), { ...entry('broken'), ...broken }, entry('after'),
    ]));
    const { result } = renderHook(useAuditTrail);
    expect(result.current[0].map(e => e.id)).toEqual(['before', 'after']);
    expect(JSON.parse(localStorage.getItem(key)!).map((e: AuditTrailEntry) => e.id)).toEqual(['before', 'after']);
  });

  it.each(['invalid json', '{}', '[null]'])('recovers from unreadable optional history: %s', raw => {
    localStorage.setItem(key, raw);
    expect(renderHook(useAuditTrail).result.current[0]).toEqual([]);
  });
});

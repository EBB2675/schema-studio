import { describe, expect, it } from 'vitest';
import { createCanvasSession, type CanvasIdentity } from '../src/utils/canvasSession';

const canvas: CanvasIdentity = { package: 'pkg', root: 'A', namespace: 'pkg', branch: 'main', empty: false };

describe('canvas request lifecycle', () => {
  it('supersedes reads without ending an edit when the canvas is refreshed', () => {
    const session = createCanvasSession();
    session.invalidate(canvas);
    const editIsCurrent = session.captureContext();
    const first = session.beginRequest();
    const second = session.beginRequest();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    expect(editIsCurrent()).toBe(true);
  });

  it('invalidates both reads and edit completions on Home, even after returning to the same canvas', () => {
    const session = createCanvasSession();
    session.invalidate(canvas);
    const editIsCurrent = session.captureContext();
    const readIsCurrent = session.beginRequest();
    session.invalidate(null);
    expect(session.matches(canvas)).toBe(false);
    session.invalidate(canvas);
    expect(editIsCurrent()).toBe(false);
    expect(readIsCurrent()).toBe(false);
  });

  it('lets a successful mutation supersede reads while other edits retain their context', () => {
    const session = createCanvasSession();
    session.invalidate(canvas);
    const editIsCurrent = session.captureContext();
    const readIsCurrent = session.beginRequest();
    session.invalidateRequests();
    expect(readIsCurrent()).toBe(false);
    expect(editIsCurrent()).toBe(true);
    expect(session.captureRequest()()).toBe(true);
  });

  it('updates a renamed root without invalidating the active edit context', () => {
    const session = createCanvasSession();
    session.invalidate(canvas);
    const editIsCurrent = session.captureContext();
    session.updateRoot('Renamed');
    expect(session.matches({ ...canvas, root: 'Renamed' })).toBe(true);
    expect(session.matches(canvas)).toBe(false);
    expect(editIsCurrent()).toBe(true);
  });

  it.each<Partial<CanvasIdentity>>([
    { package: 'other' }, { root: 'B' }, { namespace: 'other' }, { branch: 'next' }, { empty: true },
  ])('recognizes a changed canvas identity: %j', change => {
    const session = createCanvasSession();
    session.invalidate(canvas);
    expect(session.matches({ ...canvas })).toBe(true);
    expect(session.matches({ ...canvas, ...change })).toBe(false);
  });

  it('owns identity independently of caller objects', () => {
    const session = createCanvasSession();
    const input = { ...canvas };
    session.invalidate(input);
    input.root = 'Mutated';
    expect(session.matches(canvas)).toBe(true);
  });
});

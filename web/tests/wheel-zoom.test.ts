import cytoscape, { type Core } from 'cytoscape';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachWheelZoom } from '../src/utils/wheelZoom';

describe('canvas wheel zoom', () => {
  let cy: Core;
  let container: HTMLDivElement;
  let dispose: () => void;
  let time: number;
  let id: number;
  let frames: Map<number, FrameRequestCallback>;
  const advance = (ms = 16) => {
    time += ms;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  };
  const settle = () => {
    for (let i = 0; i < 40 && frames.size; i++) advance();
    expect(frames.size).toBe(0);
  };
  const wheel = (deltaY = -100, extra: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', {
      deltaY, clientX: 300, clientY: 200, bubbles: true, cancelable: true, ...extra,
    });
    // happy-dom's WheelEvent omits inherited MouseEvent coordinates.
    Object.defineProperties(event, { clientX: { value: 300 }, clientY: { value: 200 } });
    container.dispatchEvent(event);
    return event;
  };
  beforeEach(() => {
    time = 0; id = 0; frames = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    container = document.createElement('div');
    document.body.append(container);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 20, y: 30, left: 20, top: 30, right: 820, bottom: 630, width: 800, height: 600,
      toJSON: () => ({}),
    });
    // Real Cytoscape viewport math without a canvas renderer.
    cy = cytoscape({ headless: true, minZoom: 0.05, maxZoom: 3.5, zoom: 1 });
    dispose = attachWheelZoom(container, () => cy);
  });
  afterEach(() => {
    dispose(); cy.destroy(); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it('responds on the first frame and treats first and later notches consistently', () => {
    for (let notch = 0; notch < 6; notch++) {
      cy.zoom(1); wheel();
      expect(cy.zoom()).toBe(1);
      advance();
      expect(cy.zoom()).toBeGreaterThan(1.2);
      expect(cy.zoom()).toBeLessThan(Math.exp(0.5));
      settle();
      expect(cy.zoom()).toBeCloseTo(Math.exp(0.5), 8);
    }
  });
  it('keeps the point under the cursor fixed throughout the animation', () => {
    cy.pan({ x: 12, y: 24 });
    const model = { x: 280 - 12, y: 170 - 24 };
    wheel();
    for (let i = 0; i < 12; i++) {
      advance();
      expect(model.x * cy.zoom() + cy.pan().x).toBeCloseTo(280, 8);
      expect(model.y * cy.zoom() + cy.pan().y).toBeCloseTo(170, 8);
    }
  });
  it.each([0, 1, 2])('normalizes delta mode %s and caps oversized events', deltaMode => {
    wheel(-10000, { deltaMode }); settle();
    expect(cy.zoom()).toBeCloseTo(Math.exp(0.6), 8);
  });
  it('keeps small trackpad deltas proportional and coalesces events', () => {
    wheel(-1); wheel(-2); wheel(-3);
    expect(frames.size).toBe(1);
    settle();
    expect(cy.zoom()).toBeCloseTo(Math.exp(0.03), 8);
  });
  it('reverses immediately instead of finishing the old target', () => {
    wheel(); wheel(); wheel(); advance();
    const before = cy.zoom();
    wheel(100); advance();
    expect(cy.zoom()).toBeLessThan(before);
    settle();
    expect(cy.zoom()).toBeCloseTo(before * Math.exp(-0.5), 8);
  });
  it('does not accumulate excess wheel input at zoom limits', () => {
    cy.zoom(3.5);
    for (let i = 0; i < 20; i++) wheel();
    settle();
    expect(cy.zoom()).toBe(3.5);
    wheel(100); settle();
    expect(cy.zoom()).toBeCloseTo(3.5 * Math.exp(-0.5));
    cy.zoom(0.05); wheel(100); settle();
    expect(cy.zoom()).toBeCloseTo(0.05);
  });
  it('yields to external viewport changes such as fit and focus', () => {
    wheel(); advance();
    cy.viewport({ zoom: 0.2, pan: { x: 10, y: 15 } }); settle();
    expect(cy.zoom()).toBe(0.2);
    expect(cy.pan()).toEqual({ x: 10, y: 15 });
  });
  it('does not zoom during pointer dragging and resumes after release', () => {
    wheel(); container.dispatchEvent(new Event('pointerdown')); wheel();
    expect(frames.size).toBe(0);
    expect(cy.zoom()).toBe(1);
    window.dispatchEvent(new Event('pointerup')); wheel(); settle();
    expect(cy.zoom()).toBeGreaterThan(1);
  });
  it('stops a pending animation when zoom is disabled', () => {
    wheel(); advance();
    const zoom = cy.zoom();
    cy.zoomingEnabled(false); settle();
    expect(cy.zoom()).toBe(zoom);
  });
  it('honors reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    wheel(); advance();
    expect(cy.zoom()).toBeCloseTo(Math.exp(0.5));
    expect(frames.size).toBe(0);
  });
  it('prevents duplicate wheel handling and cleans up listeners and animation', () => {
    const nativeWheel = vi.fn();
    container.addEventListener('wheel', nativeWheel, true);
    expect(wheel().defaultPrevented).toBe(true);
    expect(nativeWheel).not.toHaveBeenCalled();
    dispose();
    expect(frames.size).toBe(0);
    expect(wheel().defaultPrevented).toBe(false);
    expect(nativeWheel).toHaveBeenCalledOnce();
  });
  it('leaves disabled zoom and zero deltas alone', () => {
    expect(wheel(0).defaultPrevented).toBe(false);
    cy.userZoomingEnabled(false);
    expect(wheel().defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
  });
});

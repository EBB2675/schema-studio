import type { Core } from 'cytoscape';

// Normalize browser wheel units without a device-detection warmup. A typical
// 100px wheel notch is about x1.22, so content away from the cursor drifts
// gradually; small trackpad deltas stay proportional.
export const LOG_ZOOM_PER_PIXEL = 0.002;
export const MAX_EVENT_PIXELS = 120;
const RESPONSE_MS = 20;

type Viewport = { zoom: number; pan: { x: number; y: number } };
const interactive = (cy: Core) =>
  cy.zoomingEnabled() && cy.userZoomingEnabled() && cy.panningEnabled() && cy.userPanningEnabled();
const viewport = (cy: Core): Viewport => ({ zoom: cy.zoom(), pan: { ...cy.pan() } });
const matches = (cy: Core, expected: Viewport) => {
  const pan = cy.pan();
  return cy.zoom() === expected.zoom && pan.x === expected.pan.x && pan.y === expected.pan.y;
};

// Install BEFORE Cytoscape registers its wheel listener on this container.
// Only wheel input is intercepted; native touch gestures and node dragging stay
// with Cytoscape. Cleanup cancels both the listener and any pending animation.
export function attachWheelZoom(container: HTMLElement, getCy: () => Core | null) {
  let frame: number | null = null;
  let expected: Viewport | null = null;
  let target = 0;
  let direction = 0;
  let lastFrame = 0;
  let anchor = { x: 0, y: 0 };
  let pointerDown = false;

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    expected = null;
    direction = 0;
  };

  const tick = (now: number) => {
    frame = null;
    const cy = getCy();
    // A fit, focus action, touch gesture or other viewport change takes over.
    if (!cy || !expected || !interactive(cy) || !matches(cy, expected)) {
      cancel();
      return;
    }
    const current = Math.log(cy.zoom());
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const blend = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, now - lastFrame) / RESPONSE_MS);
    const next = current + (target - current) * blend;
    const finished = reducedMotion || Math.abs(target - next) < 0.001;
    cy.zoom({ level: Math.exp(finished ? target : next), renderedPosition: anchor });
    expected = viewport(cy);
    lastFrame = now;
    if (finished) cancel();
    else frame = requestAnimationFrame(tick);
  };

  const onWheel = (event: WheelEvent) => {
    const cy = getCy();
    if (!cy || event.defaultPrevented || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    if (!interactive(cy)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pointerDown || event.buttons) {
      cancel();
      return;
    }

    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? container.clientHeight || 800 : 1;
    const pixels = Math.max(-MAX_EVENT_PIXELS, Math.min(MAX_EVENT_PIXELS, event.deltaY * unit));
    const step = -pixels * LOG_ZOOM_PER_PIXEL;
    const nextDirection = Math.sign(step);
    // Reversing the wheel must reverse immediately, not finish an old target.
    if (!expected || !matches(cy, expected) || nextDirection !== direction) {
      cancel();
      target = Math.log(cy.zoom());
    }
    target = Math.max(Math.log(cy.minZoom()), Math.min(Math.log(cy.maxZoom()), target + step));
    direction = nextDirection;
    expected = viewport(cy);
    const rect = container.getBoundingClientRect();
    const scaleX = container.offsetWidth ? rect.width / container.offsetWidth : 1;
    const scaleY = container.offsetHeight ? rect.height / container.offsetHeight : 1;
    anchor = {
      x: (event.clientX - rect.left) / (scaleX || 1) - container.clientLeft,
      y: (event.clientY - rect.top) / (scaleY || 1) - container.clientTop,
    };
    if (frame === null) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  const onPointerDown = () => { pointerDown = true; cancel(); };
  const onPointerUp = () => { pointerDown = false; };
  const onBlur = () => { pointerDown = false; cancel(); };
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('blur', onBlur);
  return () => {
    cancel();
    container.removeEventListener('wheel', onWheel, true);
    container.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('blur', onBlur);
  };
}

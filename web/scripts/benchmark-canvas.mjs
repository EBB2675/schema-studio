// Run with Node 22+ against a LOCAL Chromium debugging port, after opening a graph.
// Example: node scripts/benchmark-canvas.mjs http://127.0.0.1:9333
// Uses Cytoscape's private container registration only for this diagnostic script.
// Simulated wheel events exercise viewport rendering; a fixed zoom sweep makes
// comparisons independent of wheel-device normalization. This is not a hardware-input test.
const endpoint = process.argv[2] || 'http://127.0.0.1:9333';
const tabs = await (await fetch(`${endpoint}/json`)).json();
const tab = tabs.find(tab => tab.type === 'page' && /^http/.test(tab.url));
if (!tab) throw new Error('Open the local app and a diagram in the debugging browser first.');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id;
  const timer = setTimeout(() => {
    pending.delete(next);
    reject(new Error(`Timed out: ${method}`));
  }, 30000);
  pending.set(next, message => {
    clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message);
  });
  ws.send(JSON.stringify({ id: next, method, params }));
});
const evaluate = async expression => {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.result.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result.result.value;
};
async function benchmark() {
  await send('Performance.enable');
  const info = await evaluate(`(() => {
    const cy = document.querySelector('.cy-canvas')._cyreg.cy;
    return { nodes: cy.nodes().length, edges: cy.edges().length, zoom: cy.zoom() };
  })()`);
  const before = await send('Performance.getMetrics');
  const frames = await evaluate(`new Promise(resolve => {
    const cy = document.querySelector('.cy-canvas')._cyreg.cy;
    const frames = [];
    let previous;
    let i = 0;
    const center = { x: cy.width() / 2, y: cy.height() / 2 };
    function tick(t) {
      if (previous !== undefined) frames.push(t - previous);
      previous = t;
      const rect = cy.container().getBoundingClientRect();
      cy.container().dispatchEvent(new WheelEvent('wheel', {
        deltaY: i < 90 ? -100 : 100,
        clientX: rect.left + center.x, clientY: rect.top + center.y,
        bubbles: true, cancelable: true,
      }));
      cy.zoom({
        level: 0.05 * Math.pow(20, (1 - Math.cos(i / 30)) / 2),
        renderedPosition: center,
      });
      if (++i < 180) requestAnimationFrame(tick);
      else {
        frames.sort((a, b) => a - b);
        resolve({
          median: frames[89], p95: frames[170], max: frames.at(-1),
          over33ms: frames.filter(t => t > 33.4).length,
          elapsed: frames.reduce((a, b) => a + b, 0),
        });
      }
    }
    requestAnimationFrame(tick);
  })`);
  const after = await send('Performance.getMetrics');
  const measured = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'];
  const metrics = Object.fromEntries(after.result.metrics
    .filter(metric => measured.includes(metric.name))
    .map(metric => [metric.name, Math.round(1000 * (metric.value -
      before.result.metrics.find(previous => previous.name === metric.name).value))]));
  return { info, frames, metrics };
}

try {
  const original = await evaluate(`(() => {
    const cy = document.querySelector('.cy-canvas')?._cyreg?.cy;
    if (!cy) throw new Error('Open a graph before benchmarking.');
    return { zoom: cy.zoom(), pan: cy.pan() };
  })()`);
  try {
    for (let trial = 0; trial < 3; trial++) console.log(JSON.stringify({ trial, ...await benchmark() }));
  } finally {
    await evaluate(`void document.querySelector('.cy-canvas')._cyreg.cy.viewport(${JSON.stringify(original)})`);
  }
} finally { ws.close(); }

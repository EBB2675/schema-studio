/**
 * The page's side of the static site's web worker: sends requests to the Python core and
 * reports whether the core is loading, so the page can say why the first answer takes a while.
 */
import type { CoreAnswer, CoreRequest } from "./pythonRunner";

export type CoreStatus = "idle" | "loading" | "ready" | "failed";

const listeners = new Set<(status: CoreStatus) => void>();
let status: CoreStatus = "idle";

function setStatus(next: CoreStatus) {
  status = next;
  for (const listener of listeners) listener(next);
}

export function coreStatus(): CoreStatus {
  return status;
}

export function onCoreStatus(listener: (status: CoreStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (answer: CoreAnswer) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id?: number; answer?: CoreAnswer; status?: CoreStatus }>) => {
    const { id, answer, status: next } = event.data;
    if (next) setStatus(next);
    if (id !== undefined && answer) {
      if (answer.status === 500 && answer.error?.startsWith("The in-browser schema engine failed")) setStatus("failed");
      pending.get(id)?.(answer);
      pending.delete(id);
    }
  };
  worker.onerror = (event) => {
    setStatus("failed");
    for (const resolve of pending.values()) resolve({ error: `The in-browser schema engine stopped: ${event.message}`, status: 500 });
    pending.clear();
    worker = null;
  };
  return worker;
}

function send(request?: CoreRequest): Promise<CoreAnswer> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ensureWorker().postMessage({ id, request });
  });
}

/** Run one request in the worker (starting Pyodide on first use). */
export function runInWorker(request: CoreRequest): Promise<CoreAnswer> {
  return send(request);
}

/** Start loading Pyodide in the background, before the first request needs it. */
export function warmUpWorker(): void {
  if (status === "idle") void send();
}

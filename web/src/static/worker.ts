/**
 * Web worker of the static site: loads Pyodide from the site itself and runs the Python core,
 * so the page stays responsive while graphs, edits and LinkML downloads are computed.
 *
 * Messages in: `{ id, request }`; out: `{ id, answer }`, or `{ status }` while Pyodide loads.
 */
import { createPythonRunner, type CoreRequest, type PyodideLike, type PythonRunner } from "./pythonRunner";

type LoadPyodide = (options: { indexURL: string }) => Promise<PyodideLike>;

const base = new URL(import.meta.env.BASE_URL, self.location.origin).href;
const dataBase = new URL("data/", base).href;
const pyodideBase = new URL("pyodide/", base).href;

let runner: Promise<PythonRunner> | null = null;

async function fetchText(path: string): Promise<string> {
  const response = await fetch(new URL(path, dataBase));
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.text();
}

function start(): Promise<PythonRunner> {
  runner ??= (async () => {
    self.postMessage({ status: "loading" });
    const { loadPyodide } = (await import(/* @vite-ignore */ `${pyodideBase}pyodide.mjs`)) as { loadPyodide: LoadPyodide };
    const pyodide = await loadPyodide({ indexURL: pyodideBase });
    const created = createPythonRunner(pyodide, fetchText);
    self.postMessage({ status: "ready" });
    return created;
  })();
  runner.catch(() => {
    runner = null;
  });
  return runner;
}

self.onmessage = async (event: MessageEvent<{ id: number; request?: CoreRequest }>) => {
  const { id, request } = event.data;
  try {
    const python = await start();
    if (!request) {
      self.postMessage({ id, answer: { ok: null } });
      return;
    }
    self.postMessage({ id, answer: await python.run(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, answer: { error: `The in-browser schema engine failed: ${message}`, status: 500 } });
  }
};

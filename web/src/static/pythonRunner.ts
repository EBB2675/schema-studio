/**
 * Runs the app's Python core (`api/sources/core.py` and the modules it uses) in Pyodide.
 *
 * The Python files are bundled as text from `api/sources/`, so the static site
 * runs the same code as the server. Used by the web worker, and directly by
 * the tests (Pyodide in Node).
 */
import browserSource from "../../../api/sources/browser.py?raw";
import coreSource from "../../../api/sources/core.py?raw";
import editsSource from "../../../api/sources/edits.py?raw";
import graphSource from "../../../api/sources/graph.py?raw";
import yamlSource from "../../../api/sources/linkml_yaml.py?raw";

export type CoreRequest = { op: string; snapshots: string[] } & Record<string, unknown>;
export type CoreAnswer = { ok?: unknown; error?: string; status?: number };

/** The part of a Pyodide instance the runner uses. */
export type PyodideLike = {
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
  runPython(code: string): unknown;
  loadPackage(names: string | string[]): Promise<unknown>;
  globals: { get(name: string): unknown };
};

const PACKAGE_DIR = "/home/pyodide/schema_core";
const SOURCES: Record<string, string> = {
  "__init__.py": "",
  "browser.py": browserSource,
  "core.py": coreSource,
  "edits.py": editsSource,
  "graph.py": graphSource,
  "linkml_yaml.py": yamlSource,
};

type PyCallable = ((...args: unknown[]) => unknown) & { destroy?: () => void };

export function createPythonRunner(pyodide: PyodideLike, fetchText: (path: string) => Promise<string>) {
  pyodide.FS.mkdirTree(PACKAGE_DIR);
  for (const [name, text] of Object.entries(SOURCES)) {
    pyodide.FS.writeFile(`${PACKAGE_DIR}/${name}`, text);
  }
  pyodide.runPython(`
import sys
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
from schema_core import browser as _schema_studio
`);
  const module = pyodide.globals.get("_schema_studio") as Record<string, PyCallable>;
  const hasSnapshot = module.has_snapshot;
  const addSnapshot = module.add_snapshot;
  const handle = module.handle;
  let yamlReady: Promise<unknown> | null = null;
  // One request at a time: Python is single threaded, and loading a snapshot must finish before use.
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (request: CoreRequest): Promise<CoreAnswer> => {
    for (const path of request.snapshots) {
      if (!hasSnapshot(path)) addSnapshot(path, await fetchText(path));
    }
    if (request.op === "linkml_yaml") {
      yamlReady ??= pyodide.loadPackage("pyyaml");
      await yamlReady;
    }
    return JSON.parse(String(handle(JSON.stringify(request)))) as CoreAnswer;
  };

  return {
    run(request: CoreRequest): Promise<CoreAnswer> {
      const next = queue.then(() => run(request));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export type PythonRunner = ReturnType<typeof createPythonRunner>;

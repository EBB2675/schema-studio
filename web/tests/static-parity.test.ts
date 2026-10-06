/**
 * The static backend (with the Python core in Pyodide) answers like the Light Mode server.
 *
 * Run by `api/sources/tests/test_browser.py`, which builds a small site, asks the server the
 * requests of `fixtures/static-parity-scenario.json` and hands over the answers; skipped
 * when run on its own.
 */
// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createEditStore } from "../src/static/editStore";
import { createStaticBackend, StaticHttpError } from "../src/static/backend";
import { createPythonRunner, type PyodideLike } from "../src/static/pythonRunner";

const dir = process.env.STATIC_PARITY_DIR;
const site = process.env.STATIC_PARITY_SITE;
const pyodideDir = process.env.STATIC_PARITY_PYODIDE;

type Step = {
  method: string;
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
  compare?: string[];
  compare_without?: string[];
};
type Answer = { status: number; data: unknown };

function without(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map(item => without(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)).map(([key, item]) => [key, without(item, keys)]));
  }
  return value;
}

function shown(step: Step, answer: Answer): unknown {
  let data = answer.data;
  if (step.compare && data && typeof data === "object") {
    data = Object.fromEntries(step.compare.map(key => [key, (data as Record<string, unknown>)[key]]));
  }
  return { status: answer.status, data: step.compare_without ? without(data, step.compare_without) : data };
}

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

describe.skipIf(!dir || !site || !pyodideDir)("static backend", () => {
  it("answers the scenario like the Light Mode server", async () => {
    const { scenario, answers } = JSON.parse(await readFile(join(dir!, "expected.json"), "utf8")) as { scenario: Step[]; answers: Answer[] };
    const { loadPyodide } = await import("pyodide");
    const pyodide = (await loadPyodide({ indexURL: `${pyodideDir!}/` })) as unknown as PyodideLike;
    const runner = createPythonRunner(pyodide, (path) => readFile(join(site!, path), "utf8"));
    const storage = new MemoryStorage();
    // The server starts on the default profile's default module; so does the site's workspace.
    const backend = createStaticBackend({
      readJson: async (path) => JSON.parse(await readFile(join(site!, path), "utf8")),
      runCore: (request) => runner.run(request),
      storage,
      edits: createEditStore(storage),
    });
    for (const [index, step] of scenario.entries()) {
      let answer: Answer;
      try {
        answer = await backend.request(step.method, step.path, step.params ?? {}, step.body);
      } catch (error) {
        if (!(error instanceof StaticHttpError)) throw error;
        answer = { status: error.status, data: { detail: error.detail } };
      }
      expect(shown(step, answer), `step ${index}: ${step.method} ${step.path}`).toEqual(shown(step, answers[index]));
    }
  }, 300_000);
});

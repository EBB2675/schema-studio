// @vitest-environment node
// The Python test supplies snapshots and CPython answers to verify the browser runtime.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPythonRunner, type CoreRequest, type PyodideLike } from "../src/static/pythonRunner";

const dir = process.env.STATIC_PARITY_DIR;
const site = process.env.STATIC_PARITY_SITE;
const pyodideDir = process.env.STATIC_PARITY_PYODIDE;

describe.skipIf(!dir || !site || !pyodideDir)("browser Python runtime", () => {
  it("matches CPython for graph, sections and YAML requests", async () => {
    const { requests, answers } = JSON.parse(await readFile(join(dir!, "expected.json"), "utf8")) as { requests: CoreRequest[]; answers: unknown[] };
    const { loadPyodide } = await import("pyodide");
    const pyodide = await loadPyodide({ indexURL: `${pyodideDir!}/` }) as unknown as PyodideLike;
    const runner = createPythonRunner(pyodide, path => readFile(join(site!, path), "utf8"));
    for (const [index, request] of requests.entries()) {
      expect(await runner.run(request), request.op).toEqual(answers[index]);
    }
  }, 120_000);
});

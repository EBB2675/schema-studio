# Repository guide

## Runtime

`web/src/App.tsx` coordinates schema selection, graph filters, editing, exports, and responsive panels. `FlowGraphView.tsx` is the sole canvas, using `@xyflow/react`. Its card layout lives in `utils/arrangeGraph.ts`; stored positions and placement of newly revealed classes live in `utils/canvasPositions.ts` and `utils/canvasPlacement.ts`.

`web/src/client.ts` routes every application request to the browser-local backend in `static/backend.ts`. The backend reads `data/index.json`, profile snapshots, and precomputed graphs beneath Vite's base path. No application API service is required.

Edits are stored by `static/editStore.ts` in browser storage. Saves hold an exclusive edit-store transaction from reading existing edits and assigning IDs through Python validation and persistence; deletes and imports use the same queue. Web Locks coordinate storage mutations in cooperating tabs on the same origin; they do not refresh the graph or edit history in other tabs, so cross-tab editing is not fully supported. Without Web Locks, serialization covers only the current page, so use a single tab for editing. This does not repair duplicate IDs in previously saved logs. After a storage-write failure, the current store keeps its newer in-memory log authoritative until a later mutation successfully saves the whole log. A persistent warning offers an edit-log backup; use only that tab while changes are unsaved, because recovery does not merge writes from other tabs. `static/workerCore.ts` communicates with `static/worker.ts`, which loads Pyodide from the site's `pyodide/` directory. `static/pythonRunner.ts` bundles the Python core files as text and installs them in the worker's virtual filesystem. The engine handles graph reconstruction, edit validation, and LinkML exports.

Color themes and UML/Edit canvas controls are presentation choices within this single static application.

## Snapshot pipeline

The `api/` directory contains Python library code, despite its historical directory name. It has no HTTP entry point.

- `api/sources/schema_source.py`: profile catalogue, environment selection, and installed schema metadata.
- `api/sources/snapshots.py`: extraction, conversion, and build-time snapshot cache.
- `api/sources/to_linkml/`: NOMAD/BAM extraction-document converters.
- `api/sources/core.py`, `graph.py`, `edits.py`, `browser.py`, `linkml_yaml.py`: portable Python graph/edit/export engine.
- `extractor/contract.py` and `contract.schema.json`: validated extraction-document format.
- `extractor/scripts/nomad.py` and `bam.py`: extraction inside isolated schema environments.
- `environments/`: uv projects following each schema's configured source branch.
- `scripts/build_snapshots.py`: writes the static data index, snapshots, and optional initial graphs.

Schema packages are imported only in their own environments. The build environment and browser do not import them. `SCHEMA_STUDIO_HOME` can override the build cache root, and `SCHEMA_STUDIO_ENVIRONMENTS_DIR` can override the environment directory (see the profile module).

The extractor's reference graph builder and comparison fixtures remain as extraction regression coverage; they are not frontend renderers or application runtime modes.

## Tests and deployment

`web/tests/` covers React Flow editing, app orchestration, browser storage, static routing, and graph utilities. `api/sources/tests/` covers the Python core and snapshot builds. Its browser integration test invokes `web/tests/static-parity.test.ts` with fixture snapshots to compare CPython and Pyodide answers.

`.github/workflows/ci.yml` validates the static application and Python libraries without external services. `.github/workflows/pages.yml` prepares the full production snapshot set and publishes `web/dist` to GitHub Pages. See the root README for commands.

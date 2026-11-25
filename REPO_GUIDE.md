# Repository guide

## Runtime

`web/src/hooks/useAuditTrail.ts` owns optional history storage, legacy-entry migration, and edit-generation filtering. The edit store owns durable edits; history must not become a second source of truth. `utils/auditValidation.ts` validates all stored change payloads, nested class/quantity snapshots, and undo metadata. Malformed entries are discarded individually while valid neighboring entries are retained; the underlying edit log is untouched. `utils/auditReplay.ts` owns pure graph transformations for local history. Callers exclude stored edits from replay because the Python core already applies them.

`hooks/useWorkspaceNavigation.ts` owns workspace initialization, profile discovery and selection, package/root defaults, and synchronization with the browser backend. It initializes from the hydrated workspace store and keeps response epochs private to this boundary so older responses cannot replace a newer workspace selection.

`hooks/useGraphNavigation.ts` owns graph loading, overview/class navigation, displayed and baseline graphs, expansion intent, and canvas request freshness. Edit commands capture its canvas context before saving, then commit the returned graph through `commitMutationGraph` or reload using the latest navigation options. Expansion refs stay private to the hook. Navigation callbacks clear transient editing UI without moving persistence into navigation.

`web/src/App.tsx` composes these hooks with graph filters, edit commands, imports/exports, selection, and responsive panels. Scratch reset remains an edit command because it deletes persisted edits. `FlowGraphView.tsx` is the sole canvas, using `@xyflow/react`. Its card layout lives in `utils/arrangeGraph.ts`; stored positions and placement of newly revealed classes live in `utils/canvasPositions.ts` and `utils/canvasPlacement.ts`.

`utils/canvasSession.ts` owns canvas identity and freshness checks. Starting a read supersedes earlier reads; navigation invalidates both reads and the editing context. Successful edits can invalidate reads without cancelling other edits in the same context. Root renames update identity without ending the context. App orchestration uses captured freshness checks before applying asynchronous results.

`utils/exportPdf.ts` is imported only after a PDF export is requested and PNG capture succeeds. PDF dependencies stay out of the startup bundle; capture, module loading, and PDF generation failures are reported by the app.

`web/src/client.ts` routes every application request to the browser-local backend in `static/backend.ts`. The backend reads `data/index.json`, profile snapshots, and precomputed graphs beneath Vite's base path. No application API service is required.

Edits are stored by `static/editStore.ts` in browser storage. Saves hold an exclusive edit-store transaction from reading existing edits and assigning IDs through Python validation and persistence; deletes and imports use the same queue. Web Locks coordinate storage mutations in cooperating tabs on the same origin; they do not refresh the graph or edit history in other tabs, so cross-tab editing is not fully supported. Without Web Locks, serialization covers only the current page, so use a single tab for editing. This does not repair duplicate IDs in previously saved logs.

After a storage-write failure, the current store keeps its newer in-memory log authoritative until Retry saving or a later mutation successfully saves the whole log. Unreadable or malformed persistent logs block reads and mutations rather than being treated as empty. Optional UI preferences use best-effort storage helpers and cannot interrupt editing. A persistent warning offers an edit-log backup and a retry button, and a conditional beforeunload handler requests browser confirmation before leaving with unsaved changes. History offers Restore backup with explicit confirmation to replace the complete edit log across schemas, including deletions, and clears the previous undo history across all schemas so reused edit IDs cannot target unrelated edits. Each restoration creates a fresh generation identifier stored atomically with the edit log. Undo entries carry that generation, and reopening discards entries from a different generation even if clearing persisted history failed. Logs and history created before generation tracking share a legacy generation until their first restoration. Load edits remains additive and preserves both generation and undo history. If the localStorage getter was inaccessible when the store was created, that store stays memory-only: Retry saving cannot reacquire storage. Download a backup, enable storage, reload the application, and use Restore backup. Browser exit prompts are subject to browser support. For recovery, use only that tab while changes are unsaved, because recovery does not merge writes from other tabs.

`static/workerCore.ts` communicates with `static/worker.ts`, which loads Pyodide from the site's `pyodide/` directory. `static/pythonRunner.ts` bundles the Python core files as text and installs them in the worker's virtual filesystem. The engine handles graph reconstruction, edit validation, and LinkML exports.

Color themes and canvas controls are presentation choices within this single static application. Editing availability depends on the selected graph; there is no separate editing-mode toggle.

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

`.github/workflows/ci.yml` is both a standalone and reusable verification workflow: lint, frontend tests, Python tests including Pyodide parity, production build, fixture snapshots, and Chromium smoke tests. `web/e2e/build_fixtures.py` substitutes checked-in extraction documents into the production snapshot writer; it is never used for deployment data. `web/e2e/smoke.spec.ts` runs against the actual built app without mocking storage, the backend, or the worker.

`.github/workflows/pages.yml` calls CI as its required `verify` job before building the full production snapshot set. It then runs the browser suite against that complete artifact before upload and deployment. Failing checks prevent deployment. Browser failure diagnostics are retained as Actions artifacts. The upstream schema refresh policy is unchanged. See the root README for commands.

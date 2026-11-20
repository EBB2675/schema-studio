# SchemaStudio Editor — Frontend (React + Vite)

Interactive UML-style editor for NOMAD schema packages. The UI consumes the FastAPI backend at `http://localhost:5179` and renders section graphs with Cytoscape + ELK, with inline edit capabilities.

## Quick start

```bash
cd web
npm install
npm run dev -- --host 0.0.0.0 --port 5173
# Requires Node 20.19+ (or 22.12+) for Vite.
```

The repo root provides `./dev.sh` to start both backend (**5179**) and frontend (**5173**) together after verifying environment variables.

## Environment defaults

These Vite env vars (see `App.tsx`) control the initial workspace:

- `VITE_DEFAULT_PACKAGE` — fallback module (defaults to `nomad_simulations.schema_packages.model_method`).
- `VITE_DEFAULT_NAMESPACE` — comma-separated base namespaces for package discovery (`nomad_simulations.schema_packages` by default).
- `VITE_DEFAULT_ROOT` — default root section (`ModelMethod`).
- `VITE_DEFAULT_BRANCH` — default branch for overview/package discovery (`develop`).
- `VITE_STATIC_MODE` — `true` builds the static site (no server; see the root README); `VITE_BASE_PATH` sets the path it is served under. `npm run build:pages` sets both from `.env.pages` and copies Pyodide into `dist/pyodide/` (`scripts/copy-pyodide.mjs`).

## Notable UI features

- Diagram builder for the working tree or a selected branch (`/schema` vs `/graph`).
- Branch comparison banner using `/graph/diff`.
- Overview mode listing packages/classes by branch.
- Editable mode to add classes (inheritance or subsection links), add/rename/remove quantities and, for bam-masterdata, properties and vocabulary terms. Every change is stored on the server through `/schema/edits` as an edit of the LinkML schema; the server returns the graph rebuilt from the edited schema.
- Doc panel + under-the-hood panel for docstrings and normalization helpers.
- Export buttons for JSON and PDF (PNG-backed via `GraphView` `toPng`).
- Theme toggle (dark/light) and namespace / cross-module filters.

## Key files

- `src/App.tsx` — sidebar controls, API calls, diff handling, overview toggle, export + editable mode wiring.
- `src/client.ts` — the only module that talks to the backend: over HTTP, or in a static build to `src/static/backend.ts`.
- `src/static/` — the static site's backend in the browser, edit store and the web worker running the Python core with Pyodide.
- `src/GraphView.tsx` — Cytoscape renderer with ELK layout, diff overlays, export handle.
- `src/components/DocPanel.tsx` — class/quantity docs with inline edit/remove when editable.
- `src/components/OverviewGrid.tsx` — bird’s-eye packages/classes table.
- `src/components/UnderTheHoodPanel.tsx` — normalize/helper list from `/usage`.
- `src/components/AddQuantityForm.tsx`, `src/components/QuantityEditPanel.tsx` — quantity add/edit/remove UI.
- `src/store/selection.ts` — Zustand selection store.

## Static canvas prototype

GitHub Pages builds open schemas in the **New editor**, a React Flow canvas using
that same browser schema engine and edit store. Use **Classic** to compare the old
canvas. Dev Mode keeps its existing renderer.

- Double-click a class title to rename it (Enter saves, Escape cancels).
- Double-click an owned quantity to edit its name, type and description.
- Add quantities on a card and classes from the top-right toolbar.
- Inherited quantities remain read-only; click them for documentation.
- Drag cards to position them; **Arrange** recalculates the layout. Ordinary edits
  keep positions. Opening an inline form brings that card into view.
- Schema edits persist through the existing browser edit store. Box positions are also saved
  in this browser, per schema profile, package and layout direction. They survive
  reopening, reloads and switching back from Classic. **Arrange** replaces the saved
  arrangement with an automatic layout. Positions are local to this browser and
  are not included in schema or edit-log exports.

On screens up to 900px wide, the static app uses a full-width canvas, a Workspace
drawer, a Tools menu and a Details bottom sheet. Touch screens support tapping a
class name or owned quantity to edit it. Quantity and new-class forms open as
unscaled modal sheets with larger controls. Inherited quantities stay read-only.
The desktop panel widths and collapse state are kept separately from mobile panels.

`src/FlowGraphView.tsx` and `src/flow-editor.css` implement the prototype. The
existing details panel, edit downloads, LinkML export and PDF export remain wired
through `App.tsx`. Relationships are created through class parent/subsection
choices and schema properties; freehand edge editing is not implemented.

After building and preparing snapshots as described in the root README, preview
with the Pages base path enabled:

```bash
npm run preview -- --mode pages
```

## Testing & linting

- Vitest + @testing-library with `happy-dom` powers UI flow tests.
- `npm run test` (watch) or `npm run test:run` (CI-friendly) to run the suite.
- `npm run test:contracts` runs the API contract/identifier checks under Vitest.
- `npm run build` validates TypeScript + Vite configuration.
- `tests/static-parity.test.ts` compares the static backend with the Light Mode server; it is run by `api/sources/tests/test_browser.py` and skipped on its own.

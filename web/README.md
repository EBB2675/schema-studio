# SchemaStudio Editor — Frontend (React + Vite)

Interactive UML-style editor for NOMAD schema packages. The UI consumes the FastAPI backend at `http://localhost:5179` and renders section graphs with Cytoscape + ELK, with inline edit capabilities.

## Quick start

```bash
cd web
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

The repo root provides `./dev.sh` to start both backend (**5179**) and frontend (**5173**) together after verifying environment variables.

## Environment defaults

These Vite env vars (see `App.tsx`) control the initial workspace:

- `VITE_DEFAULT_PACKAGE` — fallback module (defaults to `nomad_simulations.schema_packages.model_method`).
- `VITE_DEFAULT_NAMESPACE` — comma-separated base namespaces for package discovery (`nomad_simulations.schema_packages` by default).
- `VITE_DEFAULT_ROOT` — default root section (`ModelMethod`).
- `VITE_DEFAULT_BRANCH` — default branch for overview/package discovery (`develop`).

## Notable UI features

- Diagram builder for the working tree or a selected branch (`/schema` vs `/graph`).
- Branch comparison banner using `/graph/diff`.
- Overview mode listing packages/classes by branch.
- Editable mode to add classes and add/rename/remove quantities (uses `/schema/custom-class` and `/schema/custom-quantity`; the backend materializes synthetic sections for new classes so quantities can be attached immediately).
- Doc panel + under-the-hood panel for docstrings and normalization helpers.
- Export buttons for JSON and PDF (PNG-backed via `GraphView` `toPng`).
- Theme toggle (dark/light) and namespace / cross-module filters.

## Key files

- `src/App.tsx` — sidebar controls, API calls, diff handling, overview toggle, export + editable mode wiring.
- `src/GraphView.tsx` — Cytoscape renderer with ELK layout, diff overlays, export handle.
- `src/components/DocPanel.tsx` — class/quantity docs with inline edit/remove when editable.
- `src/components/OverviewGrid.tsx` — bird’s-eye packages/classes table.
- `src/components/UnderTheHoodPanel.tsx` — normalize/helper list from `/usage`.
- `src/components/AddQuantityForm.tsx`, `src/components/QuantityEditPanel.tsx` — quantity add/edit/remove UI.
- `src/store/selection.ts` — Zustand selection store.

## Testing & linting

This package relies on Vite defaults. Add your preferred test runner or linter as needed; `npm run build` will validate TypeScript + Vite configuration.

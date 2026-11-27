# Schema Studio

Schema Studio is a static schema browser and editor built with React Flow. It runs entirely in the browser and is published on GitHub Pages. Schema snapshots are generated at build time; a Pyodide worker handles graph expansion, edits, and LinkML exports locally.

Supported schemas are NOMAD simulations, NOMAD measurements, and BAM masterdata v0/v1. The v1 profile follows a draft branch. Profiles without released modules are shown as unavailable.

## Use the app

Choose a schema and class, or start with an empty canvas. Inspect and edit UML classes, expand subclasses, move cards, and use Arrange or Fit to view. The diagram supports four layout directions, light and dark color themes, and mobile panels.

Edits, audit history, workspace selection, and card positions stay in browser storage. Export the edit log to keep a portable backup; import it to resume elsewhere. Diagrams can be exported as PNG/PDF, and schemas as JSON or LinkML YAML. Snapshot updates are picked up when the site is rebuilt.

## Local development

Requirements: Node.js 24, Python 3.11+, and uv.

```sh
uv sync --locked --python 3.11
npm --prefix web ci
```

Prepare the isolated environments used to extract each schema:

```sh
uv sync --locked --project environments/nomad-simulations
uv sync --locked --project environments/nomad-measurements
uv sync --locked --project environments/bam-masterdata
uv sync --locked --project environments/bam-masterdata-v1
```

Build snapshots and browser Python assets for the Vite development server:

```sh
uv run python scripts/build_snapshots.py --out web/public/data --graphs
node web/scripts/copy-pyodide.mjs web/public
npm --prefix web run dev
```

The development server serves the same static application. Python is used only for snapshot preparation and tests; it does not serve requests.

## GitHub Pages

Set the repository's Pages source to **GitHub Actions**. The workflow in `.github/workflows/pages.yml` first runs the reusable CI verification pipeline, then builds the frontend, refreshes the schema environments, generates snapshots, and smoke-tests the complete `web/dist` artifact in Chromium before uploading it. Deployment depends on both verification and the successful artifact build. It runs on pushes to `develop`, published releases, nightly, or manually.

`web/.env.pages` sets the project URL prefix to `/schema-studio/`. Change `VITE_BASE_PATH` for another repository, or use `/` for a user/organization root site. Assets, snapshots, and Pyodide resolve relative to this prefix.

To prepare the same artifact locally:

```sh
npm --prefix web run build:pages
uv run python scripts/build_snapshots.py --out web/dist/data --graphs
npm --prefix web run preview -- --host 127.0.0.1
```

Open the preview at `/schema-studio/`. Always generate snapshots after the build, because Vite clears `dist`.

## Verification

```sh
npm --prefix web run lint
npm --prefix web run test:run
uv run pytest api/sources/tests extractor/tests
npm --prefix web run build:pages
```

The Python suite includes snapshot generation from fixtures and CPython/Pyodide parity. Tests marked `slow` require the real schema environments and can be run with `uv run pytest -m slow`.

### Browser smoke tests

The smoke suite serves the production build at the Pages base path using a fresh Chromium context, the real Web Worker, and Pyodide. It opens every available schema profile and checks class creation, reload, undo, backup restoration, and PDF download. CI uses checked-in extraction fixtures; Pages runs the same tests with the actual generated snapshots before upload.

For a local fixture-based run, after installing the development dependencies:

```sh
npm --prefix web exec -- playwright install chromium
npm --prefix web run build:pages
uv run python web/e2e/build_fixtures.py --out web/dist/data
npm --prefix web run test:smoke
```

To test real snapshots, use `scripts/build_snapshots.py --out web/dist/data --graphs` instead of the fixture builder. The fixture builder refuses to overwrite a nonempty data directory. Rebuilding the frontend clears `dist`, so generate data afterward.

The test runner starts and stops its own preview server on port 4173 and does not reuse an existing server. Failed tests retain screenshots, traces, and browser diagnostics in `web/test-results/`; the HTML report is in `web/playwright-report/`. CI uploads these on failure for seven days. Browser installation on Linux CI includes system dependencies (`playwright install --with-deps chromium`); see the [Playwright CI guide](https://playwright.dev/docs/ci).

See [REPO_GUIDE.md](REPO_GUIDE.md) for the source structure and [PLUGIN_RULES.md](PLUGIN_RULES.md) for adding a schema profile. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md); the project is licensed under [MIT](LICENSE).

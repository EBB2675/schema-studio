# REPO GUIDE — Schema-UML

A structured overview of the repository for developers to navigate, understand, and extend the project.

---

## 0) TL;DR 

**Purpose:** Interactive editor for data models with two runtime modes:
- **Light Mode**: pip-installable local mode (single user, SQLite persistence, no Mongo/Redis required).
- **Dev Mode**: full branch-aware mode (auth + Mongo + optional Celery/Redis + git worktrees/diff).
Both modes support schema graphing, docs/usage inspection, custom class/quantity edits, inherited member projection for `is_a` relationships, overview mode, and empty-canvas editing.

**Frontend:** React + TypeScript + Cytoscape + ELK  
**Backend:** FastAPI
- Dev Mode: async/Motor + GitPython + MongoDB + Celery (Redis)
- Light Mode: local FastAPI + SQLite + installed schema package sourcing
**Python:** 3.11 recommended/tested (package requires >=3.11).

**Main directories:**
- `web/` — frontend React app  
- `api/` — FastAPI backend  
- `api/light_mode/` — Light Mode app, schema source policy, local store, CLI  
- `extractor/` — schema graph & usage extractor  
- `scripts/` — maintenance helpers (including Light Mode static asset sync)
- `api/_data/` — auto-generated bare mirror + worktrees (Dev Mode git features)

**Key endpoints:**
- Dev Mode:
  - Auth/workspace/health: `POST /auth/login`, `POST /auth/register`, `GET /workspace`, `PUT /workspace`, `GET /health`, `GET /`
  - Branch-aware graphing: `POST /graph`, `POST /graph/diff`, `GET /git/branches`, `GET /git/packages`
  - Async tasks: `POST /tasks/graph`, `POST /tasks/graph/diff`, `GET /tasks/{id}`
  - Shared: `GET /roots`, `GET /schema`, `GET /overview`, `GET /usage`, custom edit endpoints
- Light Mode:
  - Core: `GET /health`, `GET /workspace`, `PUT /workspace`, `GET /roots`, `GET /schema`, `GET /overview`, `GET /usage`
  - Custom edits: `POST /schema/custom-class`, `POST /schema/custom-quantity`, `DELETE /schema/custom-edits`, `DELETE /schema/custom-edit`
  - Schema versioning/update: `GET /schema/version`, `POST /schema/update`
  - Submission: `POST /send-design`
  - `GET /git/packages` works with fixed branch policy; `GET /git/branches` returns `410` (disabled).

Shared query flags for `/schema` and related graph endpoints: `include_quantities`, `include_subsections`, `include_inheritance`, `allow_cross_module`, `base_namespace`, `root`, and `empty` (empty-canvas mode).

**Authentication (Dev Mode only):**
- Every endpoint (except `/auth/login` and `/auth/register`) requires a bearer token:
  - `SCHEMA_UML_DEFAULT_USER` (default `admin`)
  - `SCHEMA_UML_DEFAULT_PASSWORD` (default `admin`)

**Essential env (Dev Mode):**
~~~bash
# schema repo (required)
export SCHEMA_UML_REPO=/path/to/your-schema
# Mongo
export SCHEMA_UML_MONGO_URI=mongodb://localhost:27017
export SCHEMA_UML_MONGO_DB=schema_uml
# Celery / Redis (for async tasks)
export CELERY_BROKER_URL=redis://localhost:6379/0
export CELERY_RESULT_BACKEND=redis://localhost:6379/1
~~~
Optional defaults: `SCHEMA_UML_BASE_PACKAGE`, `SCHEMA_UML_PACKAGE`. Legacy `NOMAD_SIM_REPO` / `GIT_REPO_DIR` still work.
Default namespace scope targets `nomad_simulations.schema_packages`. For other projects, set `SCHEMA_UML_BASE_PACKAGE` to your namespace root (comma separated for multiple roots) and ensure each namespace exists in the repo you configured.

**Essential env (Light Mode):**
~~~bash
# optional endpoint for "Send design"
export SCHEMA_STUDIO_SEND_ENDPOINT=https://your-endpoint.example/api
# optional frontend override
export SCHEMA_STUDIO_DIST_DIR=/abs/path/to/web/dist
# optional: disable first-run auto bootstrap (default enabled)
export SCHEMA_STUDIO_AUTO_BOOTSTRAP_SCHEMA=0
~~~
`Send Design` UI is shown only when `SCHEMA_STUDIO_SEND_ENDPOINT` is set.

**Start it quickly:**
- Light Mode: `pip install -e . && schema-studio`
- Docker Compose (Dev Mode one shot): set `.env` with `SCHEMA_UML_REPO_HOST`, secrets, then `docker compose up --build`.
- Local dev (Dev Mode): `./dev.sh` (API + web). For real async tasks, also run Redis and a Celery worker with the broker/backends above; otherwise Celery runs eagerly in-process. Override ports via `API_PORT` / `WEB_PORT`.

**UX highlights:**
- UML cards show **sections**; **quantities** appear as attributes inside the card (not separate nodes).
- Right **Doc Panel** shows the **class docstring** and a **clickable list of quantities**; clicking a quantity shows its docstring.
- Right **Audit trail** panel tracks edit history, archive/restore state, and export/reset actions.
- Left sidebar **Under-the-hood** panel shows **normalization methods and helper functions** that act on the selected section (based on `/usage`).
- **Editable mode**: add classes (inheritance or subsection links) and add/rename/remove quantities; dtype validated against allowlist; custom classes get fully qualified ids so quantities work immediately.
- New classes linked with `inherits` (`is_a`) automatically surface inherited quantities/subsections in the UML and doc panels.
- Inherited quantities are read-only on child classes (edit/remove/redefine is blocked).
- **Bird’s-eye overview** renders packages/classes without building the full graph.
- **Overlays**: inheritance defaults on; dtype/shape labels toggleable.
- Workspace includes **Show base sections** (default off) to hide/show framework/base hierarchy in the canvas.
- **Exports**: download the current graph JSON or a PDF snapshot.
- Branch diff highlights (Dev Mode only): 🟩 Added, 🟨 Changed, 🟥 Removed (edges dashed red; quantity deltas are included).
- **Empty canvas**: start from `<base>.custom_schema`, edit freely, and reset persisted custom edits when needed (UI calls `/schema/custom-edits`).

**Custom edit model (important for agents):**
- Custom edits are persisted server-side per mode:
  - Dev Mode: Mongo (per user + branch + package).
  - Light Mode: local SQLite (single user, fixed `develop` branch policy).
- Backend replays persisted edits onto freshly built graphs and reports conflicts in `edit_conflicts` when applicable.
- Frontend audit trail is UI history and replay support; hard reset uses `DELETE /schema/custom-edits`.

**API compatibility headers:**
- Frontend sends `X-Schema-UML-Version` and `X-Schema-UML-Features` so backends can gate behavior across different schema repos.

**Typing/normalization helpers (frontend):**
- `src/types/api.ts` enforces runtime parsing of graph/diff payloads.
- `src/utils/identifier.ts` normalizes ids/labels/fqids used across GraphView, DocPanel, and selection store.
- `src/utils/umlState.ts` builds effective UML state (including inherited quantities/subsections) from backend graph payloads.
- `src/utils/errors.ts` standardizes API error formatting.

**Workspace state:**
- Stored in `src/store/workspace.ts` (branch/pkg/base namespace/startEmpty), synced with backend `/workspace` where available and persisted locally for reloads.
- In Light Mode, branch is fixed to `develop` by backend policy.

**Contract tests:**
- `npm run test:run` (from `web/`) executes frontend UI flows + contract parsing/identifier checks using Vitest + happy-dom.
- `npm run test:contracts` runs only the contract/identifier subset.
- Custom classes: `POST /schema/custom-class` with `relation` (`inherits` | `hasSubSection`), always assigns id `{package}.{name}`; adds parent edge if provided.
- Custom quantities: `POST /schema/custom-quantity` with `class_name` (label), optional `parent_name`/`parent_relation` to reattach parent edge if the class must be materialized server-side.
- Custom quantities cannot redefine an inherited ancestor quantity on a child class (server validation).
- Frontend keeps an audit trail and replays all prior edits onto each fresh server graph so earlier custom edges don’t disappear when adding new ones.

---

## 1) Repository Structure

~~~text
schema-studio/
├─ api/                         # FastAPI backend
│  ├─ main.py                   # Dev Mode app entry (/schema, /overview, /usage, auth/workspace)
│  ├─ routes_git.py             # Dev Mode git endpoints: /git/branches, /git/packages, /graph, /graph/diff
│  ├─ graph_runner.py           # Runs extractor in a worktree subprocess
│  ├─ git_utils.py              # Dev Mode bare mirror & worktree management
│  ├─ diff.py                   # Graph comparison logic (Dev Mode diff endpoints)
│  ├─ light_mode/               # Light Mode backend
│  │  ├─ app.py                 # Light Mode API (no auth, fixed-branch policy, send-design)
│  │  ├─ schema_source.py       # Installed schema package sourcing + /schema/update policy
│  │  ├─ store.py               # Local SQLite workspace/custom edit store
│  │  ├─ cli.py                 # `schema-studio` entrypoint
│  │  └─ tests/                 # Light Mode backend tests (no Mongo dependency)
│  ├─ _data/                    # Dev Mode auto-generated bare mirror & worktrees (gitignored)
│  └─ requirements.txt
│
├─ extractor/
│  ├─ graph_builder.py          # build_graph(package, **opts); embeds docstrings
│  ├─ usage_index.py            # get_usage_for_section(section_qualname) for /usage
│
├─ web/                         # React frontend (Vite)
│  ├─ src/
│  │  ├─ App.tsx                # Sidebar, API calls, diff banner, overview, export
│  │  ├─ GraphView.tsx          # Cytoscape UML renderer (sections only; quantities folded)
│  │  ├─ components/
│  │  │  ├─ DocPanel.tsx        # Class/quantity docstrings; quantity list (clickable)
│  │  │  ├─ OverviewGrid.tsx    # Bird’s-eye view of packages and classes at a branch
│  │  │  └─ UnderTheHoodPanel.tsx # Shows normalize methods/helpers for selected section
│  │  ├─ store/
│  │  │  └─ selection.ts        # Zustand store for selected item (class or quantity)
│  │  ├─ utils/
│  │  │  └─ umlState.ts         # Effective UML state with inherited quantities/subsections
│  │  └─ index.css
│  ├─ index.html
│  └─ package.json
│
├─ README.md                    # Quick start, features, troubleshooting
└─ REPO_GUIDE.md                
~~~

---

## 2) Data Contracts

### 2.1 Graph JSON (`GET /schema` → consumed by frontend)

Example (shortened):

~~~json
{
  "package": "nomad_simulations.schema_packages.model_method",
  "root": "ModelMethod",
  "nodes": [
    {
      "id": "nomad_simulations.schema_packages.model_method.ModelMethod",
      "kind": "section",
      "label": "ModelMethod",
      "module": "nomad_simulations.schema_packages.model_method",
      "doc": "Section docstring here...",
      "methods": ["normalize", "validate"]
    },
    {
      "id": "nomad_simulations.schema_packages.model_method.ModelMethod.determinant",
      "kind": "quantity",
      "label": "determinant",
      "owner": "nomad_simulations.schema_packages.model_method.ModelMethod",
      "dtype": "Enum(restricted, unrestricted, restricted-open-shell)",
      "shape": null,
      "card": null,
      "doc": "The spin-coupling form of the determinant used for ..."
    }
  ],
  "edges": [
    {
      "source": "nomad_simulations.schema_packages.model_method.ModelMethod",
      "target": "nomad_simulations.schema_packages.model_method.BasisSetContainer",
      "type": "hasSubSection",
      "card": "0..*"
    }
  ]
}
~~~

**Notes**

- `kind ∈ {"section","quantity"}`.  
- Quantities include `doc`; optional source metadata (`path`, `line`) may be present and is shown by the frontend when available.  
- The frontend does not render quantity nodes on the canvas; it folds them into each section’s card and into the Doc Panel.  
- Section `id` is always a fully qualified class name, e.g. `nomad_simulations.schema_packages.model_method.DFT`.

### 2.2 Diff JSON (`POST /graph/diff`)

~~~json
{
  "base": { "branch": "develop", "sha": "abc123", "graph": {} },
  "head": { "branch": "feature", "sha": "def456", "graph": {} },
  "diff": {
    "nodes": {
      "added":   [{ "id": "X", "kind": "section" }],
      "removed": [{ "id": "Y", "kind": "section" }],
      "changed": [{ "id": "Z" }]
    },
    "edges": {
      "added":   [{ "source": "A", "target": "B", "type": "hasSubSection" }],
      "removed": [{ "source": "C", "target": "D", "type": "hasSubSection" }]
    }
  }
}
~~~

**Frontend rendering policy**

- Added sections → green border (`.diff-added`)
- Changed sections → amber border (`.diff-changed`)
- Removed sections/edges → shown in the diff banner/summary (removed edges dashed red)
- Quantity changes are represented as `kind="quantity"` entries within the same `diff.nodes` structure; `nodes.changed` may carry `before`/`after` payloads for quantity metadata.

### 2.3 Usage JSON (`GET /usage` → used by Under-the-hood panel)

~~~json
{
  "usage": [
    {
      "kind": "normalize_method",
      "qualname": "nomad.datamodel.data.Section.normalize",
      "module": "nomad.datamodel.data",
      "short_name": "normalize",
      "doc": "Is called during entry normalization."
    },
    {
      "kind": "normalize_function",
      "qualname": "nomad_simulations.schema_packages.model_method.normalize_dft",
      "module": "nomad_simulations.schema_packages.model_method",
      "short_name": "normalize_dft",
      "doc": "Normalize DFT-related fields for the DFT section."
    }
  ],
  "workspace": {
    "branch": "develop",
    "package": "nomad_simulations.schema_packages.model_method",
    "base_namespace": "nomad_simulations.schema_packages"
  }
}
~~~

**Notes**

- Request: `GET /usage?section_id=<fully-qualified-section-class-name>`
  Example: `section_id=nomad_simulations.schema_packages.model_method.DFT`
- Response elements:
  - `kind`: `"normalize_method"`, `"normalize_function"`, or `"utility_function"`.  
  - `qualname`: fully-qualified Python name of the callable.  
  - `module`: module where the callable is defined.  
  - `short_name`: simple function/method name, e.g. `normalize_dft`.  
  - `doc`: first-paragraph summary of the callable’s docstring (shortened).  

The frontend shows these entries as a list under **Under the hood** for the currently selected section.

### 2.4 Custom quantity request (`POST /schema/custom-quantity`)

~~~json
{
  "package": "nomad_simulations.schema_packages.model_method",
  "class_name": "ModelMethod",
  "quantity_name": "my_quantity",
  "dtype": "float",
  "docstring": "Optional docstring here"
}
~~~

**Notes**

- Supported dtypes are validated server-side (`SUPPORTED_CUSTOM_DTYPES` in both `api/main.py` and `api/light_mode/app.py`).
- The endpoint rebuilds the graph once, injects the quantity, and returns the updated graph payload used by editable mode in the UI.

---

## 3) Backend Flow

### 3.1 Dev Mode (`api/main.py` + routers)

1. **`GET /git/branches`**
   - Opens the configured local git repo (`SCHEMA_UML_REPO` / `NOMAD_SIM_REPO` / `GIT_REPO_DIR`).
   - Returns local branch names plus active branch and HEAD SHA.

2. **`GET /git/packages`**
   - Inspects package modules at a requested branch.
   - Feeds the package selector for branch-aware browsing.

3. **`GET /overview`**
   - Walks packages under a base namespace at a branch.
   - Returns package/class summaries for `OverviewGrid`.

4. **`POST /graph`**
   - Materializes a worktree for one branch and builds a single graph.

5. **`POST /graph/diff`**
   - Materializes two worktrees (`base`, `head`) under `api/_data/`.
   - Builds both graphs, computes node/edge deltas, returns `{ base, head, diff }`.

6. **`GET /schema`**
   - Builds from the current workspace package/root (no branch diff).
   - Replays persisted edits and includes workspace metadata.

7. **Custom edits (`POST /schema/custom-class`, `POST /schema/custom-quantity`, `DELETE /schema/custom-edits`)**
   - Validate edit payloads, rebuild graph, persist edit in Mongo, return updated graph.

8. **`GET /usage`**
   - Resolves section FQCN and returns normalize/helper usage via `extractor/usage_index.py`.

9. **Async task endpoints (`POST /tasks/graph`, `POST /tasks/graph/diff`, `GET /tasks/{id}`)**
   - Optional Celery-backed background extraction and diffing.

### 3.2 Light Mode (`api/light_mode/app.py`)

1. **Schema source policy (`GET /schema/version`, `POST /schema/update`)**
   - Always uses installed `nomad-simulations` package.
   - Update path pulls latest remote `develop` lineage via pip.
   - Local repo indicators are ignored by policy.

2. **Workspace (`GET /workspace`, `PUT /workspace`)**
   - Single user local workspace in SQLite.
   - Branch is enforced to `develop`; non-`develop` requests are rejected.

3. **`GET /schema`, `GET /roots`**
   - Builds graph from installed package modules.
   - Replays persisted local edits from SQLite.

4. **Custom edits (`POST /schema/custom-class`, `POST /schema/custom-quantity`, `DELETE /schema/custom-edits`, `DELETE /schema/custom-edit`)**
   - Same edit semantics as Dev Mode; persisted locally.
   - Inherited-quantity redefinition on child classes is rejected.

5. **`GET /overview`, `GET /usage`**
   - Overview and under-the-hood data from installed package imports/introspection.

6. **Git endpoints in Light Mode**
   - `GET /git/packages` is supported with fixed branch policy (`develop` only).
   - `GET /git/branches` returns `410` by design.
   - Branch diff endpoints (`/graph`, `/graph/diff`, `/tasks/*`) are not exposed.

**Key files**

- Dev Mode:
  - `api/main.py` — Dev app entry and shared schema/edit endpoints.
  - `api/routes_git.py` — branch-aware graph and git endpoints.
  - `api/routes_tasks.py` — async graph/diff task endpoints.
  - `api/git_utils.py` — bare mirror/worktree management.
  - `api/graph_runner.py` — subprocess graph extraction in worktrees.
  - `api/diff.py` — graph diffing logic.
- Light Mode:
  - `api/light_mode/app.py` — Light Mode API, fixed branch policy, send-design endpoint.
  - `api/light_mode/schema_source.py` — installed package policy + update behavior.
  - `api/light_mode/store.py` — SQLite workspace/custom edit persistence.
- `extractor/graph_builder.py` — embeds graph structure + docstrings for sections and quantities.
- `extractor/usage_index.py` — introspects normalize methods and helpers; exposes `get_usage_for_section`.

---

## 4) Frontend Flow

- **`App.tsx`**
  - Sidebar controls are mode-aware:
    - Dev Mode: package + branch selectors, compare-branches controls, auth session state.
    - Light Mode: fixed `develop` branch UX, no branch-diff controls.
  - Sidebar includes **Under the hood** (usage inspection via `/usage`) and **Compare branches** (Dev Mode only).
  - **Build graph:** always resolves to `/schema` in Light Mode; Dev Mode can use `/schema`, `/graph`, or `/tasks/graph` depending on settings.
  - **Compare branches (Dev Mode only):** `/graph/diff` or `/tasks/graph/diff`.
  - **Bird’s-eye view:** calls `/overview` and renders an `OverviewGrid` of packages/classes.
  - **Exports:** JSON download and PDF snapshot (via `GraphView` export handle).
  - Right column:
    - Top: `DocPanel` (schema docs + quantities, includes inline edit/remove hooks).
    - Bottom: audit trail (edit history, archive/restore, export/clear).
  - **Editable mode:** toggles whether class/quantity mutation actions are enabled; uses `/schema/custom-class` and `/schema/custom-quantity` for persisted additions, and client-side updates for rename/delete.
  - Workspace controls include **Show base sections** (default off): off keeps diagrams focused on selected schema namespace; on restores full base/framework hierarchy.
  - Mode selection:
    - Compile-time: `VITE_LIGHT_MODE=true` disables branch-diff/task paths.
    - Runtime: frontend also detects Light Mode when `/schema/version` is available and switches behavior accordingly.

- **`GraphView.tsx`**
  - Renders sections as UML cards using Cytoscape + ELK.
  - Applies namespace-based class filtering when **Show base sections** is off; base/framework sections are hidden unless explicitly shown.
  - Keeps session-added classes visible/selectable in filtered view (so newly created classes can be edited immediately).
  - Folds quantity metadata into each section’s card label (attributes) and into a `quantitiesByOwner` map for the Doc Panel.
  - Mouse-wheel zoom sensitivity is intentionally damped for finer control.
  - On node tap:
    - Builds a `Selected` object with:
      - `id = fully-qualified section name`.
      - `kind = "class"`.
      - `name`, `doc`, `path`, `line`.
      - `quantities` for that section.
    - Calls `useSelection.getState().setSelected(...)`.
  - Styles: composition edges (diamonds), diff classes (colored outlines), removed edges dashed red.
  - Exposes `toPng()` via `GraphExportHandle` for PDF export in the sidebar.

- **`components/DocPanel.tsx`**
  - Reads `selected` from `useSelection`.
  - For a selected class:
    - Shows class name + docstring.
    - Lists quantities (name + dtype/shape/card); clicking a quantity displays its docstring.
    - Provides inline edit/remove controls when editable mode is on.
  - For a selected quantity:
    - Shows that quantity’s docstring and type info.
    - Shows inherited-from metadata when applicable.
    - Inherited quantities remain read-only in editable mode.

- **`components/UnderTheHoodPanel.tsx`**
  - Props: `{ apiBase: string, token?: string }`.  
  - Reads `selected` from `useSelection`.  
  - If a class is selected:
    - Calls `GET {apiBase}/usage?section_id=<selected.id>`.  
    - Renders a list of:
      - `Section.normalize()` implementations (`kind="normalize_method"`).  
      - Module-level helpers (`kind="normalize_function"`).  
    - Shows `short_name`, module, and a short doc summary for each entry.  
  - If nothing or a quantity is selected: shows a placeholder.

- **`components/AddQuantityForm.tsx` & `components/QuantityEditPanel.tsx`**
  - Form helpers for editable mode (add/rename/remove quantities with validation messaging).
  - Enforce read-only behavior for inherited quantities in the UI.

- **`store/selection.ts`**
  - Zustand store with:
    - `selected: Selected | null`
    - `setSelected(s: Selected | null)`
  - `Selected` holds:
    - `id`, `kind`, `name`, `doc`, `path`, `line`
    - inherited quantity metadata (`inherited`, `inheritedFromId`, `inheritedFromName`, `sourceId`) when kind is quantity
    - optional `quantities` (for class nodes).

**Performance tips**

- For large repos, during branch diff (Dev Mode), disable cross-module traversal and/or subsections to keep the graph small.
- Bird’s-eye view (`OverviewGrid`) is a cheap way to spot new/removed classes without rendering a full graph.
- Keep **Show base sections** off for cleaner, lower-noise UML views in large inheritance trees.

---

## 5) Common Contributor Operations

**Add/change graph building**

- Edit `extractor/graph_builder.py`.  
- Function signature:

  ~~~python
  build_graph(
      package: str,
      root: str | None = None,
      include_quantities: bool = True,
      include_subsections: bool = True,
      include_inheritance: bool = True,
      allow_cross_module: bool = True,
      base_namespace: str | None = None,
  ) -> dict:
      ...
  ~~~  
- Ensure quantities include `doc` (and any optional metadata expected by frontend contracts).

**Extend usage / normalization discovery**

- Edit `extractor/usage_index.py`.  
  - Add new heuristics for `"utility_function"` or additional normalize helpers.  
  - Keep the `UsageEntry` dataclass and `/usage` response model in sync with the frontend.

**Extend diff semantics**

- Edit `api/diff.py` to adjust what counts as “changed” (Dev Mode branch diff).

**Add endpoints**

- Dev Mode: add handlers in `api/main.py`/routers (`api/routes_git.py`, `api/routes_tasks.py`) and mount in `api/main.py`.
- Light Mode: add handlers in `api/light_mode/app.py` (do not expose branch-switch/diff behavior).

**Adjust diagram styles/behavior**

- Edit `web/src/GraphView.tsx` for Cytoscape styles, label formatting, layout.  
- Edit `web/src/components/DocPanel.tsx` and `web/src/components/UnderTheHoodPanel.tsx` for panel layout/content.

---

## 6) Extension Ideas

- Export PNG/SVG of the current graph (`cy.png({ full: true })`, `cy.svg({ full: true })`).  
- Attribute diff view: list added/removed/changed quantities for a section in diff mode.  
- Search box to highlight nodes/attrs by name or dtype.  
- Show normalize source: extend `/usage` to optionally include `inspect.getsource(...)` and render it in a collapsible block.  
- Remote branches: add scope toggle (`?scope=local|all`) in `/git/branches`.

---

## 7) Operational Notes

**Dev Mode bare mirror location**

~~~text
api/_data/<repo-slug>.bare  # slug derived from SCHEMA_UML_REPO
~~~

**Dev Mode worktrees**

~~~text
api/_data/<repo-slug>.bare/worktrees/<branch>/...
~~~

**Dev Mode rebuild mirror safely**

~~~bash
rm -rf api/_data
mkdir -p api/_data
(
  cd api/_data &&
  git clone --bare "$SCHEMA_UML_REPO" $(python - <<'PY'
import os, re
from urllib.parse import urlparse
from pathlib import Path
src = os.environ.get("SCHEMA_UML_REPO") or os.environ.get("NOMAD_SIM_REPO")
name = Path(urlparse(src).path or src).name
print(re.sub(r"[^A-Za-z0-9._-]", "_", name[:-4] if name.endswith('.git') else name))
PY)
)
~~~

**Dev Mode .gitignore**

~~~text
api/_data/
~~~

**Light Mode local state**

~~~text
$SCHEMA_STUDIO_HOME/light_mode.sqlite3
# default fallback (if SCHEMA_STUDIO_HOME unset):
#   <platform user config dir>/.../light_mode.sqlite3
#   or <cwd>/.schema_studio_light/light_mode.sqlite3 (when config dir not writable)
~~~

**Light Mode schema updates**

- On startup, Light Mode attempts a one-time automatic bootstrap when schema metadata is unavailable.
- Runtime update path is `POST /schema/update` (or UI "Update schema").
- Update implementation runs `python -m pip install --upgrade git+https://github.com/nomad-coe/nomad-simulations.git@develop`, then invalidates import caches.

**Light Mode frontend assets**

- Light Mode serves bundled static assets from `api/light_mode/static` by default.
- `SCHEMA_STUDIO_DIST_DIR` can override this path (useful for local frontend iteration).
- When frontend source changes need to be shipped in Light Mode, rebuild and sync:

~~~bash
VITE_LIGHT_MODE=true npm --prefix web run build
./scripts/sync_light_mode_static.sh
~~~

---

## 8) Known Constraints

- Very large graphs + ELK can be slow in the browser; use filters for diffs or narrow the base namespace.
- Quantities are not nodes in the canvas; removed/changed attributes should be surfaced via the diff banner or a future attribute diff list.  
- Cross-module traversal can explode node count; keep a tight `base_namespace` during exploration.  
- Branch diffing is intentionally unavailable in Light Mode.
- If Light Mode receives `POST /graph`, `POST /graph/diff`, or `/tasks/*` calls (405/404), the frontend was likely built without Light Mode flags. Rebuild web with `VITE_LIGHT_MODE=true` and restart `schema-studio`.

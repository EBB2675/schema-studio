# REPO GUIDE — Schema-UML

A structured overview of the repository for developers to navigate, understand, and extend the project.

---

## 0) TL;DR 

**Purpose:** Interactive editor for data models; currently defaults to `nomad-simulations` but works with any schema repo you configure. Build UML diagrams, inspect docstrings/usage, add custom classes (inheritance or subsection), and add quantities inline. Supports branch diff, overview mode, and empty-canvas editing.

**Frontend:** React + TypeScript + Cytoscape + ELK  
**Backend:** FastAPI (async/Motor) + GitPython + MongoDB + Celery (Redis)

**Main directories:**
- `web/` — frontend React app  
- `api/` — FastAPI backend  
- `extractor/` — schema graph & usage extractor  
- `api/_data/` — auto-generated bare mirror + worktrees (gitignored)

**Key endpoints:**
- Auth/workspace/health: `POST /auth/login`, `POST /auth/register`, `GET /workspace`, `PUT /workspace`, `GET /health`, `GET /`
- `GET /roots` — list section roots for a package
- `GET /schema` — build a graph from the working tree (single branch)
- `POST /graph` — build a graph from a specific branch/worktree (single branch)
- `POST /graph/diff` — compare two branches and return a diff
- `POST /tasks/graph` — enqueue graph build (poll `/tasks/{id}`)
- `POST /tasks/graph/diff` — enqueue diff (poll `/tasks/{id}`)
- `GET /tasks/{id}` — task status/result
- Custom edits: `POST /schema/custom-class`, `POST /schema/custom-quantity`, `DELETE /schema/custom-edits`
- `GET /overview` — bird’s-eye list of packages and top-level classes at a branch
- `GET /git/branches` — list local branches of the repo
- `GET /git/packages` — list Python modules under a base package
- `GET /usage` — list normalize methods / helper functions for a given section class

Shared query flags for `/schema`, `/graph`, `/graph/diff`, and their task variants: `include_quantities`, `include_subsections`, `include_inheritance`, `allow_cross_module`, `base_namespace`, `root`, and `empty` (empty-canvas mode).

**Authentication:**
- Every endpoint (except `/auth/login` and `/auth/register`) requires a bearer token. The backend seeds a default user on startup:
  - `SCHEMA_UML_DEFAULT_USER` (default `admin`)
  - `SCHEMA_UML_DEFAULT_PASSWORD` (default `admin`)

**Essential env:**
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

**Start it quickly:**
- Docker Compose (one shot): set `.env` with `SCHEMA_UML_REPO_HOST`, secrets, then `docker compose up --build`. Brings up API, web, Mongo, Redis, Celery worker.
- Local dev: `./dev.sh` (API + web). For real async tasks, also run Redis and a Celery worker with the broker/backends above; otherwise Celery runs eagerly in-process. Override ports via `API_PORT` / `WEB_PORT`.

**UX highlights:**
- UML cards show **sections**; **quantities** appear as attributes inside the card (not separate nodes).
- Right **Doc Panel** shows the **class docstring** and a **clickable list of quantities**; clicking a quantity shows its docstring.
- Right **Under-the-hood Panel** shows **normalization methods and helper functions** that act on the selected section (based on `/usage`).
- **Editable mode**: add classes (inheritance or subsection links) and add/rename/remove quantities; dtype validated against allowlist; custom classes get fully qualified ids so quantities work immediately.
- **Bird’s-eye overview** renders packages/classes for a branch without building the full graph.
- **Overlays**: inheritance defaults on; dtype/shape labels toggleable.
- **Exports**: download the current graph JSON or a PDF snapshot.
- Branch diff highlights: 🟩 Added, 🟨 Changed, 🟥 Removed (edges dashed red; quantity deltas are included).
- **Empty canvas**: start from `<base>.custom_schema`, edit freely, and reset persisted custom edits when needed (UI calls `/schema/custom-edits`).

**Custom edit model (important for agents):**
- Backend persists no custom state; it injects synthetic classes/quantities into the returned graph (works the same across any configured schema repo). The frontend replays its audit trail on each load and can force-reset empty-canvas edits via `/schema/custom-edits`.

**API compatibility headers:**
- Frontend sends `X-Schema-UML-Version` and `X-Schema-UML-Features` so backends can gate behavior across different schema repos.

**Typing/normalization helpers (frontend):**
- `src/types/api.ts` enforces runtime parsing of graph/diff payloads.
- `src/utils/identifier.ts` normalizes ids/labels/fqids used across GraphView, DocPanel, and selection store.
- `src/utils/errors.ts` standardizes API error formatting.

**Workspace state:**
- Stored in `src/store/workspace.ts` (branch/pkg/base namespace/startEmpty), synced with backend `/workspace` where available and persisted locally for reloads.

**Contract tests:**
- `npm run test:run` (from `web/`) executes frontend UI flows + contract parsing/identifier checks using Vitest + happy-dom.
- `npm run test:contracts` runs only the contract/identifier subset.
- Custom classes: `POST /schema/custom-class` with `relation` (`inherits` | `hasSubSection`), always assigns id `{package}.{name}`; adds parent edge if provided.
- Custom quantities: `POST /schema/custom-quantity` with `class_name` (label), optional `parent_name`/`parent_relation` to reattach parent edge if the class must be materialized server-side.
- Frontend keeps an audit trail and replays all prior edits onto each fresh server graph so earlier custom edges don’t disappear when adding new ones.

---

## 1) Repository Structure

~~~text
schema-studio/
├─ api/                         # FastAPI backend
│  ├─ main.py                   # App entry, CORS, /roots, /schema, /overview, /usage, /schema/custom-quantity
│  ├─ routes_git.py             # /git/branches, /git/packages, /graph, /graph/diff
│  ├─ graph_runner.py           # Runs extractor in a worktree subprocess
│  ├─ git_utils.py              # Bare mirror & worktree management
│  ├─ diff.py                   # Graph comparison logic
│  ├─ _data/                    # Auto-generated bare mirror & worktrees (gitignored)
│  └─ requirements.txt
│
├─ extractor/
│  ├─ graph_builder.py          # build_graph(package, **opts); embeds docstrings
│  ├─ usage_index.py            # get_usage_for_section(section_qualname) for /usage
│  └─ __init__.py
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
│  │  └─ styles.css
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
      "methods": ["normalize", "validate"],
      "path": "nomad_simulations/schema_packages/model_method.py",
      "line": 42
    },
    {
      "id": "nomad_simulations.schema_packages.model_method.ModelMethod.determinant",
      "kind": "quantity",
      "label": "determinant",
      "owner": "nomad_simulations.schema_packages.model_method.ModelMethod",
      "dtype": "Enum(restricted, unrestricted, restricted-open-shell)",
      "shape": null,
      "card": null,
      "doc": "The spin-coupling form of the determinant used for ...",
      "path": "nomad_simulations/schema_packages/model_method.py",
      "line": 73
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
- Quantities include `doc`, `path`, and `line` (backend embeds docstrings + source location; frontend shows them in the Doc Panel).  
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
[
  {
    "kind": "normalize_method",
    "qualname": "nomad.datamodel.data.Section.normalize",
    "module": "nomad.datamodel.data",
    "short_name": "normalize",
    "doc": "Is called during entry normalization. If you overwrite this with custom normalization code, make sure to call `super(...).normalize(archive, logger)` so all base-class normalize functions are executed."
  },
  {
    "kind": "normalize_function",
    "qualname": "nomad_simulations.schema_packages.model_method.normalize_dft",
    "module": "nomad_simulations.schema_packages.model_method",
    "short_name": "normalize_dft",
    "doc": "Normalize DFT-related fields for the DFT section (fill defaults, validate enums, etc.)."
  }
]
~~~

**Notes**

- Request: `GET /usage?section_id=<fully-qualified-section-class-name>`
  Example: `section_id=nomad_simulations.schema_packages.model_method.DFT`
- Response elements:
  - `kind`: `"normalize_method"` or `"normalize_function"` (later also `"utility_function"`).  
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

- Supported dtypes are validated server-side (`SUPPORTED_CUSTOM_DTYPES` in `api/main.py`).
- The endpoint rebuilds the graph once, injects the quantity, and returns the updated graph payload used by editable mode in the UI.

---

## 3) Backend Flow

1. **`GET /git/branches`**
   - Opens repo from `$NOMAD_SIM_REPO` or `$GIT_REPO_DIR` (falls back to current working dir, searching parents).
   - Returns local branch names plus active and HEAD SHA.

2. **`GET /git/packages`**
   - Inspects the repo at a given branch.
   - Returns importable Python packages under a given base (e.g. `nomad_simulations.schema_packages`).
   - Used for the “Choose from develop” dropdown.

3. **`GET /overview`**
   - Exports the subtree for a given branch and base package (handles `src/` layout).
   - Walks packages under the base and collects top-level class names.
   - Frontend uses this to render a bird’s-eye `OverviewGrid` of packages vs. classes.

4. **`POST /graph`**
   - Materializes a worktree for a requested branch and builds the graph there (single-branch render without diff).
   - Used when the UI sets **Package branch** to a specific branch.

5. **`POST /graph/diff`**
   - Creates two worktrees for `{base, head}` (under `api/_data/…`).
   - Runs the extractor in each worktree via `graph_runner.py`.
   - Computes node/edge deltas in `diff.py`.
   - Returns `{ base, head, diff }`.

6. **`GET /schema`**
   - Runs extractor once from the working tree (no diff) for interactive browsing.
   - Options control whether quantities and subsections are included and whether cross-module traversal is allowed.

7. **`POST /schema/custom-quantity`**
   - Rebuilds the graph for the active package/root, validates the requested dtype, and injects a synthetic quantity node/edge.
   - Returns the updated graph used by editable mode.

8. **`GET /usage`**
   - Resolves a section class from its fully-qualified name.
   - Uses `extractor/usage_index.py` to:
     - Detect a `normalize(...)` method on the class itself.
     - Detect module-level helper functions whose names look like normalizers for this class (e.g. `normalize_dft`, `normalize_xc_component`).
   - Returns a small JSON list of `UsageEntry` objects for the selected section.

**Key files**

- `api/main.py` — FastAPI app; `/health`, `/roots`, `/schema`, `/schema/custom-quantity`, `/overview`, `/usage`, mounts Git router.
- `api/routes_git.py` — `/git/branches`, `/git/packages`, `/graph`, `/graph/diff`.
- `api/git_utils.py` — bare clone + worktree management.
- `api/graph_runner.py` — subprocess wrapper to call extractor within a worktree.
- `api/diff.py` — graph indexing and set diffs.
- `extractor/graph_builder.py` — embeds docstrings and source info for sections and quantities.
- `extractor/usage_index.py` — introspects normalize methods and helpers; exposes `get_usage_for_section`.

---

## 4) Frontend Flow

- **`App.tsx`**
  - Sidebar controls: API base, package, package branch (uses `/graph`), roots, toggles (quantities / subsections / UML), cross-module, base namespace, theme.
  - **Build graph:** calls `/schema` (working tree) or `/graph` (specific branch) with current filters and renders it in `GraphView`.
  - **Compare branches:** calls `/graph/diff` and renders the head graph with diff highlights and a banner.
  - **Bird’s-eye view:** calls `/overview` and renders an `OverviewGrid` of packages/classes.
  - **Exports:** JSON download and PDF snapshot (via `GraphView` export handle).
  - Right column:
    - Top: `DocPanel` (schema docs + quantities, includes inline edit/remove hooks).
    - Bottom: `UnderTheHoodPanel` (normalize/helpers list; needs `apiBase`).
  - **Editable mode:** toggles whether quantity add/edit/remove actions are enabled; uses `/schema/custom-quantity` for adds and client-side updates for rename/delete.

- **`GraphView.tsx`**
  - Renders sections as UML cards using Cytoscape + ELK.
  - Folds quantity metadata into each section’s card label (attributes) and into a `quantitiesByOwner` map for the Doc Panel.
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

- **`components/UnderTheHoodPanel.tsx`**
  - Props: `{ apiBase: string }`.  
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

- **`store/selection.ts`**
  - Zustand store with:
    - `selected: Selected | null`
    - `setSelected(s: Selected | null)`
  - `Selected` holds:
    - `id`, `kind`, `name`, `doc`, `path`, `line`
    - optional `quantities` (for class nodes).

**Performance tips**

- For large repos, during branch diff, disable cross-module traversal and/or subsections to keep the graph small.  
- Bird’s-eye view (`OverviewGrid`) is a cheap way to spot new/removed classes without rendering a full graph.

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
      allow_cross_module: bool = True,
      base_namespace: str | None = None,
  ) -> dict:
      ...
  ~~~  

- Ensure quantities include `doc`, `path`, and `line`.

**Extend usage / normalization discovery**

- Edit `extractor/usage_index.py`.  
  - Add new heuristics for `"utility_function"` or additional normalize helpers.  
  - Keep the `UsageEntry` dataclass and `/usage` response model in sync with the frontend.

**Extend diff semantics**

- Edit `api/diff.py` to adjust what counts as “changed” (e.g. dtype/shape/card changes, or description changes).

**Add endpoints**

- Put handlers in `api/routes_git.py` (or a new router).  
- Mount via `app.include_router(...)` in `api/main.py`.

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

**Bare mirror location**

~~~text
api/_data/<repo-slug>.bare  # slug derived from SCHEMA_UML_REPO
~~~

**Worktrees**

~~~text
api/_data/<repo-slug>.bare/worktrees/<branch>/...
~~~

**Rebuild mirror safely**

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

**.gitignore**

~~~text
api/_data/
~~~

---

## 8) Known Constraints

- Very large graphs + ELK can be slow in the browser; use filters for diffs or narrow the base namespace.  
- Quantities are not nodes in the canvas; removed/changed attributes should be surfaced via the diff banner or a future attribute diff list.  
- Cross-module traversal can explode node count; keep a tight `base_namespace` during exploration.  
- The Under-the-hood view is in progress.

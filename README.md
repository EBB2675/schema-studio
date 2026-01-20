# Schema Studio

Interactive editor for data models. 

Currently defaults to NOMAD-compatible schemas (`nomad-simulations`) but can point to any schema repo you configure.

Back end: **FastAPI** · Front end: **React + Cytoscape + ELK**.

- Visualizes **sections** as UML cards (attributes = quantities, edges = subsections).
- Right-hand **Doc Panel** shows the **class docstring** and a **clickable list of quantities**.
- Right-hand **Under the hood** panel shows **normalization and helper functions** that act on the selected section (based on the repo you configure).
- **Branch diff** (base → head) highlights **added/changed/removed** nodes/edges, including quantity changes.
- **Bird's-eye overview**: inspect packages/classes across branches without building a full graph.
- **Editable mode**: add classes and quantities directly in the UI (server validates supported dtypes; new classes get fully-qualified ids and accept quantities immediately).
- **Empty canvas**: start from a blank namespace (`<base>.custom_schema`), edit freely, and reset persisted edits with one click.
- **Export**: download the current graph as JSON or a PDF snapshot.

---

# Overview

![Schema UML homepage](assets/homepage-11-12.png)

![gitdiff](assets/gitdiff-04-12.png)

---

## ✨ Features

- **UML cards**: Section name, attributes (quantity name, dtype, shape, cardinality), and optional methods.
- **Doc panel**: Click a class to see its docstring; click a quantity in the panel to see its docstring.
- **Under-the-hood panel**:
  - Click a class to see which **normalize methods** and **module-level helpers** the viewer can associate with that section.
  - Information is derived from your configured schema repo via a small introspection/indexing step in the backend (defaults to `nomad-simulations` if you don’t override env vars).
- **Branch comparison**: Choose two Git branches and render the diff with visual highlights.
- **Namespace filtering**: Limit traversal to a base namespace; optionally include cross-module links.
- **Bird's-eye overview**: Switch to Overview mode to list packages/classes for any branch.
- **Editable quantities/classes**: Toggle Editable mode to add classes (as inheritance or subsection relationships) and add, rename, or remove quantities from the selected class card (full editor, not just a viewer).
- **Optional overlays**: Inheritance edges and dtype/shape metadata are toggles (inheritance now on by default so new class relationships are visible).
- **Export**: Save the current graph as JSON or a PDF (PNG-backed) snapshot.

---

## 🚀 Quick Start

### 1) Clone
```bash
git clone https://github.com/EBB2675/schema-studio.git
cd schema-studio
```

### 2) Environment (Python 3.11) + MongoDB
```bash
conda create -n schema-studio python=3.11 -y
conda activate schema-studio
pip install -r api/requirements.txt
# ensure MongoDB is running on mongodb://localhost:27017 (default DB: schema_uml)
# or override:
# export SCHEMA_UML_MONGO_URI=mongodb://localhost:27017
# export SCHEMA_UML_MONGO_DB=schema_uml
```

### 3) Point to your schema repo
The backend reads from a local clone. Set one of (required before starting the stack):
```bash
# preferred (general, any schema repo)
export SCHEMA_UML_REPO=<path-or-URL-to-your-schema-repo>

# optional legacy envs for nomad-* clones (still accepted)
# export NOMAD_SIM_REPO=/path/to/nomad-simulations
# export NOMAD_MEASURE_REPO=/path/to/nomad-measurements
# export GIT_REPO_DIR=/path/to/nomad-simulations

# optional: override defaults used in the UI
# export SCHEMA_UML_BASE_PACKAGE=my_schema_root[,another.namespace]
# export SCHEMA_UML_PACKAGE=my_schema_root.module
```
By default, the viewer scopes to `nomad_simulations.schema_packages`. For other projects, set `SCHEMA_UML_BASE_PACKAGE` to your base namespace (comma separated for multiple roots) and ensure each namespace exists in the repo you configured.
Make it persistent by adding the export to `~/.bashrc` or `~/.zshrc`.

### 4) Run everything with one command
```bash
./dev.sh
```

What it does:

- Starts the FastAPI backend on **5179**.
- Expects MongoDB (default `mongodb://localhost:27017`, database `schema_uml`); override via `SCHEMA_UML_MONGO_URI` / `SCHEMA_UML_MONGO_DB`.
- Verifies **SCHEMA_UML_REPO / NOMAD_SIM_REPO / GIT_REPO_DIR** points to a **local git repo** (a subdirectory of a clone is fine; fails fast otherwise).
- Ensures `web/node_modules` exists (runs `npm install` on first launch).
- Starts the Vite frontend on **5173**.
- Stops both together on **Ctrl+C** (no manual job control needed).
- Exits early with a helpful message if `uvicorn` or `npm` are missing (activate your virtualenv first).

### 5) Authenticate (required)

The backend now requires a bearer token for every endpoint except `/auth/login`. A default user is created at startup:

- **Username**: `admin` (override via `SCHEMA_UML_DEFAULT_USER`)
- **Password**: `admin` (override via `SCHEMA_UML_DEFAULT_PASSWORD`)

Use the sign-in form in the UI or fetch a token manually:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:5179/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r .access_token)
```

Include the token when calling other endpoints:

```bash
curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:5179/roots?package=nomad_simulations.schema_packages.model_method'
```

Stop both with **Ctrl+C**. Override ports via `API_PORT` / `WEB_PORT` env vars.

Branch-specific render (no diff): set **Package branch** to load `/graph` for a chosen branch instead of the working tree.
The UI sends API compatibility headers (`X-Schema-UML-Version` and feature flags) so backends can enforce contracts across repos.

Sanity checks (optional, while `./dev.sh` is running):
```bash
curl 'http://127.0.0.1:5179/roots?package=nomad_simulations.schema_packages.model_method'
curl 'http://127.0.0.1:5179/schema?package=nomad_simulations.schema_packages.model_method&root=ModelMethod&include_quantities=true'
curl 'http://127.0.0.1:5179/git/branches'
```

Optional contract tests for API parsing/normalization (after `npm install` in `web/`):
```bash
cd web
npm run test:run   # frontend UI + contract suite (Vitest + happy-dom)
npm run test:contracts
```

---

## 🧠 How to Use

1. **Package**: Choose a package from the dropdown (populated per branch/base namespace).
2. **Root section**: Auto-populated from the package; pick one (e.g. `ModelMethod`) or leave empty to load all.
3. **Build graph**: Render UML cards and composition edges.
4. **Doc panel**: Click a class → see its docstring + list of quantities; click a quantity to view its docstring.
5. **Under the hood panel**: Click a class → see which normalizers and module-level helpers are associated with that section.
6. **Editable mode** (Doc panel): Toggle **Editable mode**, then add classes or add/rename/remove quantities on the selected class (supported dtypes are validated server-side; new classes can immediately receive quantities).
7. **Compare branches**: Choose **Base** and **Head** → **Compare** to see a visual diff.
8. **Export**: Download the current graph as **JSON** or a **PDF** snapshot from the sidebar.

Legend:
- 🟩 **Added** (green border / edges)
- 🟨 **Changed** (amber border)
- 🟥 **Removed** (shown in diff banner; removed edges dashed red)

---

## ⚙️ Backend Endpoints (summary)

- `GET /roots?package=...` → `{\"sections\": [...]}`
- `GET /schema`
  Params: `package, root?, include_quantities?, include_subsections?, allow_cross_module?, base_namespace?`
  Returns: `{ package, root, nodes, edges }` where:
  - `nodes[*].kind ∈ {\"section\",\"quantity\"}`
  - `nodes[*].doc` is populated for **both sections and quantities**
- `POST /graph` → build a graph from a specific branch/worktree
- `GET /git/branches` → `{\"branches\":[...], \"active\": \"...\", \"head\": \"SHA\"}`
- `POST /graph/diff` → `{ base:{branch,sha,graph}, head:{...}, diff:{nodes:{added,removed,changed}, edges:{added,removed}} }`
- `POST /schema/custom-quantity` → inject a validated quantity onto a class (used by Editable mode; will materialize a synthetic section if the class was just created client-side)
- `GET /usage` → list normalize methods / helper functions for a given section class

> Quantity docstrings are embedded directly in `/schema`.
> The builder that does this is `extractor/graph_builder.py`.

---

## 🧩 Implementation Notes

- **Graph builder** (`extractor/graph_builder.py`)
  - Serializes sections and quantities with robust doc extraction (`description`, `m_def.description`, `__doc__`).
  - Quantities are **not rendered as separate boxes** in the canvas. They are folded into the class card and listed in the Doc Panel.
- **Frontend**
  - `web/src/GraphView.tsx`: builds Cytoscape graph (sections + composition edges), wires selection to the store, supports diff overlays and export hook.
  - `web/src/components/DocPanel.tsx`: shows class/quantity docs; lists quantities with dtype/shape/card; inline actions for editable mode.
  - `web/src/components/UnderTheHoodPanel.tsx`: for the selected class, calls `/usage` on API base and renders the normalization list.
  - `web/src/components/AddQuantityForm.tsx` and `web/src/components/QuantityEditPanel.tsx`: UI for adding/renaming/removing quantities.
  - `web/src/store/selection.ts`: Zustand store for selected node.
- **ELK Layout**: layered, right-directed; label size is included in node dimensions.

---

## 🔧 Troubleshooting

- **Branches list is empty**
  - Ensure `NOMAD_SIM_REPO` (or `GIT_REPO_DIR`) points to a valid Git repo.
  - Check `curl http://127.0.0.1:5179/git/branches`.
- **Quantities show “No docstring available.”**
  - Ensure `extractor/graph_builder.py` includes `doc=_doc_from(q)` for quantities.
  - Restart backend and reload frontend.
- **Vite overlay / missing deps**
  - Install: `npm i zustand cytoscape cytoscape-elk elkjs` (and `react-markdown` if you render markdown docs).
  - Clear cache: `rm -rf web/node_modules web/node_modules/.vite && npm i`.
- **Pydantic import error (`model_validator`)**
  - The backend relies on **Pydantic v2** (`pydantic>=2,<3`).
  - If you see `ImportError: cannot import name 'model_validator'`, an older global install may be shadowing your environment; reinstall requirements inside a clean virtualenv/conda env to pick up v2.

---

## 📁 Auto-generated Data

The backend may create working data under:
```
api/_data/
```
These are temporary and should **not** be committed.

---

## 👩‍💻 Author

**Dr. Esma Birsen Boydaş**
NOMAD Laboratory (FAIRmat), Humboldt-Universität zu Berlin

> Work in progress — scope and UI may evolve.

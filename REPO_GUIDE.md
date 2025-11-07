# REPO GUIDE — Schema-UML

A structured overview of the repository for developers to navigate, understand, and extend the project.

---

## 0) TL;DR

**Purpose:** Visualize `nomad-simulations` schema as UML diagrams and compare schema changes across Git branches.

**Frontend:** React + TypeScript + Cytoscape + ELK  
**Backend:** FastAPI + GitPython

**Main directories:**
- `web/` — frontend React app
- `api/` — FastAPI backend
- `extractor/` — schema graph extractor
- `api/_data/` — auto-generated bare mirror + worktrees (gitignored)

**Key endpoints:**
- `GET /roots` — list section roots for a package
- `GET /schema` — build a graph (single branch)
- `GET /git/branches` — list local branches of the repo
- `POST /graph/diff` — compare two branches and return a diff

**Environment variables (one of):**
```bash
export NOMAD_SIM_REPO=/path/to/nomad-simulations
# or
export GIT_REPO_DIR=/path/to/nomad-simulations
```

**UX highlights:**
- UML cards show **sections**; **quantities** appear as attributes inside the card (not separate nodes).
- Right **Doc Panel** shows the **class docstring** and a **clickable list of quantities**; clicking a quantity shows its docstring.
- Branch diff highlights: 🟩 Added, 🟨 Changed, 🟥 Removed (edges dashed red).

---

## 1) Repository Structure

```text
schema-uml/
├─ api/                         # FastAPI backend
│  ├─ main.py                   # App entry, routers, CORS, /roots and /schema
│  ├─ routes_git.py             # /git/branches and /graph/diff
│  ├─ graph_runner.py           # Runs extractor in a worktree subprocess
│  ├─ git_utils.py              # Bare mirror & worktree management
│  ├─ diff.py                   # Graph comparison logic
│  ├─ _data/                    # Auto-generated bare mirror & worktrees (gitignored)
│  └─ requirements.txt
│
├─ extractor/
│  ├─ graph_builder.py          # build_graph(package, **opts); now embeds docstrings
│  └─ __init__.py
│
├─ web/                         # React frontend (Vite)
│  ├─ src/
│  │  ├─ App.tsx                # Sidebar controls, API calls, diff banner, export
│  │  ├─ GraphView.tsx          # Cytoscape UML renderer (sections only; quantities folded)
│  │  ├─ components/
│  │  │  └─ DocPanel.tsx        # Class/quantity docstrings; quantity list (clickable)
│  │  ├─ store/
│  │  │  └─ selection.ts        # Zustand store for selected item
│  │  └─ styles.css
│  ├─ index.html
│  └─ package.json
│
├─ README.md                    # Quick start, features, troubleshooting
└─ REPO_GUIDE.md                # (this file)
```

---

## 2) Data Contracts

### 2.1 Graph JSON (`GET /schema` → consumed by frontend)

```json
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
```

**Notes**
- `kind ∈ {"section","quantity"}`.
- **Quantities include `doc`** (backend embeds docstrings; frontend shows them in the Doc Panel).
- The frontend **does not render quantity nodes** on the canvas; it folds them into each section’s card and the panel.

### 2.2 Diff JSON (`POST /graph/diff`)

```json
{
  "base": { "branch": "develop", "sha": "abc123", "graph": { } },
  "head": { "branch": "feature", "sha": "def456", "graph": { } },
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
```

**Frontend rendering policy**
- Added sections → green border (`.diff-added`)
- Changed sections → amber border (`.diff-changed`)
- Removed sections/edges → shown in the diff banner/summary (removed edges dashed red)

---

## 3) Backend Flow

1. **`GET /git/branches`**
   - Opens repo from `$NOMAD_SIM_REPO` or `$GIT_REPO_DIR` (falls back to current working dir, searching parents).
   - Returns local branch names plus active and HEAD SHA.

2. **`POST /graph/diff`**
   - Creates two worktrees for `{base, head}` (under `api/_data/…`).
   - Runs the extractor in each worktree via `graph_runner.py`.
   - Computes node/edge deltas in `diff.py`.
   - Returns `{ base, head, diff }`.

3. **`GET /schema`**
   - Runs extractor once (no diff) for interactive browsing.

**Key files**
- `api/main.py` — FastAPI app, `GET /roots`, `GET /schema`, mounts Git router.
- `api/routes_git.py` — `GET /git/branches`, `POST /graph/diff`.
- `api/git_utils.py` — bare clone + worktree management.
- `api/graph_runner.py` — subprocess wrapper to call extractor within a worktree.
- `api/diff.py` — graph indexing and set diffs.
- `extractor/graph_builder.py` — **embeds docstrings** for **sections and quantities** (`doc=_doc_from(...)`).

---

## 4) Frontend Flow

- **`App.tsx`**
  - Sidebar controls: API base, package, roots, toggles (quantities/subsections/uml), cross-module, base namespace.
  - **Build graph:** calls `/schema` with current filters.
  - **Compare branches:** calls `/graph/diff` and renders the *head* graph with diff highlights and a banner.

- **`GraphView.tsx`**
  - Renders **sections only** as UML cards (Cytoscape + ELK).
  - Folds quantity metadata into each section’s card label (attributes) and passes it to the **Doc Panel** (no quantity nodes).
  - Styles: composition edges with diamonds; diff classes with colored outlines; removed edges dashed red.

- **`components/DocPanel.tsx`**
  - Shows selected **class** docstring plus a **clickable list of quantities** (name + dtype/shape/card).
  - Clicking a **quantity** shows its **docstring** (comes from `/schema` payload; no extra fetch needed).
  - Uses a small Zustand store for selection.

- **`store/selection.ts`**
  - Zustand store with `{ selected, setSelected }`, where `selected` may be a class or a quantity.

**Performance tips**
- For large repos, during branch diff, disable cross-module traversal and/or subsections to keep the graph small.

---

## 5) Common Contributor Operations

**Add/change graph building**
- Edit `extractor/graph_builder.py`.
- Function signature:
  ```python
  build_graph(package: str,
              root: str | None = None,
              include_quantities: bool = True,
              include_subsections: bool = True,
              allow_cross_module: bool = True,
              base_namespace: str | None = None,
              ...) -> dict
  ```
- Ensure quantities include `doc` via `_doc_from(q)`.

**Extend diff semantics**
- Edit `api/diff.py` to adjust what counts as “changed” (e.g., dtype/shape/card changes).

**Add endpoints**
- Put handlers in `api/routes_git.py` (or a new router) and mount via `app.include_router(...)` in `api/main.py`.

**Adjust diagram styles/behavior**
- Edit `web/src/GraphView.tsx` (Cytoscape styles, label formatting, layout).
- Edit `web/src/components/DocPanel.tsx` for panel layout/content.

---

## 6) Extension Ideas

- **Export** PNG/SVG of the current graph (`cy.png({full:true})`, `cy.svg({full:true})`).
- **Filter** to show only (added ∪ changed ∪ neighbors) in diff mode.
- **Search** box to highlight nodes/attrs by name or dtype.
- **Remote branches**: add scope toggle (`?scope=local|all`) in `/git/branches`.

---

## 7) Operational Notes

**Bare mirror location**
```
api/_data/nomad-simulations.bare
```

**Worktrees**
```
api/_data/nomad-simulations.bare/worktrees/<branch>/...
```

**Rebuild mirror safely**
```bash
rm -rf api/_data
mkdir -p api/_data
( cd api/_data && git clone --bare "$NOMAD_SIM_REPO" nomad-simulations.bare )
```

**.gitignore**
```
api/_data/
```

---

## 8) Known Constraints

- Very large graphs + ELK can be slow in the browser; use filters for diffs.
- Quantities are **not** nodes in the canvas; removed/changed attributes should be surfaced via the diff banner or (future) attribute diff list.
- Cross-module traversal can explode node count; keep a tight `base_namespace` during exploration.

---
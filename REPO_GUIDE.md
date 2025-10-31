# REPO GUIDE — Schema-UML

A structured overview of the repository for developers to programmatically navigate, understand, and extend the project.

---

## 0. TL;DR

**Purpose:** Visualize NOMAD data schemas as UML diagrams and compare schema changes between Git branches.

**Frontend:** React + TypeScript + Cytoscape + ELK  
**Backend:** FastAPI + GitPython  

**Main directories:**
- `web/` — frontend React app  
- `api/` — FastAPI backend  
- `extractor/` — logic to extract schema structure  
- `api/_data/` — auto-generated git worktrees (ignored)

**Key endpoints:**
- `GET /roots` → list section roots  
- `GET /schema` → build UML graph  
- `GET /git/branches` → list branches  
- `POST /graph/diff` → compare branches  

**Environment variable:**
    NOMAD_SIM_REPO=/path/to/nomad-simulations

---

## 1. Repository Structure

    schema-uml/
    ├─ api/                         # FastAPI backend
    │  ├─ main.py                   # App entry point, routes, CORS
    │  ├─ routes_git.py             # /git/* and /graph/diff endpoints
    │  ├─ graph_runner.py           # Runs extractor in worktree subprocess
    │  ├─ git_utils.py              # Bare clone & worktree management
    │  ├─ diff.py                   # Graph comparison logic
    │  ├─ _data/                    # Auto-generated bare mirror & worktrees (gitignored)
    │  └─ requirements.txt
    │
    ├─ extractor/
    │  ├─ graph_builder.py          # build_graph(package, **opts)
    │  └─ __init__.py
    │
    ├─ web/                         # React frontend
    │  ├─ src/
    │  │  ├─ App.tsx                # Main UI, API calls, diff logic
    │  │  ├─ GraphView.tsx          # Cytoscape UML renderer
    │  │  └─ styles.css
    │  ├─ index.html
    │  └─ package.json
    │
    ├─ README.md                    # Developer setup
    └─ REPO_GUIDE.md                # (this file)

---

## 2. Data Contracts

### 2.1 Graph JSON (output of extractor → consumed by frontend)

    {
      "package": "nomad_simulations.schema_packages.model_method",
      "root": "ModelMethod",
      "nodes": [
        {
          "id": "ModelMethod",
          "kind": "section",
          "label": "ModelMethod",
          "module": "nomad_simulations.schema_packages.model_method",
          "methods": ["..."]        // optional
        },
        {
          "id": "ModelMethod.main_basis_set",
          "kind": "quantity",
          "label": "main_basis_set",
          "owner": "ModelMethod",
          "dtype": "str",
          "shape": null,
          "card": null
        }
      ],
      "edges": [
        { "source": "ModelMethod", "target": "BasisSet", "type": "hasSubSection", "card": "0..*" }
      ]
    }

Notes:
- Sections render as UML classes (nodes).
- Quantities render as attributes inside the class label.
- `hasSubSection` edges render as composition edges in the diagram.

### 2.2 Diff JSON (backend `/graph/diff` response)

    {
      "base": { "branch": "develop", "sha": "abc123", "graph": { /* graph A */ } },
      "head": { "branch": "feature", "sha": "def456", "graph": { /* graph B */ } },
      "diff": {
        "nodes": {
          "added":   [{ "id": "NewSection", "kind": "section" }],
          "removed": [{ "id": "OldSection", "kind": "section" }],
          "changed": [{ "id": "EditedSection" }]
        },
        "edges": {
          "added":   [{ "source": "A", "target": "B", "type": "hasSubSection" }],
          "removed": [{ "source": "X", "target": "Y", "type": "hasSubSection" }]
        },
        "attrs": {
          "ModelMethod": {
            "added":   ["new_attr: int", "another: str"],
            "removed": ["old_attr: float"]
          }
        }
      }
    }

Frontend rendering policy:
- Added sections → green outline.
- Changed sections → amber outline.
- Removed sections/edges → listed in a side panel (keeps layout light).
- Attribute diffs may be appended as +/- lines or summarized in the side panel.

---

## 3. Backend Flow (branch diff)

1) `GET /git/branches`  
   - Ensures a bare clone exists under `api/_data/nomad-simulations.bare`.  
   - Returns local branch names.

2) `POST /graph/diff`  
   - Materializes two worktrees for `{base, head}`.  
   - Runs the extractor in a subprocess for each worktree (`graph_runner.py`).  
   - Computes `{nodes, edges, attrs}` delta with `diff.py`.  
   - Returns `{ base, head, diff }`.

3) `GET /schema`  
   - Runs extractor once for interactive browsing (no diff).

Key files:
- `api/main.py` — app setup, routers, CORS.  
- `api/routes_git.py` — endpoints; calls into `git_utils`, `graph_runner`, `diff`.  
- `api/git_utils.py` — bare mirror + worktree management.  
- `api/graph_runner.py` — subprocess wrapper; passes args; returns JSON.  
- `api/diff.py` — indexing and diff logic (sections, quantities-as-attributes, edges).

---

## 4. Frontend Flow

- `App.tsx`
  - Controls: API base, package/module, root, flags.
  - Build graph: calls `/schema`, renders head graph.
  - Compare: calls `/graph/diff` (often with light options: `include_subsections=false`, `allow_cross_module=false`), renders head graph + diff highlights; removed listed at right.

- `GraphView.tsx`
  - Cytoscape + ELK renderer.
  - Sections as class cards; quantities merged into labels.
  - Expand/collapse via composition edges.
  - Diff classes: `.diff-added`, `.diff-changed`.

Performance tip:
- For diffs, prefer `include_subsections=false` and `allow_cross_module=false` to avoid large layouts.

---

## 5. Common Ops (for contributors)

Add a new endpoint:
- Edit `api/routes_git.py`; mount via `app.include_router(...)` in `api/main.py` if needed.
- For extractor output tied to a branch, use `git_utils.materialize_worktree(branch)` then `graph_runner.build_graph_in_subprocess(...)`.

Change graph building:
- Edit `extractor/graph_builder.py`.  
- Function contract:  
  `build_graph(package: str, root: str|None=None, include_quantities=True, include_subsections=True, allow_cross_module=True, base_namespace: str|None=None) -> dict`

Adjust diff semantics:
- Edit `api/diff.py` (e.g., how “changed” is defined for sections or attributes).

Change diagram behavior or styling:
- Edit `web/src/GraphView.tsx` (Cytoscape styles, label builder, toggling).

---

## 6. Extension Ideas

Show only changed:
- Add a toggle in `App.tsx`; filter elements to (added ∪ changed ∪ neighbors) before rendering.

Export PNG/SVG:
- Use Cytoscape exporters: `cy.png({full:true})`, `cy.svg({full:true})` and trigger download.

Persist repo path (no env vars):
- Add `POST /git/set_repo?path=...` to save a path in `api/_data/repo_path.txt`.
- In `git_utils`, prefer env var if present, else read the saved path.

---

## 7. Operational Notes

Bare mirror location:
- `api/_data/nomad-simulations.bare`

Worktrees:
- `api/_data/nomad-simulations.bare/worktrees/<branch>/...`

Rebuild mirror safely:
- Remove and recreate:
    rm -rf api/_data
    mkdir -p api/_data
    (cd api/_data && git clone --bare "$NOMAD_SIM_REPO" nomad-simulations.bare)

.gitignore:
- Ensure it contains:
    api/_data/

---

## 8. Known Constraints

- Large graphs + ELK may freeze the browser; prefer light diffs for compare.
- Removed quantities are attributes, not nodes; surface them via `diff.attrs` in label or in the side panel.
- Ghost rendering of removed sections can be added but should be limited to visible subtrees to avoid layout blow-up.

---

"""FastAPI app for Schema Studio Light Mode.

- No authentication, single local user.
- Local SQLite persistence for workspace and custom edits.
- Serves built React assets from web/dist.
- Provides Send Design endpoint posting to a configurable receiver.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extractor.graph_builder import _root_namespace, build_graph, list_sections
from extractor.usage_index import get_usage_for_section
from .schema_source import (
    DEFAULT_BRANCH as LIGHT_MODE_BRANCH,
    SchemaUnavailable,
    current_schema_info,
    list_modules_for_base,
    update_schema,
)
from .store import LocalStore, Workspace, PersistedEdit, config_db_path

LIGHT_MODE_USER = "local"
APP_VERSION = os.getenv("SCHEMA_STUDIO_VERSION", "light")
SEND_ENDPOINT = os.getenv("SCHEMA_STUDIO_SEND_ENDPOINT")
DEFAULT_PORT = int(os.getenv("SCHEMA_STUDIO_PORT", "5179"))
DEFAULT_HOST = os.getenv("SCHEMA_STUDIO_HOST", "127.0.0.1")
DEFAULT_PACKAGE = os.getenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", "nomad_simulations.schema_packages.model_method")
DEFAULT_BASE_NS = os.getenv("SCHEMA_STUDIO_DEFAULT_NAMESPACE", "nomad_simulations.schema_packages")

# Keep this list in sync with web/src/components/quantityShared.ts.
SUPPORTED_CUSTOM_DTYPES = {
    "bool",
    "str",
    "datetime",
    "int",
    "float",
    "int32",
    "int64",
    "np.int32",
    "np.int64",
    "float32",
    "float64",
    "np.float32",
    "np.float64",
}

# Prepare persistence
store = LocalStore(
    db_path=config_db_path(),
    defaults=Workspace(branch=LIGHT_MODE_BRANCH, package=DEFAULT_PACKAGE, base_namespace=DEFAULT_BASE_NS),
)

app = FastAPI(title="Schema Studio – Light Mode", default_response_class=JSONResponse)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- helpers ----------


def _serialize_edit(edit: PersistedEdit) -> dict:
    return {
        "id": edit.edit_id,
        "user_id": edit.user_id,
        "branch": edit.branch,
        "package": edit.package,
        "class_name": edit.class_name,
        "quantity_name": edit.quantity_name,
        "dtype": edit.dtype,
        "docstring": edit.docstring,
        "parent_name": edit.parent_name,
        "parent_relation": edit.parent_relation,
        "edit_type": edit.edit_type,
        "base_sha": edit.base_sha,
        "created_at": edit.created_at,
        "updated_at": edit.updated_at,
    }


def _workspace_payload(ws: Workspace) -> dict:
    return {
        "branch": ws.branch,
        "package": ws.package,
        "base_namespace": ws.base_namespace,
    }


def _enforce_light_branch(branch: str | None) -> str:
    if branch and branch != LIGHT_MODE_BRANCH:
        raise HTTPException(
            status_code=400,
            detail=f"Branch switching is disabled in Light Mode; only '{LIGHT_MODE_BRANCH}' is allowed.",
        )
    return LIGHT_MODE_BRANCH


def _workspace() -> Workspace:
    ws = store.get_workspace()
    if ws.branch != LIGHT_MODE_BRANCH:
        ws = store.update_workspace(branch=LIGHT_MODE_BRANCH)
    return ws


def _attach_custom_quantity(graph: dict, req) -> dict:
    if req.dtype not in SUPPORTED_CUSTOM_DTYPES:
        allowed = ", ".join(sorted(SUPPORTED_CUSTOM_DTYPES))
        raise HTTPException(status_code=400, detail=f"Unsupported dtype '{req.dtype}'. Supported: {allowed}")

    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    target_section = None
    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("label") != req.class_name:
            continue
        module = node.get("module") or ""
        if module.startswith(req.package):
            target_section = node
            break

    if target_section is None:
        if not req.parent_name:
            raise HTTPException(
                status_code=404,
                detail=f"Section '{req.class_name}' not found in package '{req.package}'",
            )

        new_id = f"{req.package}.{req.class_name}"
        target_section = {
            "id": new_id,
            "kind": "section",
            "label": req.class_name,
            "doc": None,
            "module": req.package,
        }
        nodes = nodes + [target_section]

        parent = next(
            (
                n
                for n in nodes
                if n.get("kind") == "section"
                and (n.get("id") == req.parent_name or n.get("label") == req.parent_name)
            ),
            None,
        )
        parent_id = parent.get("id") if parent else req.parent_name
        relation = req.parent_relation or "inherits"
        edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": None}]

    section_id = target_section["id"]
    for node in nodes:
        if node.get("kind") == "quantity" and node.get("owner") == section_id and node.get("label") == req.quantity_name:
            raise HTTPException(
                status_code=400,
                detail=f"Quantity '{req.quantity_name}' already exists on section '{req.class_name}'",
            )

    qid = f"{section_id}.{req.quantity_name}"
    new_node = {
        "id": qid,
        "kind": "quantity",
        "label": req.quantity_name,
        "doc": req.docstring or None,
        "dtype": req.dtype,
        "owner": section_id,
        "module": target_section.get("module"),
    }
    graph = dict(graph)
    graph["nodes"] = nodes + [new_node]
    graph["edges"] = edges + [{"source": section_id, "target": qid, "type": "hasQuantity", "card": None}]
    return graph


def _attach_custom_class(graph: dict, req) -> dict:
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("label") == req.name or node.get("id") == req.name:
            raise HTTPException(status_code=400, detail=f"Class '{req.name}' already exists")

    new_id = f"{req.package}.{req.name}"
    new_node = {
        "id": new_id,
        "kind": "section",
        "label": req.name,
        "doc": req.docstring or None,
        "module": req.package,
    }
    nodes = nodes + [new_node]

    if req.parent:
        parent = next((n for n in nodes if n.get("id") == req.parent or n.get("label") == req.parent), None)
        parent_id = parent.get("id") if parent else req.parent
        relation = req.relation if req.relation in ("inherits", "hasSubSection") else "inherits"
        edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": None}]

    graph = dict(graph)
    graph["nodes"] = nodes
    graph["edges"] = edges
    return graph


def _apply_persisted_edits(graph: dict, edits: list[PersistedEdit]) -> tuple[dict, list[dict]]:
    conflicts: list[dict] = []
    sorted_edits = sorted(edits, key=lambda e: 0 if e.edit_type == "class" else 1)
    for edit in sorted_edits:
        try:
            if edit.edit_type == "class":
                graph = _attach_custom_class(
                    graph,
                    type(
                        "Obj",
                        (),
                        {
                            "package": edit.package,
                            "name": edit.class_name,
                            "parent": edit.parent_name,
                            "relation": edit.parent_relation or "inherits",
                            "docstring": edit.docstring,
                        },
                    )(),
                )
            else:
                graph = _attach_custom_quantity(
                    graph,
                    type(
                        "Obj",
                        (),
                        {
                            "package": edit.package,
                            "class_name": edit.class_name,
                            "quantity_name": edit.quantity_name or "",
                            "dtype": edit.dtype or "str",
                            "docstring": edit.docstring,
                            "parent_name": edit.parent_name,
                            "parent_relation": edit.parent_relation,
                        },
                    )(),
                )
        except HTTPException as exc:
            conflicts.append({"edit": _serialize_edit(edit), "reason": "validation_error", "detail": exc.detail})
    return graph, conflicts


def _applied_edits(persisted: list[PersistedEdit], apply_conflicts: list[dict]) -> list[PersistedEdit]:
    conflict_keys: set[tuple[str, str, str | None]] = set()
    for conflict in apply_conflicts or []:
        edit_obj = conflict.get("edit") if isinstance(conflict, dict) else None
        if not isinstance(edit_obj, dict):
            continue
        edit_id = edit_obj.get("id")
        if edit_id:
            conflict_keys.add(("id", str(edit_id), None))
            continue
        signature = (
            edit_obj.get("edit_type") or "",
            edit_obj.get("class_name") or "",
            edit_obj.get("quantity_name") or None,
        )
        conflict_keys.add(signature)

    def _key(e: PersistedEdit) -> tuple[str, str, str | None]:
        if e.edit_id is not None:
            return ("id", str(e.edit_id), None)
        return (e.edit_type or "", e.class_name or "", e.quantity_name or None)

    return [edit for edit in persisted if _key(edit) not in conflict_keys]


def _apply_custom_edits(graph: dict, edits: list[PersistedEdit]) -> tuple[dict, list[dict]]:
    graph_with_edits, conflicts = _apply_persisted_edits(graph, edits)
    applied = _applied_edits(edits, conflicts)
    if applied:
        graph_with_edits = dict(graph_with_edits)
        graph_with_edits["applied_edits"] = [_serialize_edit(e) for e in applied]
    return graph_with_edits, conflicts


# ---------- routes ----------


@app.get("/schema/version")
async def schema_version():
    info = current_schema_info()
    return {"version": info.version, "source": info.source}


@app.post("/schema/update")
async def schema_update():
    try:
        info = update_schema()
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"version": info.version, "source": info.source}


@app.get("/health")
async def health():
    info = current_schema_info()
    return {"ok": True, "mode": "light", "workspace": _workspace_payload(_workspace()), "schema_version": info.version, "schema_source": info.source}


@app.get("/workspace")
async def get_workspace():
    info = current_schema_info()
    return {"workspace": _workspace_payload(_workspace()), "user": {"username": LIGHT_MODE_USER}, "schema_version": info.version}


@app.put("/workspace")
async def update_workspace(branch: str | None = None, package: str | None = None, base_namespace: str | None = None):
    _enforce_light_branch(branch)
    ws = store.update_workspace(
        branch=LIGHT_MODE_BRANCH,
        package=package,
        base_namespace=base_namespace,
    )
    return {"workspace": _workspace_payload(ws), "user": {"username": LIGHT_MODE_USER}}


@app.get("/roots")
async def roots(package: str | None = Query(None)):
    ws = _workspace()
    pkg = package or ws.package
    try:
        return {"package": pkg, "sections": sorted(list_sections(pkg)), "workspace": _workspace_payload(ws)}
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}")


@app.get("/schema")
async def schema(
    package: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    _ = current_schema_info()  # ensures package import path is ready
    ws = _workspace()
    pkg = package or ws.package
    ns = base_namespace or ws.base_namespace or _root_namespace(pkg)
    if package or base_namespace:
        ws = store.update_workspace(branch=LIGHT_MODE_BRANCH, package=pkg, base_namespace=ns)
    if empty:
        graph = {"package": pkg, "root": root, "nodes": [], "edges": []}
        return graph | {"workspace": _workspace_payload(ws)}
    graph = build_graph(
        package=pkg,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module,
        base_namespace=ns,
    )
    edits = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=pkg)
    graph, conflicts = _apply_custom_edits(graph, edits)
    response = graph | {"workspace": _workspace_payload(ws)}
    if conflicts:
        response["edit_conflicts"] = conflicts
    return response


@app.post("/schema/custom-class")
async def add_custom_class(
    package: str,
    name: str,
    parent: str | None = None,
    relation: Literal["inherits", "hasSubSection"] = "inherits",
    docstring: str | None = None,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    _ = current_schema_info()
    ws = store.update_workspace(
        branch=LIGHT_MODE_BRANCH,
        package=package,
        base_namespace=base_namespace or _root_namespace(package),
    )
    if empty:
        graph = {"package": package, "root": root, "nodes": [], "edges": []}
    else:
        graph = build_graph(
            package=package,
            root=root,
            include_quantities=include_quantities,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=ws.base_namespace,
        )
    edits_before = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=package)
    graph, conflicts = _apply_custom_edits(graph, edits_before)
    graph = _attach_custom_class(graph, type("Obj", (), {"package": package, "name": name, "parent": parent, "relation": relation, "docstring": docstring})())
    saved = store.save_edit(
        edit=PersistedEdit(
            edit_id=None,
            user_id=LIGHT_MODE_USER,
            branch=ws.branch,
            package=package,
            class_name=name,
            parent_name=parent,
            parent_relation=relation,
            docstring=docstring,
            edit_type="class",
        ),
        current_sha=None,
    )
    graph["persisted_edit"] = _serialize_edit(saved)
    graph["workspace"] = _workspace_payload(ws)
    if conflicts:
        graph["edit_conflicts"] = conflicts
    return graph


@app.post("/schema/custom-quantity")
async def add_custom_quantity(
    package: str,
    class_name: str,
    quantity_name: str,
    dtype: str = "str",
    docstring: str | None = None,
    parent_name: str | None = None,
    parent_relation: str | None = None,
    root: str | None = Query(None),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    _ = current_schema_info()
    ws = store.update_workspace(
        branch=LIGHT_MODE_BRANCH,
        package=package,
        base_namespace=base_namespace or _root_namespace(package),
    )
    if empty:
        graph = {"package": package, "root": root, "nodes": [], "edges": []}
    else:
        graph = build_graph(
            package=package,
            root=root,
            include_quantities=True,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=ws.base_namespace,
        )
    edits_before = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=package)
    graph, conflicts = _apply_custom_edits(graph, edits_before)
    graph = _attach_custom_quantity(
        graph,
        type(
            "Obj",
            (),
            {
                "package": package,
                "class_name": class_name,
                "quantity_name": quantity_name,
                "dtype": dtype,
                "docstring": docstring,
                "parent_name": parent_name,
                "parent_relation": parent_relation,
            },
        )(),
    )
    saved = store.save_edit(
        edit=PersistedEdit(
            edit_id=None,
            user_id=LIGHT_MODE_USER,
            branch=ws.branch,
            package=package,
            class_name=class_name,
            quantity_name=quantity_name,
            dtype=dtype,
            docstring=docstring,
            parent_name=parent_name,
            parent_relation=parent_relation,
            edit_type="quantity",
        ),
        current_sha=None,
    )
    graph["persisted_edit"] = _serialize_edit(saved)
    graph["workspace"] = _workspace_payload(ws)
    if conflicts:
        graph["edit_conflicts"] = conflicts
    return graph


@app.delete("/schema/custom-edits")
async def clear_custom_edits(package: str | None = Query(None), branch: str | None = Query(None)):
    _enforce_light_branch(branch)
    ws = _workspace()
    pkg = package or ws.package
    deleted = store.delete_edits(user_id=LIGHT_MODE_USER, branch=LIGHT_MODE_BRANCH, package=pkg)
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.get("/git/branches")
async def git_branches():
    raise HTTPException(status_code=410, detail="Branch switching is disabled in Light Mode.")


@app.get("/git/packages")
async def git_packages(base_package: str | None = Query(None), branch: str | None = Query(None)):
    _enforce_light_branch(branch)
    ws = _workspace()
    base = base_package or ws.base_namespace
    _ = current_schema_info()
    modules = list_modules_for_base(base)
    packages = sorted(modules) if modules else [ws.package]
    return {
        "packages": packages,
        "base_package": base,
        "branch": LIGHT_MODE_BRANCH,
        "workspace": _workspace_payload(ws),
    }


@app.get("/overview")
async def overview(branch: str | None = Query(None), base: str | None = Query(None)):
    """
    Bird's-eye overview: list packages under `base` with their top-level classes.
    Light Mode version: uses the local worktree only (no git checkout per branch).
    """
    _enforce_light_branch(branch)
    ws = _workspace()
    base_to_use = base or ws.base_namespace or DEFAULT_BASE_NS
    branch_to_use = LIGHT_MODE_BRANCH
    _ = current_schema_info()

    bases = [b.strip() for b in base_to_use.split(",") if b.strip()]
    items: list[dict] = []
    for base_pkg in bases:
        modules = list_modules_for_base(base_pkg)
        for mod in modules:
            try:
                classes = list_sections(mod)
            except Exception:
                continue
            if not classes:
                continue
            items.append({"package": mod, "classes": sorted(classes)})

    return {"branch": branch_to_use, "base": base_to_use, "items": items, "workspace": _workspace_payload(ws)}


@app.get("/usage")
async def usage(section_id: str = Query(..., description="Fully qualified section class name")):
    ws = _workspace()
    entries = get_usage_for_section(section_id)
    payload = [
        {
            "kind": e.kind,
            "qualname": e.qualname,
            "module": e.module,
            "short_name": e.short_name,
            "doc": e.doc,
        }
        for e in entries
    ]
    return {"usage": payload, "workspace": _workspace_payload(ws)}


@app.post("/send-design")
async def send_design(payload: dict):
    """Forward current schema to the configured endpoint."""
    if not SEND_ENDPOINT:
        raise HTTPException(status_code=503, detail="SEND_ENDPOINT_NOT_CONFIGURED")

    info = current_schema_info()
    envelope = {
        "schema": payload.get("schema"),
        "app_version": APP_VERSION,
        "timestamp": payload.get("timestamp") or __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "note": payload.get("note"),
        "schema_version": info.version,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(SEND_ENDPOINT, json=envelope)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"Upstream unreachable: {exc}")

    try:
        data = resp.json()
    except Exception:  # pragma: no cover
        data = {}

    submission_id = data.get("submission_id") if isinstance(data, dict) else None
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data or resp.text)

    return {"submission_id": submission_id, "upstream_status": resp.status_code}


# ---------- static files ----------


def _dist_path() -> Path:
    # Prefer explicit override
    env_dist = os.getenv("SCHEMA_STUDIO_DIST_DIR")
    if env_dist:
        cand = Path(env_dist)
        if cand.exists():
            return cand
    here = Path(__file__).resolve().parent
    packaged = here / "static"
    if packaged.exists():
        return packaged
    repo_dist = here.parent.parent / "web" / "dist"
    return repo_dist


dist_dir = _dist_path()
if dist_dir.exists():
    app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")


@app.get("/")
async def root_index():
    index = dist_dir / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"message": "Schema Studio Light Mode", "mode": "light"}


@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    # Serve SPA index for any unknown path so React Router works.
    index = dist_dir / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Not found")

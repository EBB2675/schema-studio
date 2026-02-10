"""FastAPI app for Schema Studio Light Mode.

- No authentication, single local user.
- Local SQLite persistence for workspace and custom edits.
- Serves built React assets from web/dist.
- Provides Send Design endpoint posting to a configurable receiver.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extractor.graph_builder import _root_namespace, build_graph, list_sections
from api.repo_utils import list_modules_under, python_root
from .schema_source import current_schema_info, ensure_schema_ready, update_schema, SchemaUnavailable
from .store import LocalStore, Workspace, PersistedEdit, config_db_path

LIGHT_MODE_USER = "local"
APP_VERSION = os.getenv("SCHEMA_STUDIO_VERSION", "light")
SEND_ENDPOINT = os.getenv("SCHEMA_STUDIO_SEND_ENDPOINT")
DEFAULT_PORT = int(os.getenv("SCHEMA_STUDIO_PORT", "5179"))
DEFAULT_HOST = os.getenv("SCHEMA_STUDIO_HOST", "127.0.0.1")
DEFAULT_PACKAGE = os.getenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", "nomad_simulations.schema_packages.model_method")
DEFAULT_BASE_NS = os.getenv("SCHEMA_STUDIO_DEFAULT_NAMESPACE", "nomad_simulations.schema_packages")
DEFAULT_BRANCH = os.getenv("SCHEMA_STUDIO_DEFAULT_BRANCH", "develop")

# Prepare schema baseline once (no automatic updates beyond bundled ref)
schema_info = ensure_schema_ready()

# Prepare persistence
store = LocalStore(
    db_path=config_db_path(),
    defaults=Workspace(branch=DEFAULT_BRANCH, package=DEFAULT_PACKAGE, base_namespace=DEFAULT_BASE_NS),
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


def _apply_custom_edits(graph: dict, edits: list[PersistedEdit]) -> tuple[dict, list[dict]]:
    from api.main import _apply_persisted_edits, _applied_edits  # reuse logic

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
    return {"ok": True, "mode": "light", "workspace": _workspace_payload(store.get_workspace()), "schema_version": info.version, "schema_source": info.source}


@app.get("/workspace")
async def get_workspace():
    info = current_schema_info()
    return {"workspace": _workspace_payload(store.get_workspace()), "user": {"username": LIGHT_MODE_USER}, "schema_version": info.version}


@app.put("/workspace")
async def update_workspace(branch: str | None = None, package: str | None = None, base_namespace: str | None = None):
    ws = store.update_workspace(branch=branch, package=package, base_namespace=base_namespace)
    return {"workspace": _workspace_payload(ws), "user": {"username": LIGHT_MODE_USER}}


@app.get("/roots")
async def roots(package: str | None = Query(None)):
    pkg = package or store.get_workspace().package
    try:
        return {"package": pkg, "sections": sorted(list_sections(pkg)), "workspace": _workspace_payload(store.get_workspace())}
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
    info = current_schema_info()  # ensures local worktree + sys.path are ready
    ws = store.get_workspace()
    pkg = package or ws.package
    ns = base_namespace or ws.base_namespace or _root_namespace(pkg)
    if package or base_namespace:
        ws = store.update_workspace(package=pkg, base_namespace=ns)
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
    from api.main import _attach_custom_class

    info = current_schema_info()
    ws = store.update_workspace(package=package, base_namespace=base_namespace or _root_namespace(package))
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
    from api.main import _attach_custom_quantity
    info = current_schema_info()
    ws = store.update_workspace(package=package, base_namespace=base_namespace or _root_namespace(package))
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
    ws = store.get_workspace()
    pkg = package or ws.package
    br = branch or ws.branch
    deleted = store.delete_edits(user_id=LIGHT_MODE_USER, branch=br, package=pkg)
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.get("/git/branches")
async def git_branches():
    ws = store.get_workspace()
    return {"branches": [ws.branch], "active": ws.branch, "head": None, "workspace": _workspace_payload(ws)}


@app.get("/git/packages")
async def git_packages(base_package: str | None = Query(None), branch: str | None = Query(None)):
    ws = store.get_workspace()
    base = base_package or ws.base_namespace
    info = current_schema_info()
    py_root = python_root(Path(info.worktree))
    modules = list_modules_under(py_root, base)
    packages = sorted(modules) if modules else [ws.package]
    return {
        "packages": packages,
        "base_package": base,
        "branch": branch or ws.branch,
        "workspace": _workspace_payload(ws),
    }


@app.get("/overview")
async def overview(branch: str | None = Query(None), base: str | None = Query(None)):
    """
    Bird's-eye overview: list packages under `base` with their top-level classes.
    Light Mode version: uses the local worktree only (no git checkout per branch).
    """
    ws = store.get_workspace()
    base_to_use = base or ws.base_namespace or DEFAULT_BASE_NS
    branch_to_use = branch or ws.branch or DEFAULT_BRANCH
    info = current_schema_info()
    py_root = python_root(Path(info.worktree))

    bases = [b.strip() for b in base_to_use.split(",") if b.strip()]
    items: list[dict] = []
    for base_pkg in bases:
        modules = list_modules_under(py_root, base_pkg)
        for mod in modules:
            try:
                classes = list_sections(mod)
            except Exception:
                continue
            if not classes:
                continue
            items.append({"package": mod, "classes": sorted(classes)})

    return {"branch": branch_to_use, "base": base_to_use, "items": items, "workspace": _workspace_payload(ws)}


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

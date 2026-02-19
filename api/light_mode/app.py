"""FastAPI app for Schema Studio Light Mode.

- No authentication, single local user.
- Local SQLite persistence for workspace and custom edits.
- Serves built React assets from web/dist.
- Provides Send Design endpoint posting to a configurable receiver.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from threading import Lock
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from extractor.graph_builder import _root_namespace, build_graph, list_sections
from extractor.usage_index import get_usage_for_section
from .schema_source import (
    DEFAULT_BASE_NAMESPACE as LIGHT_DEFAULT_BASE_NS,
    DEFAULT_BRANCH as LIGHT_MODE_BRANCH,
    DEFAULT_PACKAGE as LIGHT_DEFAULT_PACKAGE,
    LIGHT_PROFILE_KEY,
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
DEFAULT_PACKAGE = os.getenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", LIGHT_DEFAULT_PACKAGE)
DEFAULT_BASE_NS = os.getenv("SCHEMA_STUDIO_DEFAULT_NAMESPACE", LIGHT_DEFAULT_BASE_NS)
AUTO_BOOTSTRAP_SCHEMA = os.getenv("SCHEMA_STUDIO_AUTO_BOOTSTRAP_SCHEMA", "1").lower() not in {"0", "false", "no"}

logger = logging.getLogger(__name__)

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


class CustomClassRequest(BaseModel):
    package: str
    name: str
    parent: str | None = None
    relation: Literal["inherits", "hasSubSection"] = "inherits"
    docstring: str | None = None


class CustomQuantityRequest(BaseModel):
    package: str
    class_name: str
    quantity_name: str
    dtype: str = "str"
    docstring: str | None = None
    parent_name: str | None = None
    parent_relation: str | None = None


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

_bootstrap_lock = Lock()
_bootstrap_attempted = False


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


def _schema_info(*, auto_bootstrap: bool = True):
    """
    Return schema metadata, optionally attempting a one-time automatic bootstrap.
    Bootstrap is used to avoid first-run empty package lists when the schema package
    is not yet installed or violates Light Mode policy.
    """
    global _bootstrap_attempted
    try:
        return current_schema_info()
    except SchemaUnavailable as exc:
        if not auto_bootstrap:
            raise
        with _bootstrap_lock:
            try:
                # Another request may have fixed this while we were waiting.
                return current_schema_info()
            except SchemaUnavailable:
                if _bootstrap_attempted:
                    raise exc
                _bootstrap_attempted = True
                logger.info("Light Mode schema not ready; attempting one-time bootstrap via update_schema()")
                try:
                    info = update_schema()
                    logger.info("Light Mode schema bootstrap completed (%s)", info.version)
                    return info
                except SchemaUnavailable:
                    raise exc


def _schema_info_or_503(*, auto_bootstrap: bool = True):
    try:
        return _schema_info(auto_bootstrap=auto_bootstrap)
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))


def _resolve_custom_class_request(
    req: CustomClassRequest | None,
    *,
    package: str | None,
    name: str | None,
    parent: str | None,
    relation: Literal["inherits", "hasSubSection"] | None,
    docstring: str | None,
) -> CustomClassRequest:
    if req is not None:
        return req
    if not package or not name:
        raise HTTPException(status_code=422, detail="Missing required fields: package, name")
    return CustomClassRequest(
        package=package,
        name=name,
        parent=parent,
        relation=relation or "inherits",
        docstring=docstring,
    )


def _resolve_custom_quantity_request(
    req: CustomQuantityRequest | None,
    *,
    package: str | None,
    class_name: str | None,
    quantity_name: str | None,
    dtype: str | None,
    docstring: str | None,
    parent_name: str | None,
    parent_relation: str | None,
) -> CustomQuantityRequest:
    if req is not None:
        return req
    if not package or not class_name or not quantity_name:
        raise HTTPException(status_code=422, detail="Missing required fields: package, class_name, quantity_name")
    return CustomQuantityRequest(
        package=package,
        class_name=class_name,
        quantity_name=quantity_name,
        dtype=dtype or "str",
        docstring=docstring,
        parent_name=parent_name,
        parent_relation=parent_relation,
    )


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


@app.on_event("startup")
async def _bootstrap_schema_on_startup():
    if not AUTO_BOOTSTRAP_SCHEMA:
        return
    try:
        _schema_info(auto_bootstrap=True)
    except SchemaUnavailable as exc:
        # Keep server up; user can still call /schema/update manually.
        logger.warning("Light Mode schema bootstrap failed on startup: %s", exc)


@app.get("/schema/version")
async def schema_version():
    info = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
    return {"version": info.version, "source": info.source, "schema_profile": LIGHT_PROFILE_KEY, "send_design_enabled": bool(SEND_ENDPOINT)}


@app.post("/schema/update")
async def schema_update():
    try:
        info = update_schema()
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"version": info.version, "source": info.source}


@app.get("/health")
async def health():
    info = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
    return {
        "ok": True,
        "mode": "light",
        "workspace": _workspace_payload(_workspace()),
        "schema_version": info.version,
        "schema_source": info.source,
        "schema_profile": LIGHT_PROFILE_KEY,
        "send_design_enabled": bool(SEND_ENDPOINT),
    }


@app.get("/workspace")
async def get_workspace():
    info = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
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
    _ = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)  # ensures package import path is ready
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
    req: CustomClassRequest | None = None,
    package: str | None = Query(None),
    name: str | None = Query(None),
    parent: str | None = Query(None),
    relation: Literal["inherits", "hasSubSection"] | None = Query(None),
    docstring: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    req = _resolve_custom_class_request(
        req,
        package=package,
        name=name,
        parent=parent,
        relation=relation,
        docstring=docstring,
    )
    _ = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
    ws = store.update_workspace(
        branch=LIGHT_MODE_BRANCH,
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    if empty:
        graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
    else:
        graph = build_graph(
            package=req.package,
            root=root,
            include_quantities=include_quantities,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=ws.base_namespace,
        )
    edits_before = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=req.package)
    graph, conflicts = _apply_custom_edits(graph, edits_before)
    graph = _attach_custom_class(
        graph,
        type(
            "Obj",
            (),
            {
                "package": req.package,
                "name": req.name,
                "parent": req.parent,
                "relation": req.relation,
                "docstring": req.docstring,
            },
        )(),
    )
    saved = store.save_edit(
        edit=PersistedEdit(
            edit_id=None,
            user_id=LIGHT_MODE_USER,
            branch=ws.branch,
            package=req.package,
            class_name=req.name,
            parent_name=req.parent,
            parent_relation=req.relation,
            docstring=req.docstring,
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
    req: CustomQuantityRequest | None = None,
    package: str | None = Query(None),
    class_name: str | None = Query(None),
    quantity_name: str | None = Query(None),
    dtype: str | None = Query(None),
    docstring: str | None = Query(None),
    parent_name: str | None = Query(None),
    parent_relation: str | None = Query(None),
    root: str | None = Query(None),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    req = _resolve_custom_quantity_request(
        req,
        package=package,
        class_name=class_name,
        quantity_name=quantity_name,
        dtype=dtype,
        docstring=docstring,
        parent_name=parent_name,
        parent_relation=parent_relation,
    )
    _ = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
    ws = store.update_workspace(
        branch=LIGHT_MODE_BRANCH,
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    if empty:
        graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
    else:
        graph = build_graph(
            package=req.package,
            root=root,
            include_quantities=True,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=ws.base_namespace,
        )
    edits_before = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=req.package)
    graph, conflicts = _apply_custom_edits(graph, edits_before)
    graph = _attach_custom_quantity(
        graph,
        type(
            "Obj",
            (),
            {
                "package": req.package,
                "class_name": req.class_name,
                "quantity_name": req.quantity_name,
                "dtype": req.dtype,
                "docstring": req.docstring,
                "parent_name": req.parent_name,
                "parent_relation": req.parent_relation,
            },
        )(),
    )
    saved = store.save_edit(
        edit=PersistedEdit(
            edit_id=None,
            user_id=LIGHT_MODE_USER,
            branch=ws.branch,
            package=req.package,
            class_name=req.class_name,
            quantity_name=req.quantity_name,
            dtype=req.dtype,
            docstring=req.docstring,
            parent_name=req.parent_name,
            parent_relation=req.parent_relation,
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
async def clear_custom_edits(
    package: str | None = Query(None),
    branch: str | None = Query(None),
    all_packages: bool = Query(False),
):
    _enforce_light_branch(branch)
    ws = _workspace()
    target_package = None if all_packages else (package or ws.package)
    deleted = store.delete_edits(user_id=LIGHT_MODE_USER, branch=LIGHT_MODE_BRANCH, package=target_package)
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.delete("/schema/custom-edit")
async def delete_custom_edit(
    package: str | None = Query(None),
    class_name: str = Query(...),
    quantity_name: str | None = Query(None),
    branch: str | None = Query(None),
):
    _enforce_light_branch(branch)
    ws = _workspace()
    target_package = package or ws.package
    deleted = store.delete_edit(
        user_id=LIGHT_MODE_USER,
        branch=LIGHT_MODE_BRANCH,
        package=target_package,
        class_name=class_name,
        quantity_name=quantity_name,
    )
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.get("/git/branches")
async def git_branches():
    raise HTTPException(status_code=410, detail="Branch switching is disabled in Light Mode.")


@app.get("/git/packages")
async def git_packages(base_package: str | None = Query(None), branch: str | None = Query(None)):
    _enforce_light_branch(branch)
    ws = _workspace()
    base = base_package or ws.base_namespace
    _ = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
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
    _ = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)

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

    info = _schema_info_or_503(auto_bootstrap=AUTO_BOOTSTRAP_SCHEMA)
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
        if (cand / "index.html").exists():
            return cand
    here = Path(__file__).resolve().parent
    # In editable/source installs, prefer freshly built repo dist over packaged static.
    repo_dist = here.parent.parent / "web" / "dist"
    if (repo_dist / "index.html").exists():
        return repo_dist
    packaged = here / "static"
    if (packaged / "index.html").exists():
        return packaged
    return repo_dist if repo_dist.exists() else packaged


dist_dir = _dist_path()
logger.info("Serving frontend assets from: %s", dist_dir)
if dist_dir.exists():
    app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")


def _index_file_response(index: Path) -> FileResponse:
    # Ensure SPA shell is always revalidated so UI updates are visible immediately.
    return FileResponse(
        index,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/")
async def root_index():
    index = dist_dir / "index.html"
    if index.exists():
        return _index_file_response(index)
    return {"message": "Schema Studio Light Mode", "mode": "light"}


@app.get("/{full_path:path}")
async def catch_all(full_path: str):
    # Serve SPA index for any unknown path so React Router works.
    index = dist_dir / "index.html"
    if index.exists():
        return _index_file_response(index)
    raise HTTPException(status_code=404, detail="Not found")

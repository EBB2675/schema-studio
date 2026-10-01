"""FastAPI app for Schema Studio Light Mode.

- No authentication, single local user.
- Local SQLite persistence for workspace and custom edits.
- Serves built React assets from web/dist.
- Provides Send Design endpoint posting to a configurable receiver.
"""
from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from ..custom_graph_edits import (
    attach_custom_class as _attach_custom_class_impl,
    attach_custom_quantity as _attach_custom_quantity_impl,
)
from ..sources.legacy import (
    build_graph,
    get_usage_for_section,
    list_schema_modules,
    list_sections,
    root_namespace as _root_namespace,
)
from ..sources.linkml_routes import linkml_download, linkml_report
from ..sources.snapshots import supports_linkml
from .schema_source import (
    DEFAULT_BASE_NAMESPACE as LIGHT_DEFAULT_BASE_NS,
    DEFAULT_PACKAGE as LIGHT_DEFAULT_PACKAGE,
    SchemaUnavailable,
    active_profile,
    current_schema_info,
    list_schema_profiles,
    schema_available,
    schema_profile_for_key,
    schema_profile_for_package,
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
LIGHT_DEFAULT_BRANCH = active_profile().default_branch

logger = logging.getLogger(__name__)

# On some Windows setups, the registry-backed mimetype lookup maps `.js` to
# `text/plain`, which causes modern browsers and WebView2 to reject Vite's ES modules.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")

ASSET_MEDIA_TYPES = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".map": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

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


class WorkspaceUpdate(BaseModel):
    branch: str | None = None
    package: str | None = None
    base_namespace: str | None = None


class CustomClassRequest(BaseModel):
    package: str
    name: str
    parent: str | None = None
    relation: Literal["inherits", "hasSubSection"] = "inherits"
    card: str | None = None
    docstring: str | None = None
    update_existing: bool = False


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
    defaults=Workspace(branch=LIGHT_DEFAULT_BRANCH, package=DEFAULT_PACKAGE, base_namespace=DEFAULT_BASE_NS),
)

app = FastAPI(title="Schema Studio – Light Mode", default_response_class=JSONResponse)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(SchemaUnavailable)
async def _schema_unavailable_handler(_request, exc: SchemaUnavailable):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


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
        "card": edit.card,
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


def _profile_for_workspace(ws: Workspace):
    return schema_profile_for_package(ws.package, ws.base_namespace)


def _expected_light_branch(*, package: str | None, base_namespace: str | None) -> str:
    return schema_profile_for_package(package, base_namespace).default_branch


def _enforce_light_branch(branch: str | None, *, package: str | None, base_namespace: str | None) -> str:
    expected = _expected_light_branch(package=package, base_namespace=base_namespace)
    if branch and branch != expected:
        raise HTTPException(
            status_code=400,
            detail=f"Branch switching is disabled in Light Mode; only '{expected}' is allowed for the selected schema profile.",
        )
    return expected


def _workspace() -> Workspace:
    ws = store.get_workspace()
    expected = _expected_light_branch(package=ws.package, base_namespace=ws.base_namespace)
    if ws.branch != expected:
        ws = store.update_workspace(branch=expected)
    return ws


def _schema_info(*, package: str | None = None, base_namespace: str | None = None):
    """
    Return schema metadata for the profile that owns the package.
    The profile environment is never created or updated here; that only
    happens through POST /schema/update.
    """
    return current_schema_info(schema_profile_for_package(package, base_namespace))


def _schema_info_or_503(*, package: str | None = None, base_namespace: str | None = None):
    try:
        return _schema_info(package=package, base_namespace=base_namespace)
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))


def _schema_status_payload(ws: Workspace) -> dict:
    profile = _profile_for_workspace(ws)
    payload = {
        "schema_profile": profile.key,
        "schema_profile_label": profile.label,
        "schema_ready": False,
        "schema_version": None,
        "schema_source": None,
        "schema_error": None,
    }
    try:
        info = _schema_info(package=ws.package, base_namespace=ws.base_namespace)
    except SchemaUnavailable as exc:
        payload["schema_error"] = str(exc)
        return payload

    payload["schema_ready"] = True
    payload["schema_version"] = info.version
    payload["schema_source"] = info.source
    return payload


def _resolve_custom_class_request(
    req: CustomClassRequest | None,
    *,
    package: str | None,
    name: str | None,
    parent: str | None,
    relation: Literal["inherits", "hasSubSection"] | None,
    card: str | None,
    docstring: str | None,
    update_existing: bool,
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
        card=card,
        docstring=docstring,
        update_existing=update_existing,
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
    return _attach_custom_quantity_impl(graph, req, supported_dtypes=SUPPORTED_CUSTOM_DTYPES)


def _attach_custom_class(graph: dict, req) -> dict:
    return _attach_custom_class_impl(graph, req)


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
                            "card": edit.card,
                            "docstring": edit.docstring,
                            "update_existing": True,
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


def _empty_graph(package: str, root: str | None) -> dict:
    return {"package": package, "root": root, "nodes": [], "edges": []}


def _missing_requested_package(exc: ModuleNotFoundError, package: str) -> bool:
    return exc.name == package or (bool(exc.name) and package.startswith(f"{exc.name}."))


# ---------- routes ----------


@app.get("/schema/profiles")
async def schema_profiles():
    ws = _workspace()
    current_profile = _profile_for_workspace(ws)
    profiles: list[dict] = []
    for profile in list_schema_profiles():
        entry = {
            "key": profile.key,
            "label": profile.label,
            "default_branch": profile.default_branch,
            "default_package": profile.default_package,
            "default_base_namespace": profile.default_base_namespace,
            "default_root": profile.default_root,
            "available": schema_available(profile),
            "current": profile.key == current_profile.key,
            "version": None,
            "source": None,
            "error": None,
            "packaged": False,
            "linkml_export": supports_linkml(profile),
        }
        try:
            info = current_schema_info(profile)
            entry["version"] = info.version
            entry["source"] = info.source
            entry["package_version"] = info.package_version
        except SchemaUnavailable as exc:
            entry["error"] = str(exc)
        profiles.append(entry)

    return {
        "profiles": profiles,
        "workspace": _workspace_payload(ws),
        "current_profile": current_profile.key,
    }


@app.get("/schema/version")
async def schema_version():
    ws = _workspace()
    profile = _profile_for_workspace(ws)
    info = _schema_info_or_503(
        package=ws.package,
        base_namespace=ws.base_namespace,
    )
    return {
        "version": info.version,
        "source": info.source,
        "schema_profile": profile.key,
        "send_design_enabled": bool(SEND_ENDPOINT),
    }


@app.get("/schema/linkml")
async def schema_linkml(package: str | None = Query(None, description="Schema module; the profile's base namespace exports the whole profile")):
    """Download the module's schema as LinkML YAML."""
    return await linkml_download(package or _workspace().package)


@app.get("/schema/linkml/report")
async def schema_linkml_report(package: str | None = Query(None)):
    """What did not convert cleanly into LinkML, for the module."""
    return await linkml_report(package or _workspace().package)


@app.post("/schema/update")
async def schema_update(profile: str | None = Query(None)):
    ws = _workspace()
    selected = schema_profile_for_key(profile) if profile else _profile_for_workspace(ws)
    try:
        # Creating or updating an environment can take minutes; keep the server responsive.
        info = await run_in_threadpool(update_schema, selected)
    except SchemaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"version": info.version, "source": info.source, "schema_profile": selected.key}


@app.get("/health")
async def health():
    ws = _workspace()
    schema_status = _schema_status_payload(ws)
    return {
        "ok": True,
        "mode": "light",
        "workspace": _workspace_payload(ws),
        **schema_status,
        "send_design_enabled": bool(SEND_ENDPOINT),
    }


@app.get("/workspace")
async def get_workspace():
    ws = _workspace()
    payload = {"workspace": _workspace_payload(ws), "user": {"username": LIGHT_MODE_USER}}
    payload.update(_schema_status_payload(ws))
    return payload


@app.put("/workspace")
async def update_workspace(
    req: WorkspaceUpdate | None = None,
    branch: str | None = Query(None),
    package: str | None = Query(None),
    base_namespace: str | None = Query(None),
):
    # The web app sends a JSON body (as in Dev Mode); query parameters keep working.
    if req is not None:
        branch = branch or req.branch
        package = package or req.package
        base_namespace = base_namespace or req.base_namespace
    current = _workspace()
    target_package = package or current.package
    target_base_namespace = base_namespace or current.base_namespace
    target_branch = _enforce_light_branch(
        branch,
        package=target_package,
        base_namespace=target_base_namespace,
    )
    ws = store.update_workspace(
        branch=target_branch,
        package=target_package,
        base_namespace=target_base_namespace,
    )
    return {"workspace": _workspace_payload(ws), "user": {"username": LIGHT_MODE_USER}}


@app.get("/roots")
async def roots(package: str | None = Query(None)):
    ws = _workspace()
    pkg = package or ws.package
    _ = _schema_info_or_503(
        package=pkg,
        base_namespace=ws.base_namespace,
    )
    try:
        sections = await run_in_threadpool(list_sections, pkg)
        return {"package": pkg, "sections": sorted(sections), "workspace": _workspace_payload(ws)}
    except SchemaUnavailable:
        raise
    except ModuleNotFoundError as exc:
        if pkg.endswith(".custom_schema") and _missing_requested_package(exc, pkg):
            return {"package": pkg, "sections": [], "workspace": _workspace_payload(ws)}
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}") from exc
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
    ws = _workspace()
    pkg = package or ws.package
    ns = base_namespace or ws.base_namespace or _root_namespace(pkg)
    branch = _expected_light_branch(package=pkg, base_namespace=ns)
    _ = _schema_info_or_503(
        package=pkg,
        base_namespace=ns,
    )
    if package or base_namespace:
        ws = store.update_workspace(branch=branch, package=pkg, base_namespace=ns)
    edits = store.list_edits(user_id=LIGHT_MODE_USER, branch=ws.branch, package=pkg)
    if empty:
        graph = _empty_graph(pkg, root)
    else:
        try:
            graph = await run_in_threadpool(
                build_graph,
                package=pkg,
                root=root,
                include_quantities=include_quantities,
                include_subsections=include_subsections,
                include_inheritance=include_inheritance,
                allow_cross_module=allow_cross_module,
                base_namespace=ns,
            )
        except ModuleNotFoundError as exc:
            if not _missing_requested_package(exc, pkg) or (not edits and not pkg.endswith(".custom_schema")):
                raise
            graph = _empty_graph(pkg, root)
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
    card: str | None = Query(None),
    docstring: str | None = Query(None),
    update_existing: bool = Query(False),
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
        card=card,
        docstring=docstring,
        update_existing=update_existing,
    )
    _ = _schema_info_or_503(
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    branch = _expected_light_branch(
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    ws = store.update_workspace(
        branch=branch,
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    if empty:
        graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
    else:
        graph = await run_in_threadpool(
            build_graph,
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
                "card": req.card,
                "docstring": req.docstring,
                "update_existing": req.update_existing,
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
            card=req.card if req.relation == "hasSubSection" else None,
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
    _ = _schema_info_or_503(
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    branch = _expected_light_branch(
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    ws = store.update_workspace(
        branch=branch,
        package=req.package,
        base_namespace=base_namespace or _root_namespace(req.package),
    )
    if empty:
        graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
    else:
        graph = await run_in_threadpool(
            build_graph,
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
    ws = _workspace()
    expected_branch = _enforce_light_branch(
        branch,
        package=package or ws.package,
        base_namespace=ws.base_namespace,
    )
    target_package = None if all_packages else (package or ws.package)
    deleted = store.delete_edits(user_id=LIGHT_MODE_USER, branch=expected_branch, package=target_package)
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.delete("/schema/custom-edit")
async def delete_custom_edit(
    package: str | None = Query(None),
    class_name: str = Query(...),
    quantity_name: str | None = Query(None),
    branch: str | None = Query(None),
):
    ws = _workspace()
    target_package = package or ws.package
    expected_branch = _enforce_light_branch(
        branch,
        package=target_package,
        base_namespace=ws.base_namespace,
    )
    deleted = store.delete_edit(
        user_id=LIGHT_MODE_USER,
        branch=expected_branch,
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
    ws = _workspace()
    base = base_package or ws.base_namespace
    expected_branch = _enforce_light_branch(branch, package=ws.package, base_namespace=base)
    _ = _schema_info_or_503(
        package=ws.package,
        base_namespace=base,
    )
    modules = await run_in_threadpool(list_schema_modules, base)
    packages = sorted(module["package"] for module in modules) if modules else [ws.package]
    return {
        "packages": packages,
        "base_package": base,
        "branch": expected_branch,
        "workspace": _workspace_payload(ws),
    }


@app.get("/overview")
async def overview(branch: str | None = Query(None), base: str | None = Query(None)):
    """
    Bird's-eye overview: list packages under `base` with their top-level classes.
    Light Mode version: reads the installed schema of the profile (no git checkout per branch).
    """
    ws = _workspace()
    base_to_use = base or ws.base_namespace or DEFAULT_BASE_NS
    branch_to_use = _enforce_light_branch(branch, package=ws.package, base_namespace=base_to_use)
    _ = _schema_info_or_503(
        package=ws.package,
        base_namespace=base_to_use,
    )

    bases = [b.strip() for b in base_to_use.split(",") if b.strip()]
    items: list[dict] = []
    for base_pkg in bases:
        try:
            modules = await run_in_threadpool(list_schema_modules, base_pkg)
        except Exception:
            # One namespace that cannot be read must not hide the others.
            logger.info("Overview skipped namespace '%s'", base_pkg, exc_info=True)
            continue
        for module in modules:
            items.append({"package": module["package"], "classes": sorted(module["sections"])})

    return {"branch": branch_to_use, "base": base_to_use, "items": items, "workspace": _workspace_payload(ws)}


@app.get("/usage")
async def usage(section_id: str = Query(..., description="Fully qualified section class name")):
    ws = _workspace()
    entries = await run_in_threadpool(get_usage_for_section, section_id)
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

    ws = _workspace()
    info = _schema_info_or_503(
        package=ws.package,
        base_namespace=ws.base_namespace,
    )
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
    # Default to bundled static assets so source installs do not require frontend builds.
    packaged = here / "static"
    if (packaged / "index.html").exists():
        return packaged
    # Fallback for local development when packaged static is unavailable.
    repo_dist = here.parent.parent / "web" / "dist"
    if (repo_dist / "index.html").exists():
        return repo_dist
    return packaged if packaged.exists() else repo_dist


dist_dir = _dist_path()
logger.info("Serving frontend assets from: %s", dist_dir)


def _asset_file_response(asset_path: Path) -> FileResponse:
    media_type = ASSET_MEDIA_TYPES.get(asset_path.suffix.lower())
    return FileResponse(
        asset_path,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


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


@app.get("/assets/{asset_path:path}")
async def static_assets(asset_path: str):
    target = (dist_dir / "assets" / asset_path).resolve()
    assets_root = (dist_dir / "assets").resolve()
    try:
        target.relative_to(assets_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return _asset_file_response(target)


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

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
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from ..sources import editing
from ..sources.extraction import list_schema_modules
from ..sources.graph import expand_names
from ..sources.legacy import ExtractionFailed, UnknownRoot
from ..sources.legacy import root_namespace as _root_namespace
from ..sources.linkml_routes import edit_error, linkml_download, linkml_report
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
from .store import LocalStore, Workspace, config_db_path

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

class WorkspaceUpdate(BaseModel):
    branch: str | None = None
    package: str | None = None
    base_namespace: str | None = None


class EditRequest(BaseModel):
    op: str
    target: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)


class EditsRequest(BaseModel):
    package: str | None = None
    edits: list[EditRequest]


class EditIds(BaseModel):
    ids: list[int] = Field(default_factory=list)


# Prepare persistence
store = LocalStore(
    db_path=config_db_path(),
    defaults=Workspace(
        branch=LIGHT_DEFAULT_BRANCH, package=DEFAULT_PACKAGE, base_namespace=DEFAULT_BASE_NS,
        profile=schema_profile_for_package(DEFAULT_PACKAGE, DEFAULT_BASE_NS).key,
    ),
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


@app.exception_handler(UnknownRoot)
async def _unknown_root_handler(_request, exc: UnknownRoot):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ExtractionFailed)
async def _extraction_failed_handler(_request, exc: ExtractionFailed):
    # A JSON answer the web app can show, instead of a bare server error.
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# ---------- helpers ----------


def _workspace_payload(ws: Workspace) -> dict:
    return {
        "profile": ws.profile,
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
    profile = _profile_for_workspace(ws)
    if ws.branch != profile.default_branch or ws.profile != profile.key:
        ws = store.update_workspace(branch=profile.default_branch, profile=profile.key)
    return ws


def _set_workspace(*, package: str, base_namespace: str) -> Workspace:
    """Point the workspace at a module; the profile and branch follow from it."""
    profile = schema_profile_for_package(package, base_namespace)
    return store.update_workspace(
        branch=profile.default_branch, package=package, base_namespace=base_namespace, profile=profile.key,
    )


def _stored_edits(package: str, base_namespace: str | None = None) -> list[dict]:
    """Every edit of the module's profile: each module's graph replays them all (see `editing`)."""
    profile = schema_profile_for_package(package, base_namespace)
    return store.list_edits(user_id=LIGHT_MODE_USER, profile=profile.key)


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
            "capabilities": sorted(profile.capabilities),
            "editable": supports_linkml(profile) and editing.editable(profile),
            "edit_rules": editing.rules_summary(profile),
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
async def schema_linkml(
    package: str | None = Query(None, description="Schema module; the profile's base namespace exports the whole profile"),
    edits: bool = Query(True, description="Include the module's edits"),
):
    """Download the module's schema as LinkML YAML, with its edits unless `edits=false`."""
    pkg = package or _workspace().package
    return await linkml_download(pkg, _stored_edits(pkg) if edits else ())


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
    _enforce_light_branch(branch, package=target_package, base_namespace=target_base_namespace)
    ws = _set_workspace(package=target_package, base_namespace=target_base_namespace)
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
        sections = await run_in_threadpool(editing.list_sections, pkg, _stored_edits(pkg, ws.base_namespace))
        return {"package": pkg, "sections": sorted(sections), "workspace": _workspace_payload(ws)}
    except SchemaUnavailable:
        raise
    except ModuleNotFoundError as exc:
        if pkg.endswith(".custom_schema") and _missing_requested_package(exc, pkg):
            return {"package": pkg, "sections": [], "workspace": _workspace_payload(ws)}
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}") from exc
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}")


async def _graph_response(
    package: str,
    ws: Workspace,
    *,
    root: str | None,
    include_quantities: bool,
    include_subsections: bool,
    include_inheritance: bool,
    allow_cross_module: bool,
    base_namespace: str,
    empty: bool,
    stored: list[dict] | None = None,
    expand: str | None = None,
) -> dict:
    """The module's graph from its edited schema (the stored edits, unless given), with the workspace."""
    if stored is None:
        stored = _stored_edits(package, base_namespace)
    try:
        graph = await run_in_threadpool(
            editing.build_graph,
            package,
            stored,
            root=root,
            include_quantities=include_quantities,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=base_namespace,
            empty=empty,
            expand=expand_names(expand),
        )
    except ModuleNotFoundError as exc:
        if not _missing_requested_package(exc, package):
            raise
        graph = _empty_graph(package, root)
    return graph | {"workspace": _workspace_payload(ws)}


@app.get("/schema")
async def schema(
    package: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    expand: str | None = Query(None, description="Comma-separated classes whose subclasses are drawn"),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    ws = _workspace()
    pkg = package or ws.package
    ns = base_namespace or ws.base_namespace or _root_namespace(pkg)
    _ = _schema_info_or_503(
        package=pkg,
        base_namespace=ns,
    )
    if package or base_namespace:
        ws = _set_workspace(package=pkg, base_namespace=ns)
    return await _graph_response(
        pkg, ws, root=root, include_quantities=include_quantities, include_subsections=include_subsections,
        include_inheritance=include_inheritance, allow_cross_module=allow_cross_module, base_namespace=ns, empty=empty,
        expand=expand,
    )


@app.get("/schema/edits")
async def list_schema_edits(package: str | None = Query(None)):
    """The module's stored edits, in order, and the edit rules of its profile."""
    ws = _workspace()
    pkg = package or ws.package
    profile = schema_profile_for_package(pkg, ws.base_namespace)
    return {
        "package": pkg,
        "profile": profile.key,
        "edits": store.list_edits(user_id=LIGHT_MODE_USER, profile=profile.key, package=pkg),
        "rules": editing.rules_summary(profile),
        "workspace": _workspace_payload(ws),
    }


@app.post("/schema/edits")
async def add_schema_edits(
    req: EditsRequest,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    expand: str | None = Query(None, description="Comma-separated classes whose subclasses are drawn"),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
):
    """Check and store edits (all or none), then return the module's graph with them."""
    ws = _workspace()
    pkg = req.package or ws.package
    ns = base_namespace or (ws.base_namespace if pkg == ws.package else None) or _root_namespace(pkg)
    _ = _schema_info_or_503(package=pkg, base_namespace=ns)
    ws = _set_workspace(package=pkg, base_namespace=ns)
    stored = _stored_edits(pkg, ns)
    try:
        prepared = await run_in_threadpool(
            editing.prepare, pkg, stored, [edit.model_dump() for edit in req.edits], base_namespace=ns,
        )
        # A root the edits rename follows its class; one they remove leaves the whole module.
        root = await run_in_threadpool(editing.root_after, pkg, stored, prepared, root, base_namespace=ns)
    except (editing.EditError, editing.EditsUnavailable) as exc:
        raise edit_error(exc)
    # The graph is built before anything is stored, so a failure stores nothing.
    graph = await _graph_response(
        pkg, ws, root=root, include_quantities=include_quantities, include_subsections=include_subsections,
        include_inheritance=include_inheritance, allow_cross_module=allow_cross_module, base_namespace=ns, empty=empty,
        stored=[*stored, *prepared], expand=expand,
    )
    saved = store.add_edits(user_id=LIGHT_MODE_USER, profile=ws.profile, package=pkg, edits=prepared)
    return editing.with_stored(graph, prepared, saved)


@app.delete("/schema/edits/{edit_id}")
async def delete_schema_edit(edit_id: int):
    """Delete one stored edit; later edits that depended on it show up as conflicts."""
    ws = _workspace()
    deleted = store.delete_edits(user_id=LIGHT_MODE_USER, ids=[edit_id])
    return {"deleted": deleted, "workspace": _workspace_payload(ws)}


@app.delete("/schema/edits")
async def clear_schema_edits(
    req: EditIds | None = None,
    package: str | None = Query(None, description="Delete the edits stored under this module"),
    all_packages: bool = Query(False, description="Every module of the package's profile"),
):
    """Delete the edits listed by id and, if a module is named, the module's edits; all or none."""
    ws = _workspace()
    ids = req.ids if req is not None else []
    profile = schema_profile_for_package(package or ws.package, ws.base_namespace)
    deleted = store.delete_edits(
        user_id=LIGHT_MODE_USER, ids=ids, profile=profile.key if (package or all_packages) else None,
        package=package, all_packages=all_packages,
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
    entries = await run_in_threadpool(
        editing.usage_for_section, section_id, ws.package, _stored_edits(ws.package, ws.base_namespace),
    )
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

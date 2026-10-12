"""A server that answers the static site's requests from the shared core, for the parity tests.

The static site (`web/src/static/backend.ts`, with `browser.py` in Pyodide) answers the web app's
requests without a server. This app gives the answers the server-side code (`editing.py`) gives
for the same requests: one workspace and the edits are kept in memory, everything else comes from
`editing`, `extraction` and the LinkML routes, as in Dev Mode.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.schema_profiles import DEFAULT_BASE_NAMESPACE, DEFAULT_PACKAGE, SchemaUnavailable, schema_profile_for_package
from api.sources import editing
from api.sources.extraction import list_schema_modules
from api.sources.graph import expand_names
from api.sources.legacy import ExtractionFailed, UnknownRoot
from api.sources.legacy import root_namespace
from api.sources.linkml_routes import edit_error, linkml_download, linkml_report

USER = "local"


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


def create_app() -> FastAPI:
    """A fresh app: the default profile's default module, and no edits."""
    app = FastAPI()
    workspace = {"package": DEFAULT_PACKAGE, "base_namespace": DEFAULT_BASE_NAMESPACE}
    edits: list[dict[str, Any]] = []
    next_id = [1]

    @app.exception_handler(SchemaUnavailable)
    async def _unavailable(_request, exc):
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(UnknownRoot)
    async def _unknown_root(_request, exc):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(ExtractionFailed)
    async def _failed(_request, exc):
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    def payload() -> dict:
        profile = schema_profile_for_package(workspace["package"], workspace["base_namespace"])
        return {"profile": profile.key, "branch": profile.default_branch, **workspace}

    def set_workspace(package: str, base_namespace: str) -> None:
        workspace.update(package=package, base_namespace=base_namespace)

    def fixed_branch(branch: str | None, package: str, base_namespace: str) -> str:
        expected = schema_profile_for_package(package, base_namespace).default_branch
        if branch and branch != expected:
            raise HTTPException(
                status_code=400,
                detail=f"Branch switching needs the Dev Mode server; only '{expected}' is allowed for the selected schema profile.",
            )
        return expected

    def stored(package: str, base_namespace: str | None = None, *, module_only: bool = False) -> list[dict]:
        """The profile's edits (each module's graph replays them all), or only the module's."""
        profile = schema_profile_for_package(package, base_namespace).key
        return [copy.deepcopy(edit) for edit in edits
                if edit["profile"] == profile and (not module_only or edit["package"] == package)]

    def missing(exc: ModuleNotFoundError, package: str) -> bool:
        return exc.name == package or (bool(exc.name) and package.startswith(f"{exc.name}."))

    async def graph_response(package: str, base_namespace: str, flags: dict, edits_: list[dict]) -> dict:
        try:
            graph = await run_in_threadpool(
                editing.build_graph, package, edits_, base_namespace=base_namespace,
                **{**flags, "expand": expand_names(flags.get("expand"))},
            )
        except ModuleNotFoundError as exc:
            if not missing(exc, package):
                raise
            graph = {"package": package, "root": flags.get("root"), "nodes": [], "edges": []}
        return graph | {"workspace": payload()}

    @app.get("/workspace")
    async def get_workspace():
        return {"workspace": payload(), "user": {"username": USER}}

    @app.put("/workspace")
    async def put_workspace(req: WorkspaceUpdate | None = None):
        req = req or WorkspaceUpdate()
        package = req.package or workspace["package"]
        base_namespace = req.base_namespace or workspace["base_namespace"]
        fixed_branch(req.branch, package, base_namespace)
        set_workspace(package, base_namespace)
        return {"workspace": payload(), "user": {"username": USER}}

    @app.get("/roots")
    async def roots(package: str | None = Query(None)):
        pkg = package or workspace["package"]
        try:
            sections = await run_in_threadpool(editing.list_sections, pkg, stored(pkg, workspace["base_namespace"]))
        except ModuleNotFoundError as exc:
            if pkg.endswith(".custom_schema") and missing(exc, pkg):
                sections = []
            else:
                raise HTTPException(status_code=400, detail=f"{type(exc).__name__}: {exc}") from exc
        return {"package": pkg, "sections": sorted(sections), "workspace": payload()}

    @app.get("/schema")
    async def schema(
        package: str | None = Query(None), root: str | None = Query(None),
        include_quantities: bool = Query(True), include_subsections: bool = Query(True),
        include_inheritance: bool = Query(True), allow_cross_module: bool = Query(True),
        expand: str | None = Query(None), base_namespace: str | None = Query(None), empty: bool = Query(False),
    ):
        pkg = package or workspace["package"]
        ns = base_namespace or workspace["base_namespace"] or root_namespace(pkg)
        if package or base_namespace:
            set_workspace(pkg, ns)
        flags = dict(root=root, include_quantities=include_quantities, include_subsections=include_subsections,
                     include_inheritance=include_inheritance, allow_cross_module=allow_cross_module, empty=empty,
                     expand=expand)
        return await graph_response(pkg, ns, flags, stored(pkg, ns))

    @app.get("/schema/edits")
    async def list_edits(package: str | None = Query(None)):
        pkg = package or workspace["package"]
        profile = schema_profile_for_package(pkg, workspace["base_namespace"])
        return {"package": pkg, "profile": profile.key, "edits": stored(pkg, workspace["base_namespace"], module_only=True),
                "rules": editing.rules_summary(profile), "workspace": payload()}

    @app.post("/schema/edits")
    async def add_edits(
        req: EditsRequest, root: str | None = Query(None),
        include_quantities: bool = Query(True), include_subsections: bool = Query(True),
        include_inheritance: bool = Query(True), allow_cross_module: bool = Query(True),
        expand: str | None = Query(None), base_namespace: str | None = Query(None), empty: bool = Query(False),
    ):
        pkg = req.package or workspace["package"]
        ns = base_namespace or (workspace["base_namespace"] if pkg == workspace["package"] else None) or root_namespace(pkg)
        set_workspace(pkg, ns)
        before = stored(pkg, ns)
        try:
            prepared = await run_in_threadpool(
                editing.prepare, pkg, before, [edit.model_dump() for edit in req.edits], base_namespace=ns)
            root = await run_in_threadpool(editing.root_after, pkg, before, prepared, root, base_namespace=ns)
        except (editing.EditError, editing.EditsUnavailable) as exc:
            raise edit_error(exc)
        flags = dict(root=root, include_quantities=include_quantities, include_subsections=include_subsections,
                     include_inheritance=include_inheritance, allow_cross_module=allow_cross_module, empty=empty,
                     expand=expand)
        graph = await graph_response(pkg, ns, flags, [*before, *prepared])
        now = datetime.now(timezone.utc).isoformat()
        profile = schema_profile_for_package(pkg, ns).key
        saved = []
        for edit in prepared:
            saved.append({"id": next_id[0], "profile": profile, "package": edit.get("package") or pkg,
                          "commit": edit.get("commit"), "op": edit["op"], "target": edit["target"],
                          "payload": copy.deepcopy(edit.get("payload") or {}), "created_at": now})
            next_id[0] += 1
        edits.extend(saved)
        return editing.with_stored(graph, prepared, copy.deepcopy(saved))

    def delete(keep) -> int:
        before = len(edits)
        edits[:] = [edit for edit in edits if keep(edit)]
        return before - len(edits)

    @app.delete("/schema/edits/{edit_id}")
    async def delete_edit(edit_id: int):
        return {"deleted": delete(lambda edit: edit["id"] != edit_id), "workspace": payload()}

    @app.delete("/schema/edits")
    async def clear_edits(req: EditIds | None = None, package: str | None = Query(None), all_packages: bool = Query(False)):
        ids = set(req.ids if req is not None else [])
        profile = schema_profile_for_package(package or workspace["package"], workspace["base_namespace"]).key
        scoped = package is not None or all_packages

        def keep(edit: dict) -> bool:
            if edit["id"] in ids:
                return False
            return not (scoped and edit["profile"] == profile and (all_packages or edit["package"] == package))

        return {"deleted": delete(keep), "workspace": payload()}

    @app.get("/git/packages")
    async def git_packages(base_package: str | None = Query(None), branch: str | None = Query(None)):
        base = base_package or workspace["base_namespace"]
        expected = fixed_branch(branch, workspace["package"], base)
        modules = await run_in_threadpool(list_schema_modules, base)
        packages = sorted(module["package"] for module in modules) if modules else [workspace["package"]]
        return {"packages": packages, "base_package": base, "branch": expected, "workspace": payload()}

    @app.get("/overview")
    async def overview(branch: str | None = Query(None), base: str | None = Query(None)):
        base_to_use = base or workspace["base_namespace"]
        expected = fixed_branch(branch, workspace["package"], base_to_use)
        items = []
        for base_pkg in [b.strip() for b in base_to_use.split(",") if b.strip()]:
            try:
                modules = await run_in_threadpool(list_schema_modules, base_pkg)
            except Exception:
                continue
            items += [{"package": module["package"], "classes": sorted(module["sections"])} for module in modules]
        return {"branch": expected, "base": base_to_use, "items": items, "workspace": payload()}

    @app.get("/usage")
    async def usage(section_id: str = Query(...)):
        entries = await run_in_threadpool(
            editing.usage_for_section, section_id, workspace["package"],
            stored(workspace["package"], workspace["base_namespace"]))
        return {"usage": [{"kind": e.kind, "qualname": e.qualname, "module": e.module, "short_name": e.short_name,
                           "doc": e.doc} for e in entries], "workspace": payload()}

    @app.get("/schema/linkml")
    async def schema_linkml(package: str | None = Query(None), edits: bool = Query(True)):
        pkg = package or workspace["package"]
        return await linkml_download(pkg, stored(pkg) if edits else ())

    @app.get("/schema/linkml/report")
    async def schema_linkml_report(package: str | None = Query(None)):
        return await linkml_report(package or workspace["package"])

    return app

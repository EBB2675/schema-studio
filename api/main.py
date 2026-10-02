from typing import List, Optional, Literal

import os, subprocess, tempfile, shutil, ast
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Query, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel, Field

from .light_mode.schema_source import SchemaUnavailable, schema_profile_for_package
from .sources import editing
from .sources.legacy import ExtractionFailed, UnknownRoot
from .sources.legacy import root_namespace as _root_namespace
from .sources.linkml_routes import edit_error, linkml_download, linkml_report

from .routes_git import router as git_router
from .routes_tasks import router as tasks_router
from .settings import SCHEMA_REPO, DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, repo_for_base_namespace
from .mongo import connect_to_mongo, close_mongo
from .auth import (
    authenticate_user,
    create_user,
    create_access_token,
    db_dep,
    get_user_and_workspace,
    update_workspace,
    get_workspace,
    workspace_payload,
    init_db as auth_init,
)
from .graph_runner import branch_source
from .edit_store import (
    add_edits,
    delete_edits,
    init_db as edit_init,
    list_edits,
)

class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


class WorkspaceUpdate(BaseModel):
    branch: str | None = None
    package: str | None = None
    base_namespace: str | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    db = await connect_to_mongo()
    app.state.db = db
    await auth_init(db)
    await edit_init(db)
    yield
    await close_mongo()


app = FastAPI(title="Schema UML API", default_response_class=ORJSONResponse, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(git_router)
app.include_router(tasks_router)


@app.exception_handler(SchemaUnavailable)
async def _schema_unavailable_handler(_request, exc: SchemaUnavailable):
    return ORJSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(UnknownRoot)
async def _unknown_root_handler(_request, exc: UnknownRoot):
    return ORJSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ExtractionFailed)
async def _extraction_failed_handler(_request, exc: ExtractionFailed):
    return ORJSONResponse(status_code=500, content={"detail": str(exc)})


@app.post("/auth/login")
async def login(req: LoginRequest, db=Depends(db_dep)):
    user = await authenticate_user(db, req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user)
    workspace = workspace_payload(await get_workspace(db, user["id"]))
    return {"access_token": token, "token_type": "bearer", "workspace": workspace, "user": {"username": user["username"]}}


@app.post("/auth/register", status_code=201)
async def register(req: RegisterRequest, db=Depends(db_dep)):
    user = await create_user(db, req.username, req.password)
    token = create_access_token(user)
    workspace = workspace_payload(await get_workspace(db, user["id"]))
    return {"access_token": token, "token_type": "bearer", "workspace": workspace, "user": {"username": user["username"]}}


@app.get("/workspace")
async def read_workspace(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"workspace": workspace_payload(workspace)}


@app.put("/workspace")
async def update_workspace_route(req: WorkspaceUpdate, user_ws=Depends(get_user_and_workspace), db=Depends(db_dep)):
    user, workspace = user_ws
    updated = await update_workspace(
        db,
        user["id"],
        branch=req.branch or workspace.get("branch"),
        package=req.package or workspace.get("package"),
        base_namespace=req.base_namespace or workspace.get("base_namespace"),
    )
    return {"workspace": workspace_payload(updated)}


@app.get("/health")
async def health(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"ok": True, "workspace": workspace_payload(workspace)}

@app.get("/")
async def root(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"message": "Schema UML API is running", "workspace": workspace_payload(workspace)}

@app.get("/roots")
async def roots(
    package: str | None = Query(None),
    branch: str | None = Query(None, description="Read the module from this branch's worktree"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """List available section classes for a given package."""
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    try:
        source = await _branch_source(branch, pkg, workspace.get("base_namespace"))
        stored = await _stored_edits(db, user, pkg)
        sections = await run_in_threadpool(lambda: editing.list_sections(pkg, stored, source=source))
        return {"package": pkg, "sections": sorted(sections), "workspace": workspace_payload(workspace)}
    except SchemaUnavailable:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")

@app.get("/schema/linkml")
async def schema_linkml(
    package: str | None = Query(None),
    edits: bool = Query(True, description="Include the module's edits"),
    branch: str | None = Query(None, description="Read the module from this branch's worktree"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """Download the module's schema as LinkML YAML, from the installed environment or a branch."""
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    source = await _branch_source(branch, pkg, workspace.get("base_namespace"))
    return await linkml_download(pkg, await _stored_edits(db, user, pkg) if edits else (), source)


@app.get("/schema/linkml/report")
async def schema_linkml_report(package: str | None = Query(None), user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return await linkml_report(package or workspace.get("package") or DEFAULT_BASE_PACKAGE)


async def _stored_edits(db, user: dict, package: str) -> list[dict]:
    """Every edit of the module's profile: each module's graph replays them all (see `editing`)."""
    profile = schema_profile_for_package(package)
    return await list_edits(db, str(user["id"]), profile.key)


async def _branch_source(branch: str | None, package: str, base_namespace: str | None) -> editing.Source | None:
    """The branch's worktree to read the schema from; None for the installed environment."""
    if not branch:
        return None
    try:
        return await run_in_threadpool(branch_source, branch, package, base_namespace)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read branch {branch!r}: {exc}") from exc


async def _graph_response(
    db, user: dict, workspace: dict, package: str, *, stored: list[dict] | None = None, **flags,
) -> dict:
    """The module's graph from its edited schema (the stored edits, unless given), with the workspace."""
    if stored is None:
        stored = await _stored_edits(db, user, package)
    data = await run_in_threadpool(lambda: editing.build_graph(package, stored, **flags))
    data["workspace"] = workspace_payload(workspace)
    return data


@app.get("/schema")
async def schema(
    package: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False, description="Start only from classes the module's edits added"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    ns = base_namespace or workspace.get("base_namespace")
    if base_namespace is None and package and not empty:
        ns = _root_namespace(pkg)
    if package or base_namespace:
        workspace = await update_workspace(db, user["id"], package=pkg, base_namespace=ns)
    return await _graph_response(
        db, user, workspace, pkg, root=root, include_quantities=include_quantities,
        include_subsections=include_subsections, include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module, base_namespace=ns, empty=empty,
    )


class EditRequest(BaseModel):
    op: str
    target: str = ""
    payload: dict = Field(default_factory=dict)


class EditsRequest(BaseModel):
    package: str | None = None
    edits: list[EditRequest]


class EditIds(BaseModel):
    ids: list[str] = Field(default_factory=list)


@app.get("/schema/edits")
async def list_schema_edits(
    package: str | None = Query(None), user_ws=Depends(get_user_and_workspace), db=Depends(db_dep),
):
    """The module's stored edits, in order, and the edit rules of its profile."""
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    profile = schema_profile_for_package(pkg)
    return {
        "package": pkg,
        "profile": profile.key,
        "edits": await list_edits(db, str(user["id"]), profile.key, pkg),
        "rules": editing.rules_summary(profile),
        "workspace": workspace_payload(workspace),
    }


@app.post("/schema/edits")
async def add_schema_edits(
    req: EditsRequest,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False),
    branch: str | None = Query(None, description="Check the edits against, and draw, this branch's worktree"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """Check and store edits (all or none), then return the module's graph with them."""
    user, workspace = user_ws
    pkg = req.package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    ns = base_namespace or (workspace.get("base_namespace") if workspace.get("package") == pkg else None)
    ns = ns or _root_namespace(pkg)
    workspace = await update_workspace(db, user["id"], package=pkg, base_namespace=ns)
    source = await _branch_source(branch, pkg, ns)
    stored = await _stored_edits(db, user, pkg)
    try:
        prepared = await run_in_threadpool(
            lambda: editing.prepare(pkg, stored, [edit.model_dump() for edit in req.edits], base_namespace=ns, source=source)
        )
        # A root the edits rename follows its class; one they remove leaves the whole module.
        root = await run_in_threadpool(
            lambda: editing.root_after(pkg, stored, prepared, root, base_namespace=ns, source=source)
        )
    except (editing.EditError, editing.EditsUnavailable) as exc:
        raise edit_error(exc)
    # The graph is built before anything is stored, so a failure stores nothing.
    data = await _graph_response(
        db, user, workspace, pkg, stored=[*stored, *prepared], root=root, include_quantities=include_quantities,
        include_subsections=include_subsections, include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module, base_namespace=ns, empty=empty, source=source,
    )
    saved = await add_edits(
        db, str(user["id"]), profile=schema_profile_for_package(pkg, ns).key, branch=branch or workspace.get("branch"),
        package=pkg, edits=prepared,
    )
    if source is not None:
        data["branch"], data["sha"] = branch, source.sha
    return editing.with_stored(data, prepared, saved)


@app.delete("/schema/edits/{edit_id}")
async def delete_schema_edit(edit_id: str, user_ws=Depends(get_user_and_workspace), db=Depends(db_dep)):
    """Delete one stored edit; later edits that depended on it show up as conflicts."""
    user, workspace = user_ws
    deleted = await delete_edits(db, str(user["id"]), ids=[edit_id])
    return {"deleted": deleted, "workspace": workspace_payload(workspace)}


@app.delete("/schema/edits")
async def clear_schema_edits(
    req: EditIds | None = None,
    package: str | None = Query(None, description="Delete the edits stored under this module"),
    all_packages: bool = Query(False, description="Every module of the package's profile"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """Delete the edits listed by id and, if a module is named, the module's edits; in one request."""
    user, workspace = user_ws
    profile = schema_profile_for_package(package or workspace.get("package") or DEFAULT_BASE_PACKAGE)
    deleted = await delete_edits(
        db, str(user["id"]), ids=req.ids if req is not None else [],
        profile=profile.key if (package or all_packages) else None, package=package, all_packages=all_packages,
    )
    return {"deleted": deleted, "workspace": workspace_payload(workspace)}


def _repo_root(base_package: str | None = None) -> Path:
    if base_package:
        repo_src = repo_for_base_namespace(base_package)
    else:
        repo_src = SCHEMA_REPO

    if not repo_src:
        raise RuntimeError(
            "Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / NOMAD_MEASURE_REPO / GIT_REPO_DIR to a local schema clone"
        )

    repo_path = Path(repo_src).expanduser().resolve()
    if not (repo_path / ".git").exists():
        raise RuntimeError(
            "Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / NOMAD_MEASURE_REPO / GIT_REPO_DIR to a local schema clone"
        )
    return repo_path

def _run_git(repo: Path, *args: str) -> str:
    cp = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if cp.returncode != 0:
        raise subprocess.CalledProcessError(cp.returncode, cp.args, cp.stdout, cp.stderr)
    return cp.stdout


def _git_path_exists(repo: Path, branch: str, path: str) -> bool:
    # returns True if path exists at branch (dir tree or file)
    try:
        out = _run_git(repo, "ls-tree", "-d", "--name-only", branch, path).strip()
        if out:
            return True
        # if not a dir, check any file under it
        out2 = _run_git(repo, "ls-tree", "-r", "--name-only", branch, path).strip()
        return bool(out2)
    except subprocess.CalledProcessError:
        return False

def _resolve_base_tree(repo: Path, branch: str, base_path: str) -> str:
    """
    Try to find the tree path that contains the given base package.
    Tries:
      1) base_path
      2) src/base_path
      3) search the tree for */base_path/__init__.py and infer the prefix
    Returns a repository-relative path suitable for `git archive`.
    """
    candidates = [base_path, f"src/{base_path}"]
    for c in candidates:
        if _git_path_exists(repo, branch, c):
            return c

    # Fallback: search entire tree for any file under the base
    try:
        listing = _run_git(repo, "ls-tree", "-r", "--name-only", branch)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=404, detail=f"Branch not found: {branch}") from e

    target_suffix = f"{base_path}/__init__.py"
    prefix = None
    for line in listing.splitlines():
        if line.endswith(target_suffix):
            # line is like "src/nomad_simulations/schema_packages/__init__.py"
            prefix = line[: -len(target_suffix)].rstrip("/")
            break
    if prefix is not None:
        resolved = f"{prefix}/{base_path}" if prefix else base_path
        return resolved

    raise HTTPException(
        status_code=404,
        detail=f"Cannot locate {base_path} at {branch} (tried {base_path}, src/{base_path})"
    )

def _export_subtree(repo: Path, branch: str, rel_path: str, outdir: Path) -> None:
    archive = outdir / "tree.zip"
    subprocess.run(
        ["git", "-C", str(repo), "archive", branch, rel_path, "-o", str(archive)],
        check=True
    )
    shutil.unpack_archive(str(archive), str(outdir))

def _collect_classes_from_file(py_path: Path) -> list[str]:
    try:
        src = py_path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(src)
        return [n.name for n in tree.body if isinstance(n, ast.ClassDef)]
    except Exception:
        return []


def _parse_base_packages(raw: str) -> list[str]:
    """Normalize a comma-separated list of base packages."""

    return [chunk.strip() for chunk in raw.split(",") if chunk.strip()]


class PackageClasses(BaseModel):
    package: str
    classes: list[str]

class OverviewOut(BaseModel):
    branch: str
    base: str
    items: list[PackageClasses]


class OverviewResponse(BaseModel):
    workspace: dict
    branch: str
    base: str
    items: list[PackageClasses]


@app.get("/overview", response_model=OverviewResponse)
async def overview(
    branch: str | None = Query(None),
    base: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """
    Bird's-eye overview: packages under `base` and their top-level classes at `branch`.
    Resolves repo layout prefixes (e.g., src/).
    """
    try:
        user, workspace = user_ws
        branch_to_use = branch or workspace.get("branch") or DEFAULT_BRANCH
        base_to_use = base or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
        if branch or base:
            workspace = await update_workspace(db, user["id"], branch=branch_to_use, base_namespace=base_to_use)

        base_packages = _parse_base_packages(base_to_use)
        if not base_packages:
            raise HTTPException(status_code=400, detail="Provide at least one base package")

        modules: dict[str, set[str]] = {}

        for base_pkg in base_packages:
            repo = _repo_root(base_pkg)
            base_path = base_pkg.replace(".", "/")

            # resolve actual tree path (handles src/ layout)
            resolved_tree = _resolve_base_tree(repo, branch_to_use, base_path)

            with tempfile.TemporaryDirectory() as td_str:
                td = Path(td_str)
                try:
                    _export_subtree(repo, branch_to_use, resolved_tree, td)
                except subprocess.CalledProcessError as e:
                    raise HTTPException(status_code=404, detail=f"Cannot export {resolved_tree} at {branch_to_use}") from e

                # the extracted folder root is td / <resolved_tree>
                extract_root = td / resolved_tree
                if not extract_root.exists():
                    raise HTTPException(status_code=404, detail=f"Extracted path missing: {resolved_tree}")

                for dirpath, dirnames, filenames in os.walk(extract_root):
                    pkg_dir = Path(dirpath)
                    if "__init__.py" not in filenames:
                        continue

                    # rel path from the resolved tree root
                    rel_from_resolved = pkg_dir.relative_to(extract_root)
                    # Build full dotted package name: base + (optional tail)
                    tail = str(rel_from_resolved).replace("/", ".")
                    package_name = base_pkg if tail in ("", ".") else f"{base_pkg}.{tail}"

                    for f in filenames:
                        if not f.endswith(".py"):
                            continue

                        module_name = package_name
                        if f != "__init__.py":
                            module_name = f"{package_name}.{Path(f).stem}"

                        cls_names = _collect_classes_from_file(pkg_dir / f)
                        if not cls_names:
                            continue

                        if module_name not in modules:
                            modules[module_name] = set()
                        modules[module_name].update(cls_names)

        items = [
            PackageClasses(package=module, classes=sorted(classes))
            for module, classes in sorted(modules.items())
        ]

        return OverviewResponse(
            workspace=workspace_payload(workspace),
            branch=branch_to_use,
            base=",".join(base_packages),
            items=items,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")
    

class UsageEntryModel(BaseModel):
    kind: str
    qualname: str
    module: str
    short_name: str
    doc: Optional[str]


class UsageResponse(BaseModel):
    workspace: dict
    usage: List[UsageEntryModel]

@app.get("/usage", response_model=UsageResponse)
async def get_usage(
    section_id: str = Query(..., description="Fully qualified section class name"),
    branch: str | None = Query(None, description="Read the module from this branch's worktree"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """
    Return "under the hood" usage information for a given section class.

    section_id should be the same as the node id for class nodes,
    e.g. "nomad_simulations.schema_packages.model_method.ModelMethod".
    """
    user, workspace = user_ws
    package = workspace.get("package")
    stored = await _stored_edits(db, user, package) if package else []
    source = await _branch_source(branch, package, workspace.get("base_namespace")) if package else None
    entries = await run_in_threadpool(lambda: editing.usage_for_section(section_id, package, stored, source=source))
    usage = [
        UsageEntryModel(
            kind=e.kind,
            qualname=e.qualname,
            module=e.module,
            short_name=e.short_name,
            doc=e.doc,
        )
        for e in entries
    ]
    return {"usage": usage, "workspace": workspace_payload(workspace)}

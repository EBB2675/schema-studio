# api/routes_git.py
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, List
from .settings import DEFAULT_PACKAGE, DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH
from .git_utils import list_branches, materialize_worktree
from .graph_runner import build_graph_in_subprocess
from .diff import diff_graphs
from .auth import get_user_and_workspace, update_workspace, workspace_payload, db_dep
from .repo_utils import (
    bases_by_repo,
    parse_base_packages,
    primary_repo,
    python_root,
    list_modules_under,
)

router = APIRouter()

class GraphRequest(BaseModel):
    branch: Optional[str] = None
    package: Optional[str] = None
    extractor: Optional[str] = None  # "extractor.build:build_graph" by default

class DiffRequest(BaseModel):
    base: str
    head: str
    package: Optional[str] = None
    extractor: Optional[str] = None


@router.get("/git/branches")
async def api_branches(
    base_package: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    try:
        user, workspace = user_ws
        namespace = base_package or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
        if base_package:
            workspace = await update_workspace(db, user["id"], base_namespace=namespace)

        bases = parse_base_packages(namespace)
        repos = bases_by_repo(bases) if bases else bases_by_repo([DEFAULT_BASE_PACKAGE])

        names: set[str] = set()
        errors: list[str] = []

        for repo_src in repos:
            try:
                names.update(list_branches(repo_src))
            except Exception as e:
                errors.append(f"{repo_src}: {e}")

        if not names and errors:
            raise HTTPException(500, "; ".join(errors))

        return {"branches": sorted(names), "errors": errors or None, "workspace": workspace_payload(workspace)}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/git/packages")
async def api_packages(
    branch: str | None = Query(None),
    base_package: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    """
    List Python modules under `base_package` for the given branch.

    Intended use: populate the “Package (module)” dropdown in the UI.
    """
    try:
        user, workspace = user_ws
        branch_to_use = branch or workspace.get("branch") or DEFAULT_BRANCH
        base_to_use = base_package or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
        if branch or base_package:
            workspace = await update_workspace(db, user["id"], branch=branch_to_use, base_namespace=base_to_use)

        # materialize_worktree returns (worktree_path, sha)
        base_packages = parse_base_packages(base_to_use)
        if not base_packages:
            raise HTTPException(400, "Provide at least one base package")

        packages: set[str] = set()
        repo_shas: list[dict] = []
        errors: list[str] = []

        for repo_src, bases in bases_by_repo(base_packages).items():
            try:
                wt, sha = materialize_worktree(branch_to_use, repo_src)
            except Exception as e:
                errors.append(f"{repo_src}: {e}")
                continue

            repo_shas.append({"source": repo_src, "sha": sha})

            root = python_root(wt)
            for base in bases:
                packages.update(list_modules_under(root, base))

        if not packages and errors:
            raise HTTPException(500, "; ".join(errors))

        return {
            "branch": branch_to_use,
            "sha": repo_shas[0]["sha"] if repo_shas else None,
            "repositories": repo_shas,
            "base_package": base_to_use,
            "base_packages": base_packages,
            "packages": sorted(packages),
            "errors": errors or None,
            "workspace": workspace_payload(workspace),
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/graph")
async def api_graph(
    req: GraphRequest,
    base_namespace: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    empty: bool = Query(False, description="Return an empty graph shell instead of extracting schema"),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    user, workspace = user_ws
    pkg = req.package or workspace.get("package") or DEFAULT_PACKAGE
    namespace = base_namespace or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
    branch = req.branch or workspace.get("branch") or DEFAULT_BRANCH
    workspace = await update_workspace(db, user["id"], branch=branch, package=pkg, base_namespace=namespace)
    try:
        repo_src = primary_repo(pkg, namespace)
        wt, sha = materialize_worktree(branch, repo_src)
        if empty:
            graph = {"package": pkg, "root": root, "nodes": [], "edges": []}
        else:
            graph = build_graph_in_subprocess(
                wt,
                pkg,
                req.extractor,
                base_namespace=namespace,
                root=root,
                include_quantities=include_quantities,
                include_subsections=include_subsections,
                include_inheritance=include_inheritance,
                allow_cross_module=allow_cross_module,
            )
        return {"branch": branch, "sha": sha, "graph": graph, "workspace": workspace_payload(workspace)}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/graph/diff")
async def api_diff(
    req: DiffRequest,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    user, workspace = user_ws
    pkg = req.package or workspace.get("package") or DEFAULT_PACKAGE
    namespace = base_namespace or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
    workspace = await update_workspace(db, user["id"], branch=req.head, package=pkg, base_namespace=namespace)
    try:
        repo_src = primary_repo(pkg, namespace)
        wtb, shab = materialize_worktree(req.base, repo_src)
        wth, shah = materialize_worktree(req.head, repo_src)

        opts = {
            "root": root,
            "include_quantities": include_quantities,
            "include_subsections": include_subsections,
            "include_inheritance": include_inheritance,
            "allow_cross_module": allow_cross_module,
            "base_namespace": namespace,
        }

        gA = build_graph_in_subprocess(wtb, pkg, req.extractor, **opts)
        gB = build_graph_in_subprocess(wth, pkg, req.extractor, **opts)
        diff = diff_graphs(gA, gB)
        return {
            "base": {"branch": req.base, "sha": shab, "graph": gA},
            "head": {"branch": req.head, "sha": shah, "graph": gB},
            "diff": diff,
            "workspace": workspace_payload(workspace),
        }
    except Exception as e:
        raise HTTPException(500, str(e))

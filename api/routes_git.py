# api/routes_git.py
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, List
from .settings import DEFAULT_PACKAGE, DEFAULT_BASE_PACKAGE
from .git_utils import list_branches, materialize_worktree
from .graph_runner import build_graph_in_subprocess
from .diff import diff_graphs

router = APIRouter()

class GraphRequest(BaseModel):
    branch: str
    package: Optional[str] = None
    extractor: Optional[str] = None  # "extractor.build:build_graph" by default

class DiffRequest(BaseModel):
    base: str
    head: str
    package: Optional[str] = None
    extractor: Optional[str] = None



def _python_root(wt: Path) -> Path:
    """
    Return the directory under which Python packages live in the worktree.

    In many NOMAD schemas this is typically <worktree>/src.
    If that does not exist, fall back to the worktree root.
    """
    src = wt / "src"
    return src if src.exists() else wt


def _list_modules_under(root: Path, base_package: str) -> List[str]:
    """
    List all importable Python modules under the given base package.

    Example:
        root         = /.../worktrees/develop/src
        base_package = "nomad_simulations.schema_packages"
        → finds modules like:
          "nomad_simulations.schema_packages.model_method",
          "nomad_simulations.schema_packages.workflow.general", ...
    """
    parts = base_package.split(".")
    pkg_dir = root.joinpath(*parts)
    if not pkg_dir.exists():
        return []

    modules: set[str] = set()

    for path in pkg_dir.rglob("*.py"):
        # Compute module name relative to python root (src or repo root)
        rel = path.relative_to(root)

        # Strip .py suffix and convert path to dotted module path
        rel_no_ext = rel.with_suffix("")
        mod_name = ".".join(rel_no_ext.parts)

        modules.add(mod_name)

    return sorted(modules)


@router.get("/git/branches")
def api_branches():
    try:
        return {"branches": list_branches()}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/git/packages")
def api_packages(
    branch: str = Query("develop"),
    base_package: str = Query(DEFAULT_BASE_PACKAGE),
):
    """
    List Python modules under `base_package` for the given branch.

    Intended use: populate the “Package (module)” dropdown in the UI.
    """
    try:
        # materialize_worktree returns (worktree_path, sha)
        wt, sha = materialize_worktree(branch)

        # Work out where Python packages live (usually <worktree>/src)
        root = _python_root(wt)

        # Use the helper to list all modules under the base package
        packages = _list_modules_under(root, base_package)

        return {
            "branch": branch,
            "sha": sha,
            "base_package": base_package,
            "packages": packages,
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/graph")
def api_graph(req: GraphRequest):
    pkg = req.package or DEFAULT_PACKAGE
    try:
        wt, sha = materialize_worktree(req.branch)
        graph = build_graph_in_subprocess(wt, pkg, req.extractor)
        return {"branch": req.branch, "sha": sha, "graph": graph}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/graph/diff")
def api_diff(
    req: DiffRequest,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None)
):
    pkg = req.package or DEFAULT_PACKAGE
    try:
        wtb, shab = materialize_worktree(req.base)
        wth, shah = materialize_worktree(req.head)

        opts = {
            "root": root,
            "include_quantities": include_quantities,
            "include_subsections": include_subsections,
            "allow_cross_module": allow_cross_module,
            "base_namespace": base_namespace,
        }

        gA = build_graph_in_subprocess(wtb, pkg, req.extractor, **opts)
        gB = build_graph_in_subprocess(wth, pkg, req.extractor, **opts)
        diff = diff_graphs(gA, gB)
        return {
            "base": {"branch": req.base, "sha": shab, "graph": gA},
            "head": {"branch": req.head, "sha": shah, "graph": gB},
            "diff": diff
        }
    except Exception as e:
        raise HTTPException(500, str(e))


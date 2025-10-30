# api/routes_git.py
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from .settings import DEFAULT_PACKAGE
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

@router.get("/git/branches")
def api_branches():
    try:
        return {"branches": list_branches()}
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


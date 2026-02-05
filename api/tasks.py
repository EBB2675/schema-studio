from __future__ import annotations

from typing import Any, Dict

from .celery_app import celery_app
from .diff import diff_graphs
from .git_utils import materialize_worktree
from .graph_runner import build_graph_in_subprocess
from .repo_utils import primary_repo
from .settings import DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, DEFAULT_PACKAGE


def _coerce_owner(owner: Any) -> str | None:
    try:
        return str(owner) if owner is not None else None
    except Exception:
        return None


@celery_app.task(bind=True, name="schema_uml.build_graph")
def build_graph_task(
    self,
    *,
    branch: str | None = None,
    package: str | None = None,
    base_namespace: str | None = None,
    extractor: str | None = None,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    owner_id: str | None = None,
) -> Dict[str, Any]:
    """
    Build a graph for a branch/package. Runs in a subprocess to keep importer state isolated.
    """
    owner_str = _coerce_owner(owner_id)
    self.update_state(state="STARTED", meta={"owner_id": owner_str, "step": "materialize"})

    pkg = package or DEFAULT_PACKAGE
    namespace = base_namespace or DEFAULT_BASE_PACKAGE
    br = branch or DEFAULT_BRANCH

    repo_src = primary_repo(pkg, namespace)
    wt, sha = materialize_worktree(br, repo_src)

    self.update_state(
        state="STARTED",
        meta={"owner_id": owner_str, "step": "extract", "branch": br, "sha": sha},
    )

    graph = build_graph_in_subprocess(
        wt,
        pkg,
        extractor,
        base_namespace=namespace,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module,
    )
    return {"branch": br, "sha": sha, "graph": graph, "owner_id": owner_str}


@celery_app.task(bind=True, name="schema_uml.diff_graphs")
def diff_graph_task(
    self,
    *,
    base: str,
    head: str,
    package: str | None = None,
    base_namespace: str | None = None,
    extractor: str | None = None,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    owner_id: str | None = None,
) -> Dict[str, Any]:
    owner_str = _coerce_owner(owner_id)
    self.update_state(state="STARTED", meta={"owner_id": owner_str, "step": "materialize"})

    pkg = package or DEFAULT_PACKAGE
    namespace = base_namespace or DEFAULT_BASE_PACKAGE
    repo_src = primary_repo(pkg, namespace)

    wtb, shab = materialize_worktree(base or DEFAULT_BRANCH, repo_src)
    wth, shah = materialize_worktree(head or DEFAULT_BRANCH, repo_src)

    self.update_state(
        state="STARTED",
        meta={"owner_id": owner_str, "step": "extract", "base": shab, "head": shah},
    )

    opts = dict(
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module,
        base_namespace=namespace,
    )
    gA = build_graph_in_subprocess(wtb, pkg, extractor, **opts)
    gB = build_graph_in_subprocess(wth, pkg, extractor, **opts)
    diff = diff_graphs(gA, gB)
    return {
        "base": {"branch": base, "sha": shab, "graph": gA},
        "head": {"branch": head, "sha": shah, "graph": gB},
        "diff": diff,
        "owner_id": owner_str,
    }


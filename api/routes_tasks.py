from __future__ import annotations

from typing import Any, Dict, Optional

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from .auth import db_dep, get_user_and_workspace, update_workspace, workspace_payload
from .celery_app import celery_app
from .routes_git import DiffRequest, GraphRequest
from .tasks import build_graph_task, diff_graph_task

router = APIRouter(prefix="/tasks", tags=["tasks"])


class TaskStatus(BaseModel):
    task_id: str
    status: str
    ready: bool
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    workspace: Optional[Dict[str, Any]] = None


def _assert_task_owner(res: AsyncResult, user_id: str) -> None:
    """
    Prevent leakage across users by ensuring the owner_id (if present) matches.
    Missing owner metadata is treated as public.
    """
    owner = None
    meta = res.info if isinstance(res.info, dict) else {}
    if isinstance(meta, dict):
        owner = meta.get("owner_id")
    if res.successful() and isinstance(res.result, dict):
        owner = res.result.get("owner_id", owner)

    if owner and str(owner) != str(user_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Task does not belong to the current user")


def _serialize_failure(res: AsyncResult) -> str:
    if isinstance(res.result, Exception):
        return f"{type(res.result).__name__}: {res.result}"
    return str(res.result)


def _require_result_backend() -> None:
    backend = getattr(celery_app, "backend", None)
    if backend is None or getattr(backend, "is_disabled", False):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Celery result backend is not configured. Set CELERY_RESULT_BACKEND (e.g. redis://...) and restart.",
        )


@router.post("/graph", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_graph_task(
    req: GraphRequest,
    base_namespace: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    user_ws=Depends(get_user_and_workspace),
    db=Depends(db_dep),
):
    user, workspace = user_ws
    pkg = req.package or workspace.get("package")
    namespace = base_namespace or workspace.get("base_namespace")
    branch = req.branch or workspace.get("branch")
    workspace = await update_workspace(db, user["id"], branch=branch, package=pkg, base_namespace=namespace)

    task = build_graph_task.delay(
        branch=branch,
        package=pkg,
        base_namespace=namespace,
        extractor=req.extractor,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module,
        owner_id=user["id"],
    )
    return {"task_id": task.id, "status": task.status, "workspace": workspace_payload(workspace)}


@router.post("/graph/diff", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_diff_task(
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
    pkg = req.package or workspace.get("package")
    namespace = base_namespace or workspace.get("base_namespace")
    workspace = await update_workspace(db, user["id"], branch=req.head, package=pkg, base_namespace=namespace)

    task = diff_graph_task.delay(
        base=req.base,
        head=req.head,
        package=pkg,
        base_namespace=namespace,
        extractor=req.extractor,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        include_inheritance=include_inheritance,
        allow_cross_module=allow_cross_module,
        owner_id=user["id"],
    )
    return {"task_id": task.id, "status": task.status, "workspace": workspace_payload(workspace)}


@router.get("/{task_id}", response_model=TaskStatus)
async def task_status(task_id: str, user_ws=Depends(get_user_and_workspace)):
    user, workspace = user_ws
    _require_result_backend()
    res = AsyncResult(task_id, app=celery_app)
    _assert_task_owner(res, user["id"])

    payload: Dict[str, Any] = {
        "task_id": task_id,
        "status": res.status,
        "ready": res.ready(),
        "workspace": workspace_payload(workspace),
    }

    if res.successful():
        result = res.result
        if isinstance(result, dict):
            result.pop("owner_id", None)
        payload["result"] = result
        return payload

    if res.failed():
        payload["error"] = _serialize_failure(res)
        return payload

    meta = res.info if isinstance(res.info, dict) else None
    if meta:
        payload["result"] = meta
    return payload

import os
from typing import Any, Dict, Optional

import pymongo
import pytest

from api import auth
from api import routes_tasks


class StubAsyncResult:
    def __init__(self, task_id: str, status: str = "PENDING", result: Optional[Dict[str, Any]] = None, info=None):
        self.id = task_id
        self.status = status
        self.result = result
        self.info = info

    def ready(self) -> bool:
        return self.status in {"SUCCESS", "FAILURE"}

    def successful(self) -> bool:
        return self.status == "SUCCESS"

    def failed(self) -> bool:
        return self.status == "FAILURE"


def _admin_id() -> str:
    client = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))
    db = client[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]
    doc = db[auth.USERS_COLLECTION].find_one({"username": "admin"})
    client.close()
    assert doc is not None, "default admin user missing"
    return str(doc["_id"])


@pytest.fixture()
def task_results(monkeypatch):
    """
    Provides a mutable mapping of task_id -> StubAsyncResult and wires routes_tasks.AsyncResult to read from it.
    """
    results: Dict[str, StubAsyncResult] = {}

    def fake_async_result(task_id: str, app=None):
        return results.get(task_id, StubAsyncResult(task_id))

    monkeypatch.setattr(routes_tasks, "AsyncResult", fake_async_result)
    return results


def test_enqueue_graph_task_returns_task_id_and_updates_workspace(client, monkeypatch, task_results):
    admin_id = _admin_id()

    def fake_delay(**kwargs):
        res = StubAsyncResult(
            "task-graph",
            status="PENDING",
            result={"owner_id": kwargs.get("owner_id"), "graph": {"nodes": [], "edges": []}},
            info={"owner_id": kwargs.get("owner_id")},
        )
        task_results[res.id] = res
        return res

    monkeypatch.setattr(routes_tasks.build_graph_task, "delay", fake_delay)

    resp = client.post("/tasks/graph", json={"branch": "feature-x"})
    assert resp.status_code == 202
    body = resp.json()
    assert body["task_id"] == "task-graph"
    assert body["status"] == "PENDING"
    assert body["workspace"]["branch"] == "feature-x"

    # Ensure owner metadata captured in the stored result
    assert task_results["task-graph"].result["owner_id"] == admin_id


def test_task_status_success_strips_owner_and_returns_result(client, task_results):
    admin_id = _admin_id()
    task_results["t-success"] = StubAsyncResult(
        "t-success", status="SUCCESS", result={"owner_id": admin_id, "ok": True}, info={"owner_id": admin_id}
    )

    resp = client.get("/tasks/t-success")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "SUCCESS"
    assert body["ready"] is True
    assert body["result"] == {"ok": True}


def test_task_status_missing_owner_returns_404(client, task_results):
    task_results["t-missing-owner"] = StubAsyncResult("t-missing-owner", status="SUCCESS", result={"ok": True})

    resp = client.get("/tasks/t-missing-owner")
    assert resp.status_code == 404


def test_task_status_owner_mismatch_returns_403(client, task_results):
    task_results["t-foreign"] = StubAsyncResult(
        "t-foreign", status="SUCCESS", result={"owner_id": "someone-else", "ok": True}
    )

    resp = client.get("/tasks/t-foreign")
    assert resp.status_code == 403


def test_task_status_failure_returns_error_message(client, task_results):
    err = ValueError("boom")
    task_results["t-fail"] = StubAsyncResult(
        "t-fail", status="FAILURE", result=err, info={"owner_id": _admin_id()}
    )

    resp = client.get("/tasks/t-fail")
    assert resp.status_code == 200
    assert resp.json()["error"].startswith("ValueError: boom")


def test_task_status_503_when_backend_disabled_and_not_eager(client, monkeypatch):
    # Force non-eager mode with no backend to exercise the guard.
    stub_app = type(
        "StubCelery",
        (),
        {"conf": type("StubConf", (), {"task_always_eager": False})(), "backend": None},
    )()
    monkeypatch.setattr(routes_tasks, "celery_app", stub_app)

    resp = client.get("/tasks/any")
    assert resp.status_code == 503

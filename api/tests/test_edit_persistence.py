import sys
from pathlib import Path
from uuid import uuid4

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import os
import pymongo

from api import edit_store, main
from api.settings import DEFAULT_BRANCH


def _create_dummy_package(tmp_path: Path) -> str:
    pkg_name = f"persist_pkg_{uuid4().hex}"
    pkg_dir = tmp_path / pkg_name
    pkg_dir.mkdir()

    pkg_code = '''
class DummyQuantity:
    def __init__(self, name: str, dtype: str, description: str | None = None):
        self.name = name
        self.dtype = dtype
        self.description = description


class TargetSection:
    """A sample section for testing persistence."""
    quantities = {
        "existing": DummyQuantity("existing", "float", "Existing quantity"),
    }
'''
    (pkg_dir / "__init__.py").write_text(pkg_code)
    return pkg_name


_MONGO_CLIENT = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))


@pytest.fixture(scope="session", autouse=True)
def _mongo_client_session():
    """Ensure module-level Mongo client is closed after the test session."""
    try:
        yield _MONGO_CLIENT
    finally:
        _MONGO_CLIENT.close()


def _db():
    return _MONGO_CLIENT[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]


def _admin_user_id():
    doc = _db()["users"].find_one({"username": "admin"})
    if not doc:
        pytest.skip("Admin user not found; test setup failed.")
    return str(doc["_id"])


def test_persisted_edits_are_replayed(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    create_resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "float",
            "docstring": "Persist me",
        },
    )
    assert create_resp.status_code == 200
    create_payload = create_resp.json()
    assert create_payload["persisted_edit"]["quantity_name"] == "user_defined"
    admin_id = _admin_user_id()

    db = _db()
    stored = list(db[edit_store.CUSTOM_EDITS_COLLECTION].find({"user_id": admin_id, "branch": DEFAULT_BRANCH, "package": pkg_name}))
    assert stored

    # Subsequent schema fetch should replay the persisted edit onto the graph
    schema_resp = client.get("/schema", params={"package": pkg_name})
    assert schema_resp.status_code == 200
    data = schema_resp.json()
    assert any(
        n
        for n in data["nodes"]
        if n.get("kind") == "quantity" and n.get("label") == "user_defined"
    )


def test_branch_conflict_marks_edits_and_blocks_overwrite(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    # Simulate initial persistence on an older branch head
    monkeypatch.setattr(main, "_current_branch_head", lambda branch, base: "old-sha")
    resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "float",
            "docstring": "Persist me",
        },
    )
    assert resp.status_code == 200

    # New branch head should mark the persisted edit as stale
    monkeypatch.setattr(main, "_current_branch_head", lambda branch, base: "new-sha")
    stale_resp = client.get("/schema", params={"package": pkg_name})
    assert stale_resp.status_code == 200
    stale_payload = stale_resp.json()
    assert stale_payload.get("edit_conflicts")
    assert stale_payload["edit_conflicts"][0]["reason"] == "stale_branch_head"

    # Attempting to overwrite with a different payload should raise a conflict
    conflicting = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "int",
            "docstring": "Changed",
            "parent_name": "TargetSection",
        },
    )
    assert conflicting.status_code == 409
    detail = conflicting.json()["detail"]
    assert detail["stored_base_sha"] == "old-sha"
    assert detail["current_base_sha"] == "new-sha"


def test_schema_includes_applied_edits_when_present(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """
    GET /schema should expose applied_edits when persisted custom edits exist so the
    frontend can surface them in the audit trail.
    """
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    # Persist a custom quantity (stores edit and replays it)
    create_resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "float",
            "docstring": "Persist me",
        },
    )
    assert create_resp.status_code == 200

    # Subsequent schema call should include applied_edits
    schema_resp = client.get("/schema", params={"package": pkg_name})
    assert schema_resp.status_code == 200
    payload = schema_resp.json()
    applied = payload.get("applied_edits")
    assert isinstance(applied, list)
    assert any(
        e.get("edit_type") == "quantity"
        and e.get("quantity_name") == "user_defined"
        and e.get("class_name") == "TargetSection"
        for e in applied
    )


def test_schema_omits_applied_edits_when_none_exist(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """
    When no persisted edits exist, applied_edits should be absent or empty.
    """
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    schema_resp = client.get("/schema", params={"package": pkg_name})
    assert schema_resp.status_code == 200
    payload = schema_resp.json()
    applied = payload.get("applied_edits")
    assert applied in (None, [])


def test_applied_edits_excluded_when_edit_is_stale(client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """
    Persisted edits based on a stale branch head should show in edit_conflicts,
    not in applied_edits.
    """
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    # Persist with old branch head
    monkeypatch.setattr(main, "_current_branch_head", lambda branch, base: "old-sha")
    create_resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "float",
            "docstring": "Persist me",
        },
    )
    assert create_resp.status_code == 200

    # Now branch head changes; the persisted edit should be reported as conflict, not applied.
    monkeypatch.setattr(main, "_current_branch_head", lambda branch, base: "new-sha")
    schema_resp = client.get("/schema", params={"package": pkg_name})
    assert schema_resp.status_code == 200
    payload = schema_resp.json()
    assert payload.get("edit_conflicts")
    assert payload["edit_conflicts"][0]["reason"] == "stale_branch_head"
    applied = payload.get("applied_edits")
    assert applied in (None, [])  # explicitly ensure not applied

import sys
from pathlib import Path
from uuid import uuid4

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

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
    stored = edit_store.list_edits(user_id=1, branch=DEFAULT_BRANCH, package=pkg_name)
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

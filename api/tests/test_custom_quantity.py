import sys
from uuid import uuid4
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pytest
from fastapi.testclient import TestClient

from api.main import app


@pytest.fixture()
def client():
    base_client = TestClient(app)
    resp = base_client.post("/auth/login", json={"username": "admin", "password": "admin"})
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    original_request = base_client.request

    def _authed_request(method: str, url: str, **kwargs):
        headers = kwargs.pop("headers", {}) or {}
        headers = {**headers, "Authorization": f"Bearer {token}"}
        return original_request(method, url, headers=headers, **kwargs)

    base_client.request = _authed_request  # type: ignore[assignment]
    health = base_client.get("/health")
    assert health.status_code == 200
    return base_client


def _create_dummy_package(tmp_path: Path) -> str:
    pkg_name = f"custom_pkg_{uuid4().hex}"
    pkg_dir = tmp_path / pkg_name
    pkg_dir.mkdir()

    pkg_code = '''
class DummyQuantity:
    def __init__(self, name: str, dtype: str, description: str | None = None):
        self.name = name
        self.dtype = dtype
        self.description = description


class TargetSection:
    """A sample section for testing."""
    quantities = {
        "existing": DummyQuantity("existing", "float", "Existing quantity"),
    }


class OtherSection:
    quantities = {}
    """Another section that should not match by name."""
'''
    (pkg_dir / "__init__.py").write_text(pkg_code)
    return pkg_name


def test_adds_custom_quantity_and_edge(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "float",
            "docstring": "A runtime-added quantity",
        },
    )
    assert resp.status_code == 200

    payload = resp.json()
    section_id = f"{pkg_name}.TargetSection"
    quantity_id = f"{section_id}.user_defined"

    assert any(n for n in payload["nodes"] if n["id"] == quantity_id and n["doc"] == "A runtime-added quantity")
    assert any(e for e in payload["edges"] if e["source"] == section_id and e["target"] == quantity_id and e["type"] == "hasQuantity")


def test_duplicate_quantity_rejected(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "existing",
            "dtype": "float",
            "docstring": "Already there",
        },
    )
    assert resp.status_code == 400
    assert "already exists" in resp.json()["detail"]


def test_unknown_section_returns_not_found(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "MissingSection",
            "quantity_name": "new_value",
            "dtype": "float",
            "docstring": "", 
        },
    )
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"]


def test_unsupported_dtype_returns_error(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg_name = _create_dummy_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))

    resp = client.post(
        "/schema/custom-quantity",
        json={
            "package": pkg_name,
            "class_name": "TargetSection",
            "quantity_name": "user_defined",
            "dtype": "complex128",
            "docstring": "", 
        },
    )
    assert resp.status_code == 400
    assert "Unsupported dtype" in resp.json()["detail"]

import os
import shutil
from pathlib import Path
import sys

# Ensure all tests share an isolated data directory so SQLite state does not leak.
DATA_DIR = Path(__file__).resolve().parent / "_tmp_data"
if DATA_DIR.exists():
    shutil.rmtree(DATA_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("SCHEMA_UML_DATA_DIR", str(DATA_DIR))

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import api.auth as auth  # noqa: E402
import api.edit_store as edit_store  # noqa: E402
from api.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _reset_dbs():
    if auth.DB_PATH.exists():
        auth.DB_PATH.unlink()
    if edit_store.DB_PATH.exists():
        edit_store.DB_PATH.unlink()
    auth.init_db()
    edit_store.init_db()


# Reset DBs before each test to avoid cross-test contamination.
# Using session-level import avoids reloading the FastAPI app repeatedly.
import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def clean_state():
    _reset_dbs()
    yield
    _reset_dbs()


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

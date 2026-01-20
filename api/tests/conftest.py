import os
import shutil
from pathlib import Path
import sys

# Ensure all tests share isolated resources (data dir + Mongo db).
DATA_DIR = Path(__file__).resolve().parent / "_tmp_data"
if DATA_DIR.exists():
    shutil.rmtree(DATA_DIR)
DATA_DIR.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("SCHEMA_UML_DATA_DIR", str(DATA_DIR))
os.environ.setdefault("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017")
os.environ.setdefault("SCHEMA_UML_MONGO_DB", "schema_uml_test")
os.environ.setdefault("SCHEMA_UML_ALLOW_INSECURE_DEFAULTS", "true")
os.environ.setdefault("SCHEMA_UML_ENABLE_DEFAULT_ADMIN", "true")
os.environ.setdefault("SCHEMA_UML_SECRET", "test-secret")
os.environ.setdefault("SCHEMA_UML_PW_SALT", "test-salt")

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pymongo

import api.auth as auth  # noqa: E402
import api.edit_store as edit_store  # noqa: E402
from api.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Reset DBs before each test to avoid cross-test contamination.
# Using session-level import avoids reloading the FastAPI app repeatedly.
import pytest  # noqa: E402


def _reset_dbs_sync():
    client = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))
    db = client[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]
    db.drop_collection(auth.USERS_COLLECTION)
    db.drop_collection(auth.WORKSPACES_COLLECTION)
    db.drop_collection(edit_store.CUSTOM_EDITS_COLLECTION)
    client.close()


@pytest.fixture(autouse=True)
def clean_state():
    _reset_dbs_sync()
    yield
    _reset_dbs_sync()


@pytest.fixture()
def client():
    with TestClient(app) as base_client:
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
        yield base_client

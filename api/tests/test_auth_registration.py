import os

import pymongo
import pytest
from fastapi.testclient import TestClient

from api.auth import _hash_password
from api.main import app

_MONGO_CLIENT = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))


@pytest.fixture(scope="session", autouse=True)
def _close_client():
    try:
        yield
    finally:
        _MONGO_CLIENT.close()


def _db():
    return _MONGO_CLIENT[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]


def test_register_creates_user_and_workspace():
    username = "new_user"
    with TestClient(app) as anon:
        resp = anon.post("/auth/register", json={"username": username, "password": "secret"})
        assert resp.status_code == 201
        payload = resp.json()
        token = payload["access_token"]
        assert payload["user"]["username"] == username
        assert payload["workspace"]["branch"]

        health = anon.get("/health", headers={"Authorization": f"Bearer {token}"})
        assert health.status_code == 200

    doc = _db()["users"].find_one({"username": username})
    assert doc
    assert doc["password_hash"] == _hash_password("secret")
    assert doc["password_hash"] != "secret"
    ws_doc = _db()["workspaces"].find_one({"user_id": doc["_id"]})
    assert ws_doc is not None


def test_duplicate_username_rejected():
    username = "dupe_user"
    with TestClient(app) as anon:
        first = anon.post("/auth/register", json={"username": username, "password": "pw1"})
        assert first.status_code == 201

        second = anon.post("/auth/register", json={"username": username, "password": "pw2"})
        assert second.status_code == 409

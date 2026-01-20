import os
from uuid import uuid4

import pymongo

from api import edit_store


def _pkg_name(prefix: str = "empty_pkg") -> str:
    return f"{prefix}_{uuid4().hex}"


def _admin_user_id():
    client = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))
    db = client[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]
    doc = db["users"].find_one({"username": "admin"})
    client.close()
    return str(doc["_id"]) if doc else None


def test_empty_schema_returns_blank_graph(client):
    pkg = _pkg_name()
    resp = client.get("/schema", params={"package": pkg, "empty": True})
    assert resp.status_code == 200
    data = resp.json()
    assert data["package"] == pkg
    assert data.get("nodes") == []
    assert data.get("edges") == []


def test_empty_canvas_persists_and_replays_edits(client):
    pkg = _pkg_name("blank_pkg")

    class_resp = client.post(
        "/schema/custom-class",
        params={"empty": True},
        json={"package": pkg, "name": "Alpha", "docstring": "first"},
    )
    assert class_resp.status_code == 200
    payload = class_resp.json()
    assert payload["persisted_edit"]["class_name"] == "Alpha"

    qty_resp = client.post(
        "/schema/custom-quantity",
        params={"empty": True},
        json={
            "package": pkg,
            "class_name": "Alpha",
            "quantity_name": "beta",
            "dtype": "int",
            "docstring": "custom",
        },
    )
    assert qty_resp.status_code == 200

    replay = client.get("/schema", params={"package": pkg, "empty": True})
    assert replay.status_code == 200
    data = replay.json()
    assert any(n for n in data["nodes"] if n.get("kind") == "section" and n.get("label") == "Alpha")
    assert any(n for n in data["nodes"] if n.get("kind") == "quantity" and n.get("label") == "beta")


def test_clearing_edits_removes_persisted_entries(client):
    pkg = _pkg_name("clear_pkg")

    client.post(
        "/schema/custom-class",
        params={"empty": True},
        json={"package": pkg, "name": "Transient"},
    )
    admin_id = _admin_user_id()
    mongo = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))
    db = mongo[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]
    stored = list(db[edit_store.CUSTOM_EDITS_COLLECTION].find({"user_id": admin_id, "branch": "develop", "package": pkg}))
    mongo.close()
    assert stored

    resp = client.delete("/schema/custom-edits", params={"package": pkg, "branch": "develop"})
    assert resp.status_code == 200
    assert resp.json()["deleted"] >= 1

    mongo = pymongo.MongoClient(os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017"))
    db = mongo[os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml_test")]
    remaining = list(db[edit_store.CUSTOM_EDITS_COLLECTION].find({"user_id": admin_id, "branch": "develop", "package": pkg}))
    mongo.close()
    assert remaining == []

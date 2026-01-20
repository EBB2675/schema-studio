"""
One-off helper to copy existing SQLite auth/edit data into MongoDB.

Usage:
    SCHEMA_UML_MONGO_URI=mongodb://localhost:27017 \
    SCHEMA_UML_MONGO_DB=schema_uml \
    python -m api.migrate_sqlite_to_mongo
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from pymongo import MongoClient, ReturnDocument, UpdateOne

from .mongo import MONGO_DB, MONGO_URI
from .settings import DATA_DIR


AUTH_DB = Path(DATA_DIR) / "auth.sqlite3"
EDIT_DB = Path(DATA_DIR) / "edit_store.sqlite3"


def migrate_auth(db):
    if not AUTH_DB.exists():
        print("auth.sqlite3 not found; skipping auth migration")
        return {}

    conn = sqlite3.connect(AUTH_DB)
    conn.row_factory = sqlite3.Row
    users = conn.execute("SELECT id, username, password_hash FROM users").fetchall()
    workspaces = conn.execute(
        "SELECT user_id, branch, package, base_namespace FROM workspaces"
    ).fetchall()

    # Upsert users individually so we can collect the Mongo _id for mapping.
    user_id_map = {}
    for row in users:
        doc = db["users"].find_one_and_update(
            {"username": row["username"]},
            {"$setOnInsert": {"password_hash": row["password_hash"]}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        if doc:
            user_id_map[str(row["id"])] = doc["_id"]
    if user_id_map:
        print(f"Migrated {len(user_id_map)} users")

    ws_ops = []
    for row in workspaces:
        mongo_user_id = user_id_map.get(str(row["user_id"]))
        if mongo_user_id is None:
            print(f"Skipping workspace for missing user_id={row['user_id']}")
            continue
        ws_ops.append(
            UpdateOne(
                {"user_id": mongo_user_id},
                {
                    "$setOnInsert": {
                        "branch": row["branch"],
                        "package": row["package"],
                        "base_namespace": row["base_namespace"],
                    }
                },
                upsert=True,
            )
        )
    if ws_ops:
        db["workspaces"].bulk_write(ws_ops, ordered=False)
        print(f"Migrated {len(ws_ops)} workspaces")
    return user_id_map


def migrate_edits(db, user_id_map: dict[str, object]):
    if not EDIT_DB.exists():
        print("edit_store.sqlite3 not found; skipping edit migration")
        return

    conn = sqlite3.connect(EDIT_DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM custom_edits").fetchall()

    if not rows:
        print("No edits to migrate")
        return

    ops = []
    for row in rows:
        mongo_user_id = user_id_map.get(str(row["user_id"]))
        if mongo_user_id is None:
            print(f"Skipping edit for missing user_id={row['user_id']}")
            continue
        ops.append(
            UpdateOne(
                {
                    "user_id": mongo_user_id,
                    "branch": row["branch"],
                    "package": row["package"],
                    "class_name": row["class_name"],
                    "quantity_name": row["quantity_name"] or "",
                },
                {
                    "$set": {
                        "dtype": row["dtype"],
                        "docstring": row["docstring"],
                        "parent_name": row["parent_name"],
                        "parent_relation": row["parent_relation"],
                        "edit_type": row["edit_type"],
                        "base_sha": row["base_sha"],
                        "created_at": row["created_at"],
                        "updated_at": row["updated_at"],
                    }
                },
                upsert=True,
            )
        )

    db["custom_edits"].bulk_write(ops, ordered=False)
    print(f"Migrated {len(ops)} edits")


def main():
    client = MongoClient(MONGO_URI, uuidRepresentation="standard")
    try:
        db = client[MONGO_DB]
        user_id_map = migrate_auth(db)
        migrate_edits(db, user_id_map)
    finally:
        client.close()
    print("Migration complete")


if __name__ == "__main__":
    main()

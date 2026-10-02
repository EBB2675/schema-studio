"""Persistence of schema edits for Dev Mode (Mongo + Motor, async).

An edit is stored as the plain dict of `api/sources/edits.py` (operation,
target, payload, profile and the schema commit it was made on) and replayed
from there; nothing here knows how edits apply. Edits of the older format
(collection `custom_edits`) are dropped, not migrated.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Iterable, List, Optional

from bson import ObjectId, errors as bson_errors
from motor.motor_asyncio import AsyncIOMotorDatabase

EDITS_COLLECTION = "schema_edits"
_OLD_COLLECTION = "custom_edits"


async def init_db(db: AsyncIOMotorDatabase) -> None:
    if _OLD_COLLECTION in await db.list_collection_names():
        await db.drop_collection(_OLD_COLLECTION)
    await db[EDITS_COLLECTION].create_index([("user_id", 1), ("profile", 1), ("package", 1), ("seq", 1)])


def doc_to_edit(doc: dict) -> dict[str, Any]:
    created = doc.get("created_at")
    if isinstance(created, datetime):
        created = created.astimezone(timezone.utc).isoformat()
    return {
        "id": str(doc.get("_id")),
        "profile": doc["profile"],
        "branch": doc.get("branch"),
        "package": doc["package"],
        "commit": doc.get("commit"),
        "op": doc["op"],
        "target": doc["target"],
        "payload": doc.get("payload") or {},
        "created_at": created,
    }


async def list_edits(db: AsyncIOMotorDatabase, user_id: str, profile: str, package: str) -> List[dict[str, Any]]:
    """The module's edits in the order they were made."""
    rows = db[EDITS_COLLECTION].find({"user_id": user_id, "profile": profile, "package": package}).sort("seq", 1)
    return [doc_to_edit(row) async for row in rows]


async def add_edits(
    db: AsyncIOMotorDatabase,
    user_id: str,
    *,
    profile: str,
    branch: Optional[str],
    package: str,
    edits: Iterable[dict[str, Any]],
) -> List[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    documents = [
        {
            "user_id": user_id,
            "profile": profile,
            "branch": branch,
            "package": package,
            "commit": edit.get("commit"),
            "op": edit["op"],
            "target": edit["target"],
            "payload": dict(edit.get("payload") or {}),
            "seq": time.time_ns() + index,
            "created_at": now,
        }
        for index, edit in enumerate(edits)
    ]
    if not documents:
        return []
    result = await db[EDITS_COLLECTION].insert_many(documents, ordered=True)
    for document, inserted in zip(documents, result.inserted_ids):
        document["_id"] = inserted
    return [doc_to_edit(document) for document in documents]


async def delete_edit(db: AsyncIOMotorDatabase, user_id: str, edit_id: str) -> int:
    try:
        oid = ObjectId(edit_id)
    except bson_errors.InvalidId:
        return 0
    result = await db[EDITS_COLLECTION].delete_one({"_id": oid, "user_id": user_id})
    return int(result.deleted_count or 0)


async def delete_edits(
    db: AsyncIOMotorDatabase, user_id: str, *, profile: Optional[str] = None, package: Optional[str] = None,
) -> int:
    """Delete the module's edits, the profile's (no package) or all of them (neither)."""
    query: dict[str, Any] = {"user_id": user_id}
    if profile is not None:
        query["profile"] = profile
    if package is not None:
        query["package"] = package
    result = await db[EDITS_COLLECTION].delete_many(query)
    return int(result.deleted_count or 0)


async def clear_all(db: AsyncIOMotorDatabase) -> None:
    """Helper for tests to start from a clean slate."""
    await db.drop_collection(EDITS_COLLECTION)

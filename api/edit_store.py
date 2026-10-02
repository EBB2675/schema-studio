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


async def list_edits(
    db: AsyncIOMotorDatabase, user_id: str, profile: str, package: Optional[str] = None,
) -> List[dict[str, Any]]:
    """The profile's edits (or one module's) in the order they were made."""
    query: dict[str, Any] = {"user_id": user_id, "profile": profile}
    if package is not None:
        query["package"] = package
    rows = db[EDITS_COLLECTION].find(query).sort("seq", 1)
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
    """Store edits, each under its own `package` (default: `package`); all of them or none.

    The ids are made here, so a batch that fails part way is removed again.
    """
    now = datetime.now(timezone.utc)
    documents = [
        {
            "_id": ObjectId(),
            "user_id": user_id,
            "profile": profile,
            "branch": branch,
            "package": edit.get("package") or package,
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
    try:
        await db[EDITS_COLLECTION].insert_many(documents, ordered=True)
    except Exception:
        await db[EDITS_COLLECTION].delete_many({"_id": {"$in": [document["_id"] for document in documents]}})
        raise
    return [doc_to_edit(document) for document in documents]


async def delete_edits(
    db: AsyncIOMotorDatabase,
    user_id: str,
    *,
    ids: Iterable[str] = (),
    profile: Optional[str] = None,
    package: Optional[str] = None,
    all_packages: bool = False,
) -> int:
    """Delete the edits with the given ids and, with a profile, the module's edits (or the profile's,
    with `all_packages`); in one request."""
    alternatives: list[dict[str, Any]] = []
    oids = []
    for edit_id in ids:
        try:
            oids.append(ObjectId(edit_id))
        except bson_errors.InvalidId:
            continue
    if oids:
        alternatives.append({"_id": {"$in": oids}})
    if profile is not None and (package is not None or all_packages):
        alternatives.append({"profile": profile} if all_packages else {"profile": profile, "package": package})
    if not alternatives:
        return 0
    result = await db[EDITS_COLLECTION].delete_many({"user_id": user_id, "$or": alternatives})
    return int(result.deleted_count or 0)


async def clear_all(db: AsyncIOMotorDatabase) -> None:
    """Helper for tests to start from a clean slate."""
    await db.drop_collection(EDITS_COLLECTION)

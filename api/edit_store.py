"""Persistence of schema edits for Dev Mode (Mongo + Motor, async).

An edit is stored as the plain dict of `api/sources/edits.py` (operation,
target, payload, the module it belongs to and the schema commit it was made
on) and replayed from there; nothing here knows how edits apply.

The edits of one request are stored together as one document (a batch). A
single-document write is atomic on any MongoDB, standalone servers included,
which have no transactions: a request's edits are stored all or none, and
undoing a change (its batch's edits) is atomic too. Deleting a module's edits
touches several batches; it is not atomic, but can be repeated safely.

Edits of older formats (collections `custom_edits`, `schema_edits`) are
dropped, not migrated.
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable, List, Optional

from bson import ObjectId, errors as bson_errors
from motor.motor_asyncio import AsyncIOMotorDatabase

EDITS_COLLECTION = "schema_edit_batches"
_OLD_COLLECTIONS = ("custom_edits", "schema_edits")


async def init_db(db: AsyncIOMotorDatabase) -> None:
    existing = await db.list_collection_names()
    for name in _OLD_COLLECTIONS:
        if name in existing:
            await db.drop_collection(name)
    await db[EDITS_COLLECTION].create_index([("user_id", 1), ("profile", 1), ("seq", 1)])


def _edit_id(batch_id: Any, index: int) -> str:
    return f"{batch_id}.{index}"


def _split_id(edit_id: str) -> tuple[ObjectId, int] | None:
    batch, _, index = str(edit_id).partition(".")
    try:
        return ObjectId(batch), int(index)
    except (bson_errors.InvalidId, TypeError, ValueError):
        return None


def _batch_edits(doc: dict) -> List[dict[str, Any]]:
    created = doc.get("created_at")
    if isinstance(created, datetime):
        created = created.astimezone(timezone.utc).isoformat()
    return [
        {
            "id": _edit_id(doc["_id"], edit["index"]),
            "profile": doc["profile"],
            "branch": doc.get("branch"),
            "package": edit["package"],
            "commit": edit.get("commit"),
            "op": edit["op"],
            "target": edit["target"],
            "payload": edit.get("payload") or {},
            "created_at": created,
        }
        for edit in doc.get("edits") or ()
    ]


async def list_edits(
    db: AsyncIOMotorDatabase, user_id: str, profile: str, package: Optional[str] = None,
) -> List[dict[str, Any]]:
    """The profile's edits (or one module's) in the order they were made."""
    rows = db[EDITS_COLLECTION].find({"user_id": user_id, "profile": profile}).sort("seq", 1)
    edits = [edit async for row in rows for edit in _batch_edits(row)]
    return [edit for edit in edits if package is None or edit["package"] == package]


async def add_edits(
    db: AsyncIOMotorDatabase,
    user_id: str,
    *,
    profile: str,
    branch: Optional[str],
    package: str,
    edits: Iterable[dict[str, Any]],
) -> List[dict[str, Any]]:
    """Store a request's edits as one batch, each under its own `package` (default: `package`)."""
    document = {
        "_id": ObjectId(),
        "user_id": user_id,
        "profile": profile,
        "branch": branch,
        "seq": time.time_ns(),
        "created_at": datetime.now(timezone.utc),
        "edits": [
            {
                "index": index,
                "package": edit.get("package") or package,
                "commit": edit.get("commit"),
                "op": edit["op"],
                "target": edit["target"],
                "payload": dict(edit.get("payload") or {}),
            }
            for index, edit in enumerate(edits)
        ],
    }
    if not document["edits"]:
        return []
    await db[EDITS_COLLECTION].insert_one(document)
    return _batch_edits(document)


async def _keep_only(db: AsyncIOMotorDatabase, row: dict, keep: list[dict]) -> int:
    """Rewrite one batch with the edits it keeps (or remove it); returns how many edits went."""
    removed = len(row.get("edits") or ()) - len(keep)
    if not removed:
        return 0
    if keep:
        await db[EDITS_COLLECTION].update_one({"_id": row["_id"]}, {"$set": {"edits": keep}})
    else:
        await db[EDITS_COLLECTION].delete_one({"_id": row["_id"]})
    return removed


async def delete_edits(
    db: AsyncIOMotorDatabase,
    user_id: str,
    *,
    ids: Iterable[str] = (),
    profile: Optional[str] = None,
    package: Optional[str] = None,
    all_packages: bool = False,
) -> int:
    """Delete the edits with the given ids and, with a profile, the module's edits (or the
    profile's, with `all_packages`). Each batch changes in one write."""
    by_batch: dict[ObjectId, set[int]] = defaultdict(set)
    for edit_id in ids:
        parts = _split_id(edit_id)
        if parts is not None:
            by_batch[parts[0]].add(parts[1])
    query: dict[str, Any] = {"user_id": user_id}
    if profile is not None and (package is not None or all_packages):
        query["$or"] = [{"_id": {"$in": list(by_batch)}}, {"profile": profile}]
    elif by_batch:
        query["_id"] = {"$in": list(by_batch)}
    else:
        return 0
    deleted = 0
    rows = [row async for row in db[EDITS_COLLECTION].find(query)]
    for row in rows:
        def goes(edit: dict) -> bool:
            if edit["index"] in by_batch.get(row["_id"], ()):
                return True
            in_scope = profile is not None and row.get("profile") == profile
            return in_scope and (all_packages or (package is not None and edit["package"] == package))

        deleted += await _keep_only(db, row, [edit for edit in row.get("edits") or () if not goes(edit)])
    return deleted


async def clear_all(db: AsyncIOMotorDatabase) -> None:
    """Helper for tests to start from a clean slate."""
    await db.drop_collection(EDITS_COLLECTION)

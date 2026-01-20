"""Persistence + conflict tracking for synthetic schema edits (Mongo-only)."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Iterable, List, Literal, Optional, Tuple, Union

from pymongo.errors import DuplicateKeyError

from .mongo import get_db

CUSTOM_EDITS_COLLECTION = "custom_edits"


@dataclass
class PersistedEdit:
    user_id: Union[int, str]
    branch: str
    package: str
    class_name: str
    edit_type: Literal["class", "quantity"]
    quantity_name: Optional[str] = None
    dtype: Optional[str] = None
    docstring: Optional[str] = None
    parent_name: Optional[str] = None
    parent_relation: Optional[str] = None
    base_sha: Optional[str] = None
    id: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def to_db(self) -> dict:
        payload = asdict(self)
        return {k: v for k, v in payload.items() if k not in {"id", "created_at", "updated_at"}}


class EditConflict(RuntimeError):
    def __init__(self, *, existing: PersistedEdit, current_sha: Optional[str]):
        super().__init__("Edit is stale compared to current branch state")
        self.existing = existing
        self.current_sha = current_sha


def init_db() -> None:
    db = get_db()
    db[CUSTOM_EDITS_COLLECTION].create_index(
        [
            ("user_id", 1),
            ("branch", 1),
            ("package", 1),
            ("class_name", 1),
            ("quantity_name", 1),
        ],
        unique=True,
    )


def _doc_to_edit(doc: dict) -> PersistedEdit:
    def _ts(value):
        if isinstance(value, datetime):
            return value.astimezone(timezone.utc).isoformat()
        return value

    return PersistedEdit(
        id=str(doc.get("_id")),
        user_id=doc.get("user_id"),
        branch=doc["branch"],
        package=doc["package"],
        class_name=doc["class_name"],
        quantity_name=doc.get("quantity_name") or None,
        dtype=doc.get("dtype"),
        docstring=doc.get("docstring"),
        parent_name=doc.get("parent_name"),
        parent_relation=doc.get("parent_relation"),
        edit_type=doc["edit_type"],
        base_sha=doc.get("base_sha"),
        created_at=_ts(doc.get("created_at")),
        updated_at=_ts(doc.get("updated_at")),
    )


def _payload_differs(a: PersistedEdit, b: PersistedEdit) -> bool:
    return any(
        getattr(a, field) != getattr(b, field)
        for field in (
            "edit_type",
            "quantity_name",
            "dtype",
            "docstring",
            "parent_name",
            "parent_relation",
        )
    )


def save_edit(edit: PersistedEdit, *, current_sha: Optional[str]) -> PersistedEdit:
    """
    Persist an edit, raising an EditConflict if an existing record was based on
    a different branch head and the payload differs.
    """
    quantity_key = edit.quantity_name or ""
    db = get_db()
    coll = db[CUSTOM_EDITS_COLLECTION]
    row = coll.find_one(
        {
            "user_id": edit.user_id,
            "branch": edit.branch,
            "package": edit.package,
            "class_name": edit.class_name,
            "quantity_name": quantity_key,
        }
    )

    if row:
        existing = _doc_to_edit(row)
        if (
            existing.base_sha
            and current_sha
            and existing.base_sha != current_sha
            and _payload_differs(existing, edit)
        ):
            raise EditConflict(existing=existing, current_sha=current_sha)

        now = datetime.now(timezone.utc)
        coll.update_one(
            {"_id": row["_id"]},
            {
                "$set": {
                    "dtype": edit.dtype,
                    "docstring": edit.docstring,
                    "parent_name": edit.parent_name,
                    "parent_relation": edit.parent_relation,
                    "edit_type": edit.edit_type,
                    "base_sha": current_sha,
                    "updated_at": now,
                }
            },
        )
        updated = coll.find_one({"_id": row["_id"]})
        return _doc_to_edit(updated)

    now = datetime.now(timezone.utc)
    payload = edit.to_db()
    payload["quantity_name"] = quantity_key
    payload["base_sha"] = current_sha
    payload["created_at"] = now
    payload["updated_at"] = now
    try:
        result = coll.insert_one(payload)
    except DuplicateKeyError:
        row = coll.find_one(
            {
                "user_id": edit.user_id,
                "branch": edit.branch,
                "package": edit.package,
                "class_name": edit.class_name,
                "quantity_name": quantity_key,
            }
        )
        return _doc_to_edit(row) if row else edit
    row = coll.find_one({"_id": result.inserted_id})
    return _doc_to_edit(row)


def list_edits(user_id: int, branch: str, package: str) -> List[PersistedEdit]:
    db = get_db()
    rows = db[CUSTOM_EDITS_COLLECTION].find(
        {"user_id": user_id, "branch": branch, "package": package}
    ).sort("_id", 1)
    return [_doc_to_edit(r) for r in rows]


def delete_edits(user_id: int, branch: str, package: str) -> int:
    db = get_db()
    result = db[CUSTOM_EDITS_COLLECTION].delete_many(
        {"user_id": user_id, "branch": branch, "package": package}
    )
    return int(result.deleted_count or 0)


def split_conflicts(
    edits: Iterable[PersistedEdit],
    *,
    current_sha: Optional[str],
) -> Tuple[List[PersistedEdit], List[PersistedEdit]]:
    """
    Partition edits into (applicable, conflicts) based on branch head.
    """
    applicable: List[PersistedEdit] = []
    conflicts: List[PersistedEdit] = []
    for edit in edits:
        if edit.base_sha and current_sha and edit.base_sha != current_sha:
            conflicts.append(edit)
        else:
            applicable.append(edit)
    return applicable, conflicts


def clear_all() -> None:
    """Helper for tests to start from a clean slate."""
    db = get_db()
    db.drop_collection(CUSTOM_EDITS_COLLECTION)

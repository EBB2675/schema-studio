"""Local persistence for Light Mode (SQLite in user config dir).

Stores a single workspace row and custom edits; no authentication.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

try:
    from platformdirs import user_config_dir
except ImportError:  # pragma: no cover - platformdirs is tiny; fallback to home
    import os

    def user_config_dir(appname: str, appauthor: str | None = None) -> str:
        base = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
        return str(base / (appauthor or appname) / appname)


DEFAULT_APP_NAME = "schema_studio_light"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_content(content: dict) -> str:
    canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class Workspace:
    branch: str
    package: str
    base_namespace: str


@dataclass
class PersistedEdit:
    edit_id: int | None
    user_id: str
    branch: str
    package: str
    class_name: str
    edit_type: str  # "class" | "quantity"
    quantity_name: Optional[str] = None
    dtype: Optional[str] = None
    docstring: Optional[str] = None
    parent_name: Optional[str] = None
    parent_relation: Optional[str] = None
    base_sha: Optional[str] = None
    content_hash: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class LocalStore:
    def __init__(self, *, db_path: Path, defaults: Workspace):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        self.defaults = defaults
        self._init_db()

    # --- low-level helpers ---
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workspace (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    branch TEXT NOT NULL,
                    package TEXT NOT NULL,
                    base_namespace TEXT NOT NULL
                );
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS custom_edits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    branch TEXT NOT NULL,
                    package TEXT NOT NULL,
                    class_name TEXT NOT NULL,
                    quantity_name TEXT DEFAULT "",
                    dtype TEXT,
                    docstring TEXT,
                    parent_name TEXT,
                    parent_relation TEXT,
                    edit_type TEXT NOT NULL,
                    base_sha TEXT,
                    content_hash TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(user_id, branch, package, class_name, quantity_name)
                );
                """
            )
            # Seed workspace defaults if empty
            cur = conn.execute("SELECT COUNT(*) AS n FROM workspace")
            if cur.fetchone()["n"] == 0:
                conn.execute(
                    "INSERT INTO workspace (id, branch, package, base_namespace) VALUES (1, ?, ?, ?)",
                    (self.defaults.branch, self.defaults.package, self.defaults.base_namespace),
                )
            conn.commit()

    # --- workspace ---
    def get_workspace(self) -> Workspace:
        with self._conn() as conn:
            row = conn.execute("SELECT branch, package, base_namespace FROM workspace WHERE id = 1").fetchone()
        if not row:
            return self.defaults
        return Workspace(branch=row["branch"], package=row["package"], base_namespace=row["base_namespace"])

    def update_workspace(self, *, branch: Optional[str] = None, package: Optional[str] = None, base_namespace: Optional[str] = None) -> Workspace:
        current = self.get_workspace()
        next_ws = Workspace(
            branch=branch or current.branch,
            package=package or current.package,
            base_namespace=base_namespace or current.base_namespace,
        )
        with self._conn() as conn:
            conn.execute(
                "UPDATE workspace SET branch = ?, package = ?, base_namespace = ? WHERE id = 1",
                (next_ws.branch, next_ws.package, next_ws.base_namespace),
            )
            conn.commit()
        return next_ws

    # --- edits ---
    def list_edits(self, *, user_id: str, branch: str, package: str) -> List[PersistedEdit]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM custom_edits
                WHERE user_id = ? AND branch = ? AND package = ?
                ORDER BY id ASC
                """,
                (user_id, branch, package),
            ).fetchall()
        return [self._row_to_edit(r) for r in rows]

    def delete_edits(self, *, user_id: str, branch: str, package: str | None = None) -> int:
        with self._conn() as conn:
            if package is None:
                cur = conn.execute(
                    "DELETE FROM custom_edits WHERE user_id = ? AND branch = ?",
                    (user_id, branch),
                )
            else:
                cur = conn.execute(
                    "DELETE FROM custom_edits WHERE user_id = ? AND branch = ? AND package = ?",
                    (user_id, branch, package),
                )
            conn.commit()
            return int(cur.rowcount or 0)

    def delete_edit(
        self,
        *,
        user_id: str,
        branch: str,
        package: str,
        class_name: str,
        quantity_name: str | None = None,
    ) -> int:
        class_candidates = [class_name]
        short_name = class_name.rsplit(".", 1)[-1]
        if short_name and short_name not in class_candidates:
            class_candidates.append(short_name)
        placeholders = ",".join("?" for _ in class_candidates)
        qname = quantity_name or ""
        with self._conn() as conn:
            cur = conn.execute(
                f"""
                DELETE FROM custom_edits
                WHERE user_id = ?
                  AND branch = ?
                  AND package = ?
                  AND class_name IN ({placeholders})
                  AND quantity_name = ?
                """,
                (user_id, branch, package, *class_candidates, qname),
            )
            conn.commit()
            return int(cur.rowcount or 0)

    def save_edit(self, *, edit: PersistedEdit, current_sha: Optional[str]) -> PersistedEdit:
        payload_hash = _hash_content(
            {
                "class_name": edit.class_name,
                "quantity_name": edit.quantity_name or "",
                "dtype": edit.dtype,
                "docstring": edit.docstring,
                "parent_name": edit.parent_name,
                "parent_relation": edit.parent_relation,
                "edit_type": edit.edit_type,
            }
        )
        now = _now_iso()
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT * FROM custom_edits
                WHERE user_id = ? AND branch = ? AND package = ? AND class_name = ? AND quantity_name = ?
                """,
                (edit.user_id, edit.branch, edit.package, edit.class_name, edit.quantity_name or ""),
            ).fetchone()

            if row:
                edit_id = row["id"]
                conn.execute(
                    """
                    UPDATE custom_edits
                    SET dtype = ?, docstring = ?, parent_name = ?, parent_relation = ?, edit_type = ?, base_sha = ?, content_hash = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        edit.dtype,
                        edit.docstring,
                        edit.parent_name,
                        edit.parent_relation,
                        edit.edit_type,
                        current_sha,
                        payload_hash,
                        now,
                        edit_id,
                    ),
                )
                conn.commit()
                return self._row_to_edit(conn.execute("SELECT * FROM custom_edits WHERE id = ?", (edit_id,)).fetchone())

            conn.execute(
                """
                INSERT INTO custom_edits (
                    user_id, branch, package, class_name, quantity_name, dtype, docstring, parent_name, parent_relation,
                    edit_type, base_sha, content_hash, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    edit.user_id,
                    edit.branch,
                    edit.package,
                    edit.class_name,
                    edit.quantity_name or "",
                    edit.dtype,
                    edit.docstring,
                    edit.parent_name,
                    edit.parent_relation,
                    edit.edit_type,
                    current_sha,
                    payload_hash,
                    now,
                    now,
                ),
            )
            conn.commit()
            new_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            return self._row_to_edit(conn.execute("SELECT * FROM custom_edits WHERE id = ?", (new_id,)).fetchone())

    # --- internal helpers ---
    def _row_to_edit(self, row: sqlite3.Row) -> PersistedEdit:
        return PersistedEdit(
            edit_id=row["id"],
            user_id=row["user_id"],
            branch=row["branch"],
            package=row["package"],
            class_name=row["class_name"],
            quantity_name=row["quantity_name"] or None,
            dtype=row["dtype"],
            docstring=row["docstring"],
            parent_name=row["parent_name"],
            parent_relation=row["parent_relation"],
            edit_type=row["edit_type"],
            base_sha=row["base_sha"],
            content_hash=row["content_hash"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


def config_root() -> Path:
    env_root = os.getenv("SCHEMA_STUDIO_HOME")
    if env_root:
        return Path(env_root)
    # fall back to user config; if not writable, fall back to cwd/.schema_studio_light
    preferred = Path(user_config_dir(DEFAULT_APP_NAME))
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return preferred
    except Exception:
        fallback = Path.cwd() / ".schema_studio_light"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def config_db_path() -> Path:
    root = config_root()
    return root / "light_mode.sqlite3"

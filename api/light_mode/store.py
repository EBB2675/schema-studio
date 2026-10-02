"""Local persistence for Light Mode (SQLite in user config dir).

Stores a single workspace row and the schema edits; no authentication. An
edit is stored as the plain dict of `api/sources/edits.py` (operation, target,
payload, profile and commit) and replayed from there; nothing here knows how
edits apply. A database in an older format is recreated, not migrated.
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, List, Optional

try:
    from platformdirs import user_config_dir
except ImportError:  # pragma: no cover - platformdirs is tiny; fallback to home
    import os

    def user_config_dir(appname: str, appauthor: str | None = None) -> str:
        base = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
        return str(base / (appauthor or appname) / appname)


DEFAULT_APP_NAME = "schema_studio_light"
# Raised whenever the tables change; a database with another format is recreated.
STORE_FORMAT = 2
_TABLES = ("workspace", "custom_edits", "edits")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Workspace:
    branch: str
    package: str
    base_namespace: str
    profile: str = ""


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
            if conn.execute("PRAGMA user_version").fetchone()[0] != STORE_FORMAT:
                for table in _TABLES:
                    conn.execute(f"DROP TABLE IF EXISTS {table}")
                conn.execute(f"PRAGMA user_version = {STORE_FORMAT}")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workspace (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    profile TEXT NOT NULL,
                    branch TEXT NOT NULL,
                    package TEXT NOT NULL,
                    base_namespace TEXT NOT NULL
                );
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS edits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    profile TEXT NOT NULL,
                    package TEXT NOT NULL,
                    commit_sha TEXT,
                    op TEXT NOT NULL,
                    target TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS edits_scope ON edits (user_id, profile, package, id)")
            cur = conn.execute("SELECT COUNT(*) AS n FROM workspace")
            if cur.fetchone()["n"] == 0:
                conn.execute(
                    "INSERT INTO workspace (id, profile, branch, package, base_namespace) VALUES (1, ?, ?, ?, ?)",
                    (self.defaults.profile, self.defaults.branch, self.defaults.package, self.defaults.base_namespace),
                )
            conn.commit()

    # --- workspace ---
    def get_workspace(self) -> Workspace:
        with self._conn() as conn:
            row = conn.execute("SELECT profile, branch, package, base_namespace FROM workspace WHERE id = 1").fetchone()
        if not row:
            return self.defaults
        return Workspace(
            branch=row["branch"], package=row["package"], base_namespace=row["base_namespace"], profile=row["profile"],
        )

    def update_workspace(
        self,
        *,
        branch: Optional[str] = None,
        package: Optional[str] = None,
        base_namespace: Optional[str] = None,
        profile: Optional[str] = None,
    ) -> Workspace:
        current = self.get_workspace()
        next_ws = Workspace(
            branch=branch or current.branch,
            package=package or current.package,
            base_namespace=base_namespace or current.base_namespace,
            profile=profile or current.profile,
        )
        with self._conn() as conn:
            conn.execute(
                "UPDATE workspace SET profile = ?, branch = ?, package = ?, base_namespace = ? WHERE id = 1",
                (next_ws.profile, next_ws.branch, next_ws.package, next_ws.base_namespace),
            )
            conn.commit()
        return next_ws

    # --- edits ---
    def list_edits(self, *, user_id: str, profile: str, package: str | None = None) -> List[dict[str, Any]]:
        """The profile's edits (or one module's) in the order they were made."""
        query, values = "SELECT * FROM edits WHERE user_id = ? AND profile = ?", [user_id, profile]
        if package is not None:
            query += " AND package = ?"
            values.append(package)
        with self._conn() as conn:
            rows = conn.execute(query + " ORDER BY id ASC", values).fetchall()
        return [self._row_to_edit(row) for row in rows]

    def add_edits(self, *, user_id: str, profile: str, package: str, edits: Iterable[dict[str, Any]]) -> List[dict[str, Any]]:
        """Append edits (plain dicts with op, target, payload, commit), each under its own `package`
        (default: `package`); all of them or none."""
        now = _now_iso()
        with self._conn() as conn:
            ids = []
            for edit in edits:
                cur = conn.execute(
                    """
                    INSERT INTO edits (user_id, profile, package, commit_sha, op, target, payload, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (user_id, profile, edit.get("package") or package, edit.get("commit"), edit["op"], edit["target"],
                     json.dumps(edit.get("payload") or {}, sort_keys=True, ensure_ascii=False), now),
                )
                ids.append(cur.lastrowid)
            conn.commit()
            rows = [conn.execute("SELECT * FROM edits WHERE id = ?", (edit_id,)).fetchone() for edit_id in ids]
        return [self._row_to_edit(row) for row in rows]

    def delete_edits(
        self,
        *,
        user_id: str,
        ids: Iterable[int] = (),
        profile: str | None = None,
        package: str | None = None,
        all_packages: bool = False,
    ) -> int:
        """Delete the edits with the given ids and, with a profile, the module's edits (or the
        profile's, with `all_packages`); in one transaction."""
        deleted = 0
        with self._conn() as conn:
            for edit_id in ids:
                deleted += conn.execute("DELETE FROM edits WHERE user_id = ? AND id = ?", (user_id, edit_id)).rowcount
            if profile is not None and (package is not None or all_packages):
                clauses, values = ["user_id = ?", "profile = ?"], [user_id, profile]
                if not all_packages:
                    clauses.append("package = ?")
                    values.append(package)
                deleted += conn.execute(f"DELETE FROM edits WHERE {' AND '.join(clauses)}", values).rowcount
            conn.commit()
        return deleted

    # --- internal helpers ---
    def _row_to_edit(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "profile": row["profile"],
            "package": row["package"],
            "commit": row["commit_sha"],
            "op": row["op"],
            "target": row["target"],
            "payload": json.loads(row["payload"]),
            "created_at": row["created_at"],
        }


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

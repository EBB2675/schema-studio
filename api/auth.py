"""Lightweight authentication and workspace persistence."""

from __future__ import annotations

import hashlib
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import jwt
except ModuleNotFoundError as exc:
    raise ImportError(
        "PyJWT is required. Install backend dependencies via `pip install -r api/requirements.txt`."
    ) from exc
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import DATA_DIR, DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, DEFAULT_PACKAGE


DB_PATH = Path(DATA_DIR) / "auth.sqlite3"
TOKEN_EXPIRES_HOURS = int(os.getenv("SCHEMA_UML_TOKEN_HOURS", "12"))
SECRET_KEY = os.getenv("SCHEMA_UML_SECRET", "schema-uml-secret")
PASSWORD_SALT = os.getenv("SCHEMA_UML_PW_SALT", "schema-uml-salt")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _hash_password(password: str) -> str:
    return hashlib.sha256(f"{password}{PASSWORD_SALT}".encode()).hexdigest()


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                user_id INTEGER PRIMARY KEY,
                branch TEXT NOT NULL,
                package TEXT NOT NULL,
                base_namespace TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )
    ensure_default_user()


def ensure_default_user() -> None:
    username = os.getenv("SCHEMA_UML_DEFAULT_USER", "admin")
    password = os.getenv("SCHEMA_UML_DEFAULT_PASSWORD", "admin")

    with _connect() as conn:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if existing:
            return

        conn.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (username, _hash_password(password)),
        )
        user_id = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()["id"]
        _ensure_workspace(conn, user_id)


def _ensure_workspace(conn: sqlite3.Connection, user_id: int) -> None:
    existing = conn.execute("SELECT user_id FROM workspaces WHERE user_id = ?", (user_id,)).fetchone()
    if existing:
        return
    conn.execute(
        "INSERT INTO workspaces (user_id, branch, package, base_namespace) VALUES (?, ?, ?, ?)",
        (user_id, DEFAULT_BRANCH, DEFAULT_PACKAGE, DEFAULT_BASE_PACKAGE),
    )


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    with _connect() as conn:
        row = conn.execute("SELECT id, username, password_hash FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            return None
        if row["password_hash"] != _hash_password(password):
            return None
        return {"id": row["id"], "username": row["username"]}


def get_user(user_id: int) -> Dict[str, Any]:
    with _connect() as conn:
        row = conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        _ensure_workspace(conn, row["id"])
        return {"id": row["id"], "username": row["username"]}


def get_workspace(user_id: int) -> Dict[str, str]:
    with _connect() as conn:
        ws = conn.execute(
            "SELECT branch, package, base_namespace FROM workspaces WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if ws is None:
            _ensure_workspace(conn, user_id)
            ws = conn.execute(
                "SELECT branch, package, base_namespace FROM workspaces WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return {
            "branch": ws["branch"],
            "package": ws["package"],
            "base_namespace": ws["base_namespace"],
        }


def update_workspace(user_id: int, *, branch: Optional[str] = None, package: Optional[str] = None, base_namespace: Optional[str] = None) -> Dict[str, str]:
    with _connect() as conn:
        _ensure_workspace(conn, user_id)
        if branch is not None:
            conn.execute("UPDATE workspaces SET branch = ? WHERE user_id = ?", (branch, user_id))
        if package is not None:
            conn.execute("UPDATE workspaces SET package = ? WHERE user_id = ?", (package, user_id))
        if base_namespace is not None:
            conn.execute("UPDATE workspaces SET base_namespace = ? WHERE user_id = ?", (base_namespace, user_id))
        conn.commit()
    return get_workspace(user_id)


def create_access_token(user: Dict[str, Any]) -> str:
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "exp": datetime.utcnow() + timedelta(hours=TOKEN_EXPIRES_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def decode_token(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)):
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")
    payload = decode_token(credentials.credentials)
    return get_user(int(payload.get("sub")))


def get_user_and_workspace(user=Depends(get_current_user)):
    workspace = get_workspace(user["id"])
    return user, workspace


def workspace_payload(workspace: Dict[str, str]) -> Dict[str, str]:
    return {
        "branch": workspace.get("branch", DEFAULT_BRANCH),
        "package": workspace.get("package", DEFAULT_PACKAGE),
        "base_namespace": workspace.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }

"""Lightweight authentication and workspace persistence."""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

try:
    import jwt
except ModuleNotFoundError as exc:
    raise ImportError(
        "PyJWT is required. Install backend dependencies via `pip install -r api/requirements.txt`."
    ) from exc
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pymongo.errors import DuplicateKeyError
from bson import ObjectId, errors as bson_errors

from .mongo import get_db
from .settings import DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, DEFAULT_PACKAGE
TOKEN_EXPIRES_HOURS = int(os.getenv("SCHEMA_UML_TOKEN_HOURS", "12"))
SECRET_KEY = os.getenv("SCHEMA_UML_SECRET", "schema-uml-secret")
PASSWORD_SALT = os.getenv("SCHEMA_UML_PW_SALT", "schema-uml-salt")
USERS_COLLECTION = "users"
WORKSPACES_COLLECTION = "workspaces"


def _hash_password(password: str) -> str:
    return hashlib.sha256(f"{password}{PASSWORD_SALT}".encode()).hexdigest()


def init_db() -> None:
    db = get_db()
    db[USERS_COLLECTION].create_index("username", unique=True)
    db[WORKSPACES_COLLECTION].create_index("user_id", unique=True)
    ensure_default_user()


def ensure_default_user() -> None:
    username = os.getenv("SCHEMA_UML_DEFAULT_USER", "admin")
    password = os.getenv("SCHEMA_UML_DEFAULT_PASSWORD", "admin")

    db = get_db()
    existing = db[USERS_COLLECTION].find_one({"username": username})
    if existing:
        return
    try:
        result = db[USERS_COLLECTION].insert_one(
            {"username": username, "password_hash": _hash_password(password)}
        )
    except DuplicateKeyError:
        return
    _ensure_workspace_mongo(db, result.inserted_id)


def _ensure_workspace_mongo(db, user_id) -> None:
    db[WORKSPACES_COLLECTION].update_one(
        {"user_id": user_id},
        {
            "$setOnInsert": {
                "branch": DEFAULT_BRANCH,
                "package": DEFAULT_PACKAGE,
                "base_namespace": DEFAULT_BASE_PACKAGE,
            }
        },
        upsert=True,
    )


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    db = get_db()
    user = db[USERS_COLLECTION].find_one({"username": username})
    if not user:
        return None
    if user["password_hash"] != _hash_password(password):
        return None
    return {"id": str(user["_id"]), "username": user["username"]}


def get_user(user_id: int) -> Dict[str, Any]:
    db = get_db()
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    user = db[USERS_COLLECTION].find_one({"_id": oid})
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    _ensure_workspace_mongo(db, user["_id"])
    return {"id": str(user["_id"]), "username": user["username"]}


def get_workspace(user_id: int) -> Dict[str, str]:
    db = get_db()
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        _ensure_workspace_mongo(db, str(user_id))
        oid = str(user_id)
    ws = db[WORKSPACES_COLLECTION].find_one({"user_id": oid})
    if ws is None:
        _ensure_workspace_mongo(db, oid)
        ws = db[WORKSPACES_COLLECTION].find_one({"user_id": oid}) or {}
    return {
        "branch": ws.get("branch", DEFAULT_BRANCH),
        "package": ws.get("package", DEFAULT_PACKAGE),
        "base_namespace": ws.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }


def update_workspace(user_id: int, *, branch: Optional[str] = None, package: Optional[str] = None, base_namespace: Optional[str] = None) -> Dict[str, str]:
    db = get_db()
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        oid = str(user_id)
    _ensure_workspace_mongo(db, oid)
    updates = {}
    if branch is not None:
        updates["branch"] = branch
    if package is not None:
        updates["package"] = package
    if base_namespace is not None:
        updates["base_namespace"] = base_namespace
    if updates:
        db[WORKSPACES_COLLECTION].update_one({"user_id": oid}, {"$set": updates})
    ws = db[WORKSPACES_COLLECTION].find_one({"user_id": oid}) or {}
    return {
        "branch": ws.get("branch", DEFAULT_BRANCH),
        "package": ws.get("package", DEFAULT_PACKAGE),
        "base_namespace": ws.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }


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
    return get_user(payload.get("sub"))


def get_user_and_workspace(user=Depends(get_current_user)):
    workspace = get_workspace(user["id"])
    return user, workspace


def workspace_payload(workspace: Dict[str, str]) -> Dict[str, str]:
    return {
        "branch": workspace.get("branch", DEFAULT_BRANCH),
        "package": workspace.get("package", DEFAULT_PACKAGE),
        "base_namespace": workspace.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }

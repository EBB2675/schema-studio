"""Authentication and workspace persistence (Mongo + Motor, async)."""

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
from bson import ObjectId, errors as bson_errors
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel, ConfigDict, Field

from .settings import DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, DEFAULT_PACKAGE

TOKEN_EXPIRES_HOURS = int(os.getenv("SCHEMA_UML_TOKEN_HOURS", "12"))
SECRET_KEY = os.getenv("SCHEMA_UML_SECRET", "schema-uml-secret")
PASSWORD_SALT = os.getenv("SCHEMA_UML_PW_SALT", "schema-uml-salt")
APP_ENV = os.getenv("SCHEMA_UML_ENV", "dev").lower()
ALLOW_INSECURE_DEFAULTS = os.getenv(
    "SCHEMA_UML_ALLOW_INSECURE_DEFAULTS",
    "true" if APP_ENV != "prod" else "false",
).lower() == "true"
ENABLE_DEFAULT_ADMIN = os.getenv(
    "SCHEMA_UML_ENABLE_DEFAULT_ADMIN",
    "true" if ALLOW_INSECURE_DEFAULTS else "false",
).lower() == "true"

USERS_COLLECTION = "users"
WORKSPACES_COLLECTION = "workspaces"


class UserDoc(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(alias="_id")
    username: str
    password_hash: str


class WorkspaceDoc(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: Optional[str] = Field(default=None, alias="_id")
    user_id: Any
    branch: str = DEFAULT_BRANCH
    package: str = DEFAULT_PACKAGE
    base_namespace: str = DEFAULT_BASE_PACKAGE


class _Workspace(BaseModel):
    branch: str = DEFAULT_BRANCH
    package: str = DEFAULT_PACKAGE
    base_namespace: str = DEFAULT_BASE_PACKAGE


def _hash_password(password: str) -> str:
    return hashlib.sha256(f"{password}{PASSWORD_SALT}".encode()).hexdigest()


def _validate_security_settings() -> None:
    if ALLOW_INSECURE_DEFAULTS:
        return
    if SECRET_KEY == "schema-uml-secret" or PASSWORD_SALT == "schema-uml-salt":
        raise RuntimeError(
            "Set SCHEMA_UML_SECRET and SCHEMA_UML_PW_SALT for non-development use "
            "(or set SCHEMA_UML_ALLOW_INSECURE_DEFAULTS=true to continue with defaults)."
        )


async def init_db(db: AsyncIOMotorDatabase) -> None:
    _validate_security_settings()
    await db[USERS_COLLECTION].create_index("username", unique=True)
    await db[WORKSPACES_COLLECTION].create_index("user_id", unique=True)
    await ensure_default_user(db)


async def ensure_default_user(db: AsyncIOMotorDatabase) -> None:
    if not ENABLE_DEFAULT_ADMIN:
        return
    username = os.getenv("SCHEMA_UML_DEFAULT_USER", "admin")
    password = os.getenv("SCHEMA_UML_DEFAULT_PASSWORD", "admin")

    existing = await db[USERS_COLLECTION].find_one({"username": username})
    if existing:
        return
    try:
        result = await db[USERS_COLLECTION].insert_one(
            {"username": username, "password_hash": _hash_password(password)}
        )
    except DuplicateKeyError:
        return
    await _ensure_workspace(db, result.inserted_id)


async def _ensure_workspace(db: AsyncIOMotorDatabase, user_id) -> None:
    await db[WORKSPACES_COLLECTION].update_one(
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


async def authenticate_user(db: AsyncIOMotorDatabase, username: str, password: str) -> Optional[Dict[str, Any]]:
    user = await db[USERS_COLLECTION].find_one({"username": username})
    if not user:
        return None
    if user["password_hash"] != _hash_password(password):
        return None
    return {"id": str(user["_id"]), "username": user["username"]}


async def get_user(db: AsyncIOMotorDatabase, user_id: int) -> Dict[str, Any]:
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    user = await db[USERS_COLLECTION].find_one({"_id": oid})
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    await _ensure_workspace(db, user["_id"])
    return {"id": str(user["_id"]), "username": user["username"]}


async def get_workspace(db: AsyncIOMotorDatabase, user_id: int) -> Dict[str, str]:
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        await _ensure_workspace(db, str(user_id))
        oid = str(user_id)
    ws = await db[WORKSPACES_COLLECTION].find_one({"user_id": oid})
    if ws is None:
        await _ensure_workspace(db, oid)
        ws = await db[WORKSPACES_COLLECTION].find_one({"user_id": oid}) or {}
    return {
        "branch": ws.get("branch", DEFAULT_BRANCH),
        "package": ws.get("package", DEFAULT_PACKAGE),
        "base_namespace": ws.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }


async def update_workspace(
    db: AsyncIOMotorDatabase,
    user_id: int,
    *,
    branch: Optional[str] = None,
    package: Optional[str] = None,
    base_namespace: Optional[str] = None,
) -> Dict[str, str]:
    try:
        oid = ObjectId(str(user_id))
    except bson_errors.InvalidId:
        oid = str(user_id)
    await _ensure_workspace(db, oid)
    updates = {}
    if branch is not None:
        updates["branch"] = branch
    if package is not None:
        updates["package"] = package
    if base_namespace is not None:
        updates["base_namespace"] = base_namespace
    if updates:
        await db[WORKSPACES_COLLECTION].update_one({"user_id": oid}, {"$set": updates})
    ws = await db[WORKSPACES_COLLECTION].find_one({"user_id": oid}) or {}
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


def db_dep(request: Request) -> AsyncIOMotorDatabase:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not available")
    return db


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme), db=Depends(db_dep)):
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")
    payload = decode_token(credentials.credentials)
    return await get_user(db, payload.get("sub"))


async def get_user_and_workspace(user=Depends(get_current_user), db=Depends(db_dep)):
    workspace = await get_workspace(db, user["id"])
    return user, workspace


def workspace_payload(workspace: Dict[str, str]) -> Dict[str, str]:
    return {
        "branch": workspace.get("branch", DEFAULT_BRANCH),
        "package": workspace.get("package", DEFAULT_PACKAGE),
        "base_namespace": workspace.get("base_namespace", DEFAULT_BASE_PACKAGE),
    }

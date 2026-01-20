"""Async MongoDB connection helpers using Motor."""

from __future__ import annotations

import asyncio
import os
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

MONGO_URI = os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml")

_client: Optional[AsyncIOMotorClient] = None
_client_lock = asyncio.Lock()


async def connect_to_mongo() -> AsyncIOMotorDatabase:
    """Initialize a global Motor client and return the database handle."""
    global _client
    if _client is not None:
        return _client[MONGO_DB]

    async with _client_lock:
        if _client is None:
            _client = AsyncIOMotorClient(MONGO_URI, uuidRepresentation="standard")
    return _client[MONGO_DB]


async def close_mongo() -> None:
    global _client
    async with _client_lock:
        if _client is not None:
            _client.close()
            _client = None

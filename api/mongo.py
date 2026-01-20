"""MongoDB connection helpers (shared across auth/edit store)."""

from __future__ import annotations

import os
from typing import Optional

from pymongo import MongoClient

MONGO_URI = os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml")

_client: Optional[MongoClient] = None


def get_db():
    """Return a singleton Mongo client database handle."""
    global _client
    if _client is None:
        _client = MongoClient(MONGO_URI, uuidRepresentation="standard")
    return _client[MONGO_DB]


def close_db() -> None:
    global _client
    if _client:
        _client.close()
        _client = None

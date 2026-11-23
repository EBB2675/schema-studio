"""Errors from build-time schema extraction."""
from __future__ import annotations
import json
import os
from .schema_source import SchemaProfile
from extractor.runner import ExtractorError

EXTRACTOR_TIMEOUT_SECONDS = int(
    os.getenv("SCHEMA_STUDIO_EXTRACTOR_TIMEOUT_SECONDS")
    or os.getenv("SCHEMA_UML_EXTRACTOR_TIMEOUT_SECONDS")
    or "300"
)


class ExtractionFailed(RuntimeError):
    """The extraction script reported an error that is not an import problem."""


class UnknownRoot(ExtractionFailed):
    """The requested root is not a class the module offers (a request error, not a failure)."""


def raise_script_error(profile: SchemaProfile, exc: ExtractorError) -> None:
    """Turn the script's error document back into the exception the app expects."""
    try:
        error = json.loads(exc.stdout)["error"]
        kind, message, name = error["type"], error["message"], error.get("name")
    except Exception:
        raise ExtractionFailed(str(exc)) from exc
    if kind == "ModuleNotFoundError":
        raise ModuleNotFoundError(message, name=name) from exc
    if kind == "ImportError":
        raise ImportError(message, name=name) from exc
    raise ExtractionFailed(f"{kind}: {message}") from exc


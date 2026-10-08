"""Snapshots: the extraction document of a profile module and its LinkML schema.

A snapshot is plain JSON. It holds the extraction document as printed by the
profile's contract script (including NOMAD methods and usage, which describe
code and are not converted), the LinkML schema converted from it, and the
conversion report. Snapshots are cached on disk per profile, schema commit and
module. When the converter code changes, the stored extraction document is
converted again; the profile environment is not started for that. When the
extractor scripts change, the module is extracted again.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import threading
from threading import Lock
from typing import Any

from extractor.contract import CONTRACT_VERSION, validate_document
from extractor.runner import EnvironmentMissing, ExtractorError, run_script

from ..light_mode.schema_source import (
    SchemaProfile,
    SchemaUnavailable,
    current_schema_info,
    setup_hint,
)
from ..light_mode.store import config_root
from .legacy import EXTRACTOR_TIMEOUT_SECONDS, raise_script_error
from .core import snapshot_yaml  # noqa: F401  (re-exported)
from .to_linkml import Conversion, convert as convert_document

logger = logging.getLogger(__name__)

SNAPSHOT_FORMAT = 1
_CONVERTER_DIR = Path(__file__).with_name("to_linkml")
_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "extractor" / "scripts"
_MEMORY: dict[Path, dict[str, Any]] = {}
_MEMORY_LIMIT = 8
_LOCK = Lock()
# One lock per snapshot file: parallel requests for the same snapshot wait for one extraction.
_PATH_LOCKS: dict[Path, Lock] = {}


class LinkMLUnavailable(RuntimeError):
    """The profile has no LinkML conversion yet."""


def supports_linkml(profile: SchemaProfile) -> bool:
    return profile.contract_script is not None and profile.linkml_prefix is not None


def tool_versions() -> dict[str, str]:
    tools = {"extraction-contract": CONTRACT_VERSION}
    for name in ("schema-studio", "linkml-runtime"):
        try:
            tools[name] = version(name)
        except PackageNotFoundError:
            tools[name] = "unknown"
    return tools


def converter_fingerprint() -> str:
    """Changes whenever the converter code changes, so stale conversions are redone."""
    digest = hashlib.sha256(str(SNAPSHOT_FORMAT).encode())
    for path in sorted(_CONVERTER_DIR.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def extractor_fingerprint() -> str:
    """Changes whenever the extractor scripts change, so stale extraction documents are redone."""
    digest = hashlib.sha256()
    for path in sorted(_SCRIPTS_DIR.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def convert(profile: SchemaProfile, document: dict[str, Any]) -> Conversion:
    if not supports_linkml(profile):
        raise LinkMLUnavailable(f"LinkML export is not available for {profile.label} yet.")
    return convert_document(document, prefix=profile.linkml_prefix)


def make_snapshot(profile: SchemaProfile, scope: str, document: dict[str, Any]) -> dict[str, Any]:
    """Build a snapshot from an extraction document (no environment needed)."""
    conversion = convert(profile, document)
    return {
        "format": SNAPSHOT_FORMAT,
        "profile": profile.key,
        "scope": scope,
        "converter": converter_fingerprint(),
        "extractor": extractor_fingerprint(),
        "tools": tool_versions(),
        "source": document["source"],
        "extraction": document,
        "linkml": conversion.schema,
        "report": conversion.report,
    }


def cache_root() -> Path:
    return config_root() / "cache" / "snapshots"


def _cache_path(profile: SchemaProfile, schema_version: str, scope: str) -> Path:
    digest = hashlib.sha256(scope.encode("utf-8")).hexdigest()[:16]
    safe_version = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in schema_version) or "unknown"
    safe_scope = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in scope)[:80]
    return cache_root() / profile.key / safe_version / f"{safe_scope}-{digest}.json"


def _extract(profile: SchemaProfile, scope: str, source_root: Path | None = None) -> dict[str, Any]:
    """Run the profile's contract script for one module, or the whole profile when scope is its base.

    `source_root` makes the script import the schema from that folder (a git
    worktree in Dev Mode) instead of the installed package.
    """
    arguments = ["--dist", profile.package_dist]
    if source_root is not None:
        arguments += ["--source-root", str(source_root)]
    if scope == profile.default_base_namespace:
        arguments += ["--base", scope]
        for discovery in profile.discovery:
            arguments += ["--discovery", discovery]
    else:
        arguments += ["--module", scope]
    try:
        payload = run_script(
            profile.environment, profile.contract_script, arguments=tuple(arguments), timeout=EXTRACTOR_TIMEOUT_SECONDS,
        )
    except EnvironmentMissing as exc:
        raise SchemaUnavailable(
            f"The {profile.label} schema environment is not set up. {setup_hint(profile)}"
        ) from exc
    except ExtractorError as exc:
        raise_script_error(profile, exc)
    return validate_document(payload["result"])


def _remember(path: Path, snapshot: dict[str, Any]) -> None:
    _MEMORY[path] = snapshot
    while len(_MEMORY) > _MEMORY_LIMIT:
        _MEMORY.pop(next(iter(_MEMORY)))


def get_snapshot(
    profile: SchemaProfile,
    scope: str | None = None,
    *,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> dict[str, Any]:
    """The snapshot for a module of the profile (default: the whole profile), from cache when possible.

    With `source_root` the schema is read from that folder (a git worktree)
    instead of the installed package; `source_version` is the worktree's
    commit, and without it the snapshot is not cached.
    """
    if not supports_linkml(profile):
        raise LinkMLUnavailable(f"LinkML export is not available for {profile.label} yet.")
    scope = scope or profile.default_base_namespace
    if source_root is not None and not source_version:
        return make_snapshot(profile, scope, _extract(profile, scope, source_root))
    info = current_schema_info(profile)
    version = info.version if source_root is None else f"{info.version}-worktree-{source_version}"
    path = _cache_path(profile, version, scope)
    fingerprint = converter_fingerprint()
    extractor = extractor_fingerprint()
    with _LOCK:
        path_lock = _PATH_LOCKS.setdefault(path, Lock())
    with path_lock:
        return _load_or_make(profile, scope, path, fingerprint, extractor, source_root)


def _load_or_make(
    profile: SchemaProfile, scope: str, path: Path, fingerprint: str, extractor: str, source_root: Path | None,
) -> dict[str, Any]:
    with _LOCK:
        cached = _MEMORY.get(path)
        if cached is not None and cached.get("converter") == fingerprint and cached.get("extractor") == extractor:
            return cached
    stored = None
    if path.is_file():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Ignoring unreadable snapshot %s", path)
    reusable = bool(stored) and stored.get("format") == SNAPSHOT_FORMAT and stored.get("extractor") == extractor
    if reusable and stored.get("converter") == fingerprint:
        snapshot = stored
    else:
        document = stored["extraction"] if reusable else _extract(profile, scope, source_root)
        snapshot = make_snapshot(profile, scope, document)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
            tmp.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            logger.warning("Could not write snapshot %s", path, exc_info=True)
    with _LOCK:
        _remember(path, snapshot)
    return snapshot

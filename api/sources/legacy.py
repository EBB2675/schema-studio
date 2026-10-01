"""Existing graph extraction, run inside the profile environments.

The functions here keep the signatures of `extractor.graph_builder` and
`extractor.usage_index`, but each call starts `extractor/scripts/legacy.py`
with the interpreter of the matching profile environment. Results are cached
on disk per profile, schema commit, command and arguments, because importing
the schema packages is slow.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from extractor.runner import EnvironmentMissing, ExtractorError, run_script

from ..light_mode.schema_source import (
    LEGACY_SCRIPT,
    SchemaProfile,
    SchemaUnavailable,
    current_schema_info,
    schema_profile_for_package,
    setup_hint,
)
from ..light_mode.store import config_root

logger = logging.getLogger(__name__)

EXTRACTOR_TIMEOUT_SECONDS = int(
    os.getenv("SCHEMA_STUDIO_EXTRACTOR_TIMEOUT_SECONDS")
    or os.getenv("SCHEMA_UML_EXTRACTOR_TIMEOUT_SECONDS")
    or "300"
)


class ExtractionFailed(RuntimeError):
    """The extraction script reported an error that is not an import problem."""


@dataclass(frozen=True)
class UsageEntry:
    """One "under the hood" code path acting on a section (see extractor/usage_index.py)."""

    kind: str
    qualname: str
    module: str
    short_name: str
    doc: str | None = None


def root_namespace(package: str) -> str:
    """Derive a stable namespace prefix used for module filtering."""
    parts = package.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    if len(parts) == 2:
        return ".".join(parts)
    return parts[0]


def cache_root() -> Path:
    return config_root() / "cache" / "legacy"


def _cache_path(profile: SchemaProfile, version: str, command: str, arguments: dict) -> Path:
    key = json.dumps({"command": command, "arguments": arguments}, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    safe_version = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in version) or "unknown"
    return cache_root() / profile.key / safe_version / f"{command}-{digest}.json"


def _raise_script_error(profile: SchemaProfile, exc: ExtractorError) -> None:
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


def run_legacy(
    profile: SchemaProfile,
    command: str,
    arguments: dict,
    *,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> Any:
    """
    Run one legacy command in the profile environment and return its result.

    `source_root` makes the script import the schema from that folder (a git
    worktree in Dev Mode) instead of the installed package; `source_version`
    is the commit of that worktree and becomes part of the cache key.
    """
    info = current_schema_info(profile)
    version = info.version if source_root is None else f"{info.version}-worktree-{source_version or 'unknown'}"
    cacheable = source_root is None or bool(source_version)
    path = _cache_path(profile, version, command, arguments)
    if cacheable and path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Ignoring unreadable cache file %s", path)

    script_arguments: tuple[str, ...] = (command, json.dumps(arguments, ensure_ascii=False))
    if source_root is not None:
        script_arguments = ("--source-root", str(source_root), *script_arguments)
    try:
        payload = run_script(
            profile.environment,
            LEGACY_SCRIPT,
            arguments=script_arguments,
            timeout=EXTRACTOR_TIMEOUT_SECONDS,
        )
    except EnvironmentMissing as exc:
        raise SchemaUnavailable(
            f"The {profile.label} schema environment is not set up. {setup_hint(profile)}"
        ) from exc
    except ExtractorError as exc:
        _raise_script_error(profile, exc)
    result = payload["result"]

    if cacheable:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            logger.warning("Could not write cache file %s", path, exc_info=True)
    return result


def list_schema_modules(base_package: str) -> list[dict]:
    """
    Schema modules under `base_package` that define at least one section, as
    `{"package": ..., "sections": [...]}`. Modules that fail to import are skipped.
    """
    profile = schema_profile_for_package(base_package)
    result = run_legacy(
        profile,
        "catalog",
        {"base": base_package, "dist": profile.package_dist, "discovery": list(profile.discovery)},
    )
    for skipped in result.get("skipped") or []:
        logger.info("Skipped module %s while listing %s: %s", skipped.get("module"), base_package, skipped.get("error"))
    return list(result.get("modules") or [])


def list_sections(
    package: str,
    *,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> list[str]:
    """List section-like classes defined in the given module."""
    profile = schema_profile_for_package(package)
    return run_legacy(profile, "sections", {"package": package}, source_root=source_root, source_version=source_version)


def build_graph(
    package: str,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    base_namespace: str | None = None,
    *,
    extractor: str | None = None,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> dict:
    """Build the graph JSON for a module, starting at `root` if given."""
    profile = schema_profile_for_package(package, base_namespace)
    arguments = {
        "package": package,
        "root": root,
        "include_quantities": include_quantities,
        "include_subsections": include_subsections,
        "include_inheritance": include_inheritance,
        "allow_cross_module": allow_cross_module,
        "base_namespace": base_namespace,
    }
    if extractor:
        arguments["extractor"] = extractor
    return run_legacy(profile, "graph", arguments, source_root=source_root, source_version=source_version)


def get_usage_for_section(section_id: str) -> tuple[UsageEntry, ...]:
    """Return the normalization code paths that act on a section."""
    profile = schema_profile_for_package(section_id)
    entries = run_legacy(profile, "usage", {"section_id": section_id})
    return tuple(UsageEntry(**entry) for entry in entries)

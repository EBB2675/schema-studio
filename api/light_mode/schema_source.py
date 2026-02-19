"""Schema sourcing for Light Mode.

Policy:
- Always use an installed schema package selected by profile.
- Light mode branch is fixed by profile (e.g. develop/main).
- Never use local checkouts/worktrees.
"""
from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SchemaProfile:
    key: str
    package_import: str
    package_dist: str
    default_branch: str
    default_remote_repo: str
    default_base_namespace: str
    default_package: str


SCHEMA_PROFILES: dict[str, SchemaProfile] = {
    "nomad": SchemaProfile(
        key="nomad",
        package_import="nomad_simulations",
        package_dist="nomad-simulations",
        default_branch="develop",
        default_remote_repo="https://github.com/nomad-coe/nomad-simulations.git",
        default_base_namespace="nomad_simulations.schema_packages",
        default_package="nomad_simulations.schema_packages.model_method",
    ),
    "bam": SchemaProfile(
        key="bam",
        package_import="bam_masterdata",
        package_dist="bam-masterdata",
        default_branch="main",
        default_remote_repo="https://github.com/BAMresearch/bam-masterdata.git",
        default_base_namespace="bam_masterdata.datamodel",
        default_package="bam_masterdata.datamodel.object_types",
    ),
}


def _select_profile() -> SchemaProfile:
    requested = os.getenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", "").strip().lower()
    if requested in SCHEMA_PROFILES:
        return SCHEMA_PROFILES[requested]

    if requested:
        for profile in SCHEMA_PROFILES.values():
            if requested in {profile.package_import, profile.package_dist}:
                return profile

    package_hint = os.getenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", "")
    if package_hint.startswith("bam_masterdata"):
        return SCHEMA_PROFILES["bam"]

    return SCHEMA_PROFILES["nomad"]


ACTIVE_PROFILE = _select_profile()
LIGHT_PROFILE_KEY = ACTIVE_PROFILE.key
PACKAGE_IMPORT = ACTIVE_PROFILE.package_import
PACKAGE_DIST = ACTIVE_PROFILE.package_dist
DEFAULT_BRANCH = ACTIVE_PROFILE.default_branch
DEFAULT_REMOTE_REPO = ACTIVE_PROFILE.default_remote_repo
DEFAULT_BASE_NAMESPACE = ACTIVE_PROFILE.default_base_namespace
DEFAULT_PACKAGE = ACTIVE_PROFILE.default_package
UPGRADE_TARGET = f"git+{DEFAULT_REMOTE_REPO}@{DEFAULT_BRANCH}"


@dataclass
class SchemaInfo:
    package_root: Path
    version: str
    source: str  # "installed" | "remote-<branch>"


class SchemaUnavailable(RuntimeError):
    pass


def active_profile() -> SchemaProfile:
    return ACTIVE_PROFILE


def _distribution() -> importlib.metadata.Distribution:
    try:
        return importlib.metadata.distribution(PACKAGE_DIST)
    except importlib.metadata.PackageNotFoundError as exc:
        raise SchemaUnavailable(
            f"{PACKAGE_DIST} is not installed. Reinstall Light Mode to pull the configured remote package."
        ) from exc


def _package_root() -> Path:
    spec = importlib.util.find_spec(PACKAGE_IMPORT)
    if spec is None:
        raise SchemaUnavailable(
            f"Could not import {PACKAGE_IMPORT}. Reinstall Light Mode to restore schema package availability."
        )
    location = spec.submodule_search_locations
    if location:
        return Path(next(iter(location))).resolve()
    if spec.origin:
        return Path(spec.origin).resolve().parent
    raise SchemaUnavailable(f"Could not determine install location for {PACKAGE_IMPORT}.")


def _direct_url_payload(dist: importlib.metadata.Distribution) -> dict | None:
    try:
        raw = dist.read_text("direct_url.json")
    except Exception:
        raw = None
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _normalize_repo(url: str) -> str:
    base = url.rstrip("/")
    return base[:-4] if base.endswith(".git") else base


def _schema_info_from_install() -> SchemaInfo:
    dist = _distribution()
    package_root = _package_root()
    if str(package_root.parent) not in sys.path:
        sys.path.insert(0, str(package_root.parent))

    direct_url = _direct_url_payload(dist)
    if not direct_url:
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    source_url = direct_url.get("url")
    if not isinstance(source_url, str) or source_url.startswith("file://"):
        raise SchemaUnavailable(f"Light Mode does not support local {PACKAGE_DIST} sources.")

    if _normalize_repo(source_url) != _normalize_repo(DEFAULT_REMOTE_REPO):
        raise SchemaUnavailable(
            f"Light Mode for profile '{LIGHT_PROFILE_KEY}' must use repository {DEFAULT_REMOTE_REPO}."
        )

    vcs_info = direct_url.get("vcs_info")
    if not isinstance(vcs_info, dict):
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    requested = vcs_info.get("requested_revision")
    if requested and requested != DEFAULT_BRANCH:
        raise SchemaUnavailable(
            f"Light Mode profile '{LIGHT_PROFILE_KEY}' is pinned to remote {DEFAULT_BRANCH}; found revision {requested!r}."
        )

    commit = vcs_info.get("commit_id")
    version = commit if isinstance(commit, str) and commit else dist.version
    return SchemaInfo(package_root=package_root, version=version, source=f"remote-{DEFAULT_BRANCH}")


def ensure_schema_ready() -> SchemaInfo:
    """Validate that the installed schema package is available."""
    return _schema_info_from_install()


def current_schema_info() -> SchemaInfo:
    """Return current installed schema metadata."""
    return _schema_info_from_install()


def update_schema() -> SchemaInfo:
    """
    Upgrade to the latest branch package for the active profile using pip.
    Keeps local Light Mode edits in SQLite.
    """
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", UPGRADE_TARGET]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise SchemaUnavailable(f"Schema update failed: {detail or 'pip install failed'}")

    importlib.invalidate_caches()
    prefix = f"{PACKAGE_IMPORT}."
    for name in list(sys.modules.keys()):
        if name == PACKAGE_IMPORT or name.startswith(prefix):
            sys.modules.pop(name, None)

    return _schema_info_from_install()


def list_modules_for_base(base_package: str) -> list[str]:
    """
    List module names under an installed package without importing submodules.
    This avoids side effects from module-level registration code.
    """
    try:
        pkg = importlib.import_module(base_package)
    except Exception:
        return []

    modules: set[str] = {base_package}
    pkg_paths = getattr(pkg, "__path__", None)
    if not pkg_paths:
        return sorted(modules)

    for raw_root in pkg_paths:
        root = Path(raw_root)
        if not root.exists():
            continue
        for py_file in root.rglob("*.py"):
            rel = py_file.relative_to(root)
            if py_file.name == "__init__.py":
                if rel.parts[:-1]:
                    mod_name = ".".join((base_package, *rel.parts[:-1]))
                else:
                    mod_name = base_package
            else:
                mod_name = ".".join((base_package, *rel.with_suffix("").parts))
            modules.add(mod_name)

    return sorted(modules)

"""Schema sourcing for Light Mode.

Policy:
- Always use an installed schema package selected by profile.
- Light mode branch is fixed by profile (for example develop/main).
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
    """Profile configuration describing one supported schema source package."""

    key: str
    label: str
    package_import: str
    package_dist: str
    default_branch: str
    default_remote_repo: str
    default_base_namespace: str
    default_package: str
    default_root: str


@dataclass
class SchemaInfo:
    """Runtime metadata about the installed schema package source/version."""

    package_root: Path
    version: str
    source: str  # "installed" | "remote-<branch>" | "bundled"


class SchemaUnavailable(RuntimeError):
    """Raised when a schema profile cannot be validated or updated."""

    pass


SCHEMA_PROFILES: dict[str, SchemaProfile] = {
    "nomad": SchemaProfile(
        key="nomad",
        label="nomad-simulations",
        package_import="nomad_simulations",
        package_dist="nomad-simulations",
        default_branch="develop",
        default_remote_repo="https://github.com/nomad-coe/nomad-simulations.git",
        default_base_namespace="nomad_simulations.schema_packages",
        default_package="nomad_simulations.schema_packages.model_method",
        default_root="ModelMethod",
    ),
    "bam": SchemaProfile(
        key="bam",
        label="bam-masterdata",
        package_import="bam_masterdata",
        package_dist="bam-masterdata",
        default_branch="main",
        default_remote_repo="https://github.com/BAMresearch/bam-masterdata.git",
        default_base_namespace="bam_masterdata.datamodel",
        default_package="bam_masterdata.datamodel.object_types",
        default_root="SearchQuery",
    ),
}


def _select_profile() -> SchemaProfile:
    """Select active schema profile from env override, then package hint, then default."""
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
DEFAULT_ROOT = ACTIVE_PROFILE.default_root
UPGRADE_TARGET = f"git+{DEFAULT_REMOTE_REPO}@{DEFAULT_BRANCH}"


def active_profile() -> SchemaProfile:
    """Return the default profile resolved from environment and defaults."""
    return ACTIVE_PROFILE


def list_schema_profiles() -> list[SchemaProfile]:
    """Return supported schema profiles in display order."""
    return [SCHEMA_PROFILES["nomad"], SCHEMA_PROFILES["bam"]]


def schema_profile_for_key(key: str | None) -> SchemaProfile:
    """Resolve a profile by short key or package identifier."""
    if not key:
        return ACTIVE_PROFILE

    normalized = key.strip().lower()
    if normalized in SCHEMA_PROFILES:
        return SCHEMA_PROFILES[normalized]

    for profile in SCHEMA_PROFILES.values():
        if normalized in {profile.package_import, profile.package_dist}:
            return profile

    raise SchemaUnavailable(f"Unsupported schema profile {key!r}.")


def schema_profile_for_package(package: str | None, base_namespace: str | None = None) -> SchemaProfile:
    """Infer a profile from the selected package or base namespace."""
    hints = [package or "", base_namespace or ""]
    for hint in hints:
        if hint.startswith("bam_masterdata"):
            return SCHEMA_PROFILES["bam"]
        if hint.startswith("nomad_simulations"):
            return SCHEMA_PROFILES["nomad"]
    return ACTIVE_PROFILE


def _resolve_profile(profile: SchemaProfile | str | None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaProfile:
    if isinstance(profile, SchemaProfile):
        return profile
    if isinstance(profile, str):
        return schema_profile_for_key(profile)
    return schema_profile_for_package(package, base_namespace)


def _is_packaged_backend() -> bool:
    """Return whether Light Mode is running from a packaged desktop backend."""
    return getattr(sys, "frozen", False) or os.getenv("SCHEMA_STUDIO_PACKAGED_BACKEND") == "1"


def _distribution(profile: SchemaProfile) -> importlib.metadata.Distribution:
    """Return installed package distribution metadata for the selected profile."""
    try:
        return importlib.metadata.distribution(profile.package_dist)
    except importlib.metadata.PackageNotFoundError as exc:
        raise SchemaUnavailable(
            f"{profile.package_dist} is not installed. Load the schema while online or reinstall Light Mode with the required package."
        ) from exc


def _package_root(profile: SchemaProfile) -> Path:
    """Resolve filesystem location of the selected schema package."""
    spec = importlib.util.find_spec(profile.package_import)
    if spec is None:
        raise SchemaUnavailable(
            f"Could not import {profile.package_import}. Load the schema while online or reinstall Light Mode."
        )
    location = spec.submodule_search_locations
    if location:
        return Path(next(iter(location))).resolve()
    if spec.origin:
        return Path(spec.origin).resolve().parent
    raise SchemaUnavailable(f"Could not determine install location for {profile.package_import}.")


def _direct_url_payload(dist: importlib.metadata.Distribution) -> dict | None:
    """Parse PEP 610 `direct_url.json` metadata when available."""
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
    """Normalize git URL for comparisons by trimming trailing slash and `.git` suffix."""
    base = url.rstrip("/")
    return base[:-4] if base.endswith(".git") else base


def schema_available(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> bool:
    """Return whether the selected profile is importable in the current runtime."""
    resolved = _resolve_profile(profile, package=package, base_namespace=base_namespace)
    return importlib.util.find_spec(resolved.package_import) is not None


def _schema_info_from_install(profile: SchemaProfile) -> SchemaInfo:
    """Validate installed package provenance and return source/version metadata."""
    package_root = _package_root(profile)
    if str(package_root.parent) not in sys.path:
        sys.path.insert(0, str(package_root.parent))

    if _is_packaged_backend():
        # Frozen desktop builds ship a bundled schema snapshot rather than a
        # pip-managed install, so importlib.metadata is not a reliable source.
        version = os.getenv("SCHEMA_STUDIO_SCHEMA_VERSION", "") or ""
        if not version:
            try:
                package = importlib.import_module(profile.package_import)
            except Exception:
                package = None
            version = getattr(package, "__version__", None) or "bundled"
        return SchemaInfo(package_root=package_root, version=version, source="bundled")

    dist = _distribution(profile)
    direct_url = _direct_url_payload(dist)
    if not direct_url:
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    source_url = direct_url.get("url")
    if not isinstance(source_url, str) or source_url.startswith("file://"):
        raise SchemaUnavailable(f"Light Mode does not support local {profile.package_dist} sources.")

    if _normalize_repo(source_url) != _normalize_repo(profile.default_remote_repo):
        raise SchemaUnavailable(
            f"Light Mode profile '{profile.key}' must use repository {profile.default_remote_repo}."
        )

    vcs_info = direct_url.get("vcs_info")
    if not isinstance(vcs_info, dict):
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    requested = vcs_info.get("requested_revision")
    if requested and requested != profile.default_branch:
        raise SchemaUnavailable(
            f"Light Mode profile '{profile.key}' is pinned to remote {profile.default_branch}; found revision {requested!r}."
        )

    commit = vcs_info.get("commit_id")
    version = commit if isinstance(commit, str) and commit else dist.version
    return SchemaInfo(package_root=package_root, version=version, source=f"remote-{profile.default_branch}")


def ensure_schema_ready(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """Validate that the selected schema package is available."""
    return _schema_info_from_install(_resolve_profile(profile, package=package, base_namespace=base_namespace))


def current_schema_info(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """Return current installed schema metadata for the selected profile."""
    return _schema_info_from_install(_resolve_profile(profile, package=package, base_namespace=base_namespace))


def update_schema(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """
    Upgrade or install the selected profile package from its configured remote.
    Keeps local Light Mode edits in SQLite.
    """
    resolved = _resolve_profile(profile, package=package, base_namespace=base_namespace)
    if _is_packaged_backend():
        raise SchemaUnavailable(
            "Schema updates are disabled in the packaged desktop build. Reinstall a newer desktop release to get a newer bundled schema."
        )

    upgrade_target = f"git+{resolved.default_remote_repo}@{resolved.default_branch}"
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", upgrade_target]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise SchemaUnavailable(f"Schema update failed: {detail or 'pip install failed'}")

    importlib.invalidate_caches()
    prefix = f"{resolved.package_import}."
    for name in list(sys.modules.keys()):
        if name == resolved.package_import or name.startswith(prefix):
            sys.modules.pop(name, None)

    return _schema_info_from_install(resolved)


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

"""Schema profiles and their environments.

Policy:
- Each profile has its own environment under `environments/<profile>/`, a uv
  project that installs only that schema package from its tracked branch.
- The app never installs or imports a schema package. It reads a schema by
  running a script from `extractor/scripts/` with the environment's interpreter.
- Creating or updating an environment is an explicit action (`update_schema`).
- Light mode branch is fixed by profile (for example develop/main).
- Never use local checkouts/worktrees.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from extractor.runner import EnvironmentMissing, ExtractorEnvironment, ExtractorError, run_script

REPO_ROOT = Path(__file__).resolve().parents[2]
LEGACY_SCRIPT = REPO_ROOT / "extractor" / "scripts" / "legacy.py"
NOMAD_SCRIPT = REPO_ROOT / "extractor" / "scripts" / "nomad.py"
BAM_SCRIPT = REPO_ROOT / "extractor" / "scripts" / "bam.py"
INFO_TIMEOUT_SECONDS = 60
UPDATE_TIMEOUT_SECONDS = int(os.getenv("SCHEMA_STUDIO_UPDATE_TIMEOUT_SECONDS", "1800"))


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
    # How schema modules are found inside the environment: "entry-points"
    # (NOMAD schema package entry points) and/or "walk" (every module under the
    # base namespace).
    discovery: tuple[str, ...] = ("walk",)
    # Id prefix of the LinkML schema, and the extractor script that prints the
    # extraction document it is converted from (None: no LinkML conversion yet).
    linkml_prefix: str | None = None
    contract_script: Path | None = None
    # What the source offers besides the schema: "usage" (the code that acts on
    # a class, shown under the hood) and "methods" (public methods on classes).
    capabilities: frozenset[str] = frozenset()
    # Which edits the schema allows and how new elements are described: a rule
    # set of `api/sources/edits.py` ("nomad" or "bam-masterdata").
    edit_rules: str = "nomad"

    @property
    def environment(self) -> ExtractorEnvironment:
        """The uv project that holds this profile's schema package."""
        return ExtractorEnvironment(name=self.key, directory=environments_root() / self.key)


@dataclass
class SchemaInfo:
    """Runtime metadata about the schema package installed in a profile environment."""

    version: str  # commit SHA when installed from git, otherwise the package version
    source: str  # "installed" | "remote-<branch>"
    package_version: str | None = None
    commit: str | None = None


class SchemaUnavailable(RuntimeError):
    """Raised when a schema profile cannot be validated or updated."""

    pass


SCHEMA_PROFILES: dict[str, SchemaProfile] = {
    "nomad-simulations": SchemaProfile(
        key="nomad-simulations",
        label="nomad-simulations",
        package_import="nomad_simulations",
        package_dist="nomad-simulations",
        default_branch="develop",
        default_remote_repo="https://github.com/nomad-coe/nomad-simulations.git",
        default_base_namespace="nomad_simulations.schema_packages",
        default_package="nomad_simulations.schema_packages.model_method",
        default_root="ModelMethod",
        # The single entry point only loads `general`; the other schema modules
        # are found by walking the namespace.
        discovery=("entry-points", "walk"),
        linkml_prefix="nomadsim",
        contract_script=NOMAD_SCRIPT,
        capabilities=frozenset({"usage", "methods"}),
    ),
    "nomad-measurements": SchemaProfile(
        key="nomad-measurements",
        label="nomad-measurements",
        package_import="nomad_measurements",
        package_dist="nomad-measurements",
        default_branch="main",
        default_remote_repo="https://github.com/FAIRmat-NFDI/nomad-measurements.git",
        default_base_namespace="nomad_measurements",
        default_package="nomad_measurements.xrd.schema",
        default_root="ELNXRayDiffraction",
        # One entry point per technique; walking would also import parsers and helpers.
        discovery=("entry-points",),
        linkml_prefix="nomadmeas",
        contract_script=NOMAD_SCRIPT,
        capabilities=frozenset({"usage", "methods"}),
    ),
    "bam-masterdata": SchemaProfile(
        key="bam-masterdata",
        label="bam-masterdata",
        package_import="bam_masterdata",
        package_dist="bam-masterdata",
        default_branch="main",
        default_remote_repo="https://github.com/BAMresearch/bam-masterdata.git",
        default_base_namespace="bam_masterdata.datamodel",
        default_package="bam_masterdata.datamodel.object_types",
        default_root="SearchQuery",
        # bam-masterdata declares no schema entry point yet.
        discovery=("walk",),
        linkml_prefix="bammd",
        contract_script=BAM_SCRIPT,
        edit_rules="bam-masterdata",
    ),
}
DEFAULT_PROFILE_KEY = "nomad-simulations"


def environments_root() -> Path:
    """Folder that holds one uv project per profile."""
    override = os.getenv("SCHEMA_STUDIO_ENVIRONMENTS_DIR")
    return Path(override) if override else REPO_ROOT / "environments"


def _profile_for_hint(hint: str) -> SchemaProfile | None:
    """Match a package or namespace name to the profile that owns it."""
    for profile in SCHEMA_PROFILES.values():
        if hint == profile.package_import or hint.startswith(f"{profile.package_import}."):
            return profile
    return None


def _select_profile() -> SchemaProfile:
    """Select active schema profile from env override, then package hint, then default."""
    requested = os.getenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", "").strip().lower()
    if requested in SCHEMA_PROFILES:
        return SCHEMA_PROFILES[requested]

    if requested:
        for profile in SCHEMA_PROFILES.values():
            if requested in {profile.package_import, profile.package_dist}:
                return profile

    hinted = _profile_for_hint(os.getenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", ""))
    return hinted or SCHEMA_PROFILES[DEFAULT_PROFILE_KEY]


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
    return list(SCHEMA_PROFILES.values())


def schema_profile_for_key(key: str | None) -> SchemaProfile:
    """Resolve a profile by key or package identifier."""
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
    for hint in (package or "", base_namespace or ""):
        profile = _profile_for_hint(hint)
        if profile:
            return profile
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


def _normalize_repo(url: str) -> str:
    """Normalize git URL for comparisons by trimming trailing slash and `.git` suffix."""
    base = url.rstrip("/")
    return base[:-4] if base.endswith(".git") else base


def setup_hint(profile: SchemaProfile) -> str:
    """One sentence that tells the user how to create the profile environment."""
    return (
        f"Load it from the schema selection in the app, or run `uv sync --project {profile.environment.directory}`."
    )


def schema_available(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> bool:
    """Return whether the environment of the selected profile exists."""
    resolved = _resolve_profile(profile, package=package, base_namespace=base_namespace)
    return resolved.environment.python.is_file()


def _environment_stamp(profile: SchemaProfile) -> tuple:
    """Cheap fingerprint that changes when packages in the environment change."""
    directory = profile.environment.directory
    candidates = [directory / "uv.lock", profile.environment.python]
    candidates += sorted((directory / ".venv").glob("lib/python*/site-packages"))
    candidates.append(directory / ".venv" / "Lib" / "site-packages")
    stamp = []
    for path in candidates:
        try:
            stamp.append((str(path), path.stat().st_mtime_ns))
        except OSError:
            continue
    return tuple(stamp)


_info_lock = Lock()
_info_cache: dict[str, tuple[tuple, SchemaInfo]] = {}


def _schema_info_from_payload(profile: SchemaProfile, payload: dict) -> SchemaInfo:
    """Check where the schema package was installed from and return its version."""
    package_version = str(payload.get("version") or "")
    direct_url = payload.get("direct_url")
    if not isinstance(direct_url, dict):
        return SchemaInfo(version=package_version, source="installed", package_version=package_version)

    source_url = direct_url.get("url")
    if not isinstance(source_url, str) or source_url.startswith("file://"):
        raise SchemaUnavailable(f"Light Mode does not support local {profile.package_dist} sources.")

    if _normalize_repo(source_url) != _normalize_repo(profile.default_remote_repo):
        raise SchemaUnavailable(
            f"Light Mode profile '{profile.key}' must use repository {profile.default_remote_repo}."
        )

    vcs_info = direct_url.get("vcs_info")
    if not isinstance(vcs_info, dict):
        return SchemaInfo(version=package_version, source="installed", package_version=package_version)

    requested = vcs_info.get("requested_revision")
    if requested and requested != profile.default_branch:
        raise SchemaUnavailable(
            f"Light Mode profile '{profile.key}' is pinned to remote {profile.default_branch}; found revision {requested!r}."
        )

    commit = vcs_info.get("commit_id")
    commit = commit if isinstance(commit, str) and commit else None
    return SchemaInfo(
        version=commit or package_version,
        source=f"remote-{profile.default_branch}",
        package_version=package_version,
        commit=commit,
    )


def _schema_info_from_environment(profile: SchemaProfile) -> SchemaInfo:
    """Ask the profile environment which schema package version it holds."""
    if _is_packaged_backend():
        raise SchemaUnavailable(
            f"The {profile.label} schema is not bundled with this desktop build."
        )

    stamp = _environment_stamp(profile)
    with _info_lock:
        cached = _info_cache.get(profile.key)
        if cached and cached[0] == stamp:
            return cached[1]

    try:
        payload = run_script(
            profile.environment,
            LEGACY_SCRIPT,
            arguments=("info", json.dumps({"dist": profile.package_dist})),
            timeout=INFO_TIMEOUT_SECONDS,
        )
    except EnvironmentMissing as exc:
        raise SchemaUnavailable(
            f"The {profile.label} schema environment is not set up. {setup_hint(profile)}"
        ) from exc
    except ExtractorError as exc:
        raise SchemaUnavailable(
            f"Could not read {profile.package_dist} from its environment. {setup_hint(profile)} ({exc})"
        ) from exc

    if not isinstance(payload, dict) or not payload.get("ok") or not isinstance(payload.get("result"), dict):
        raise SchemaUnavailable(f"Unexpected answer from the {profile.label} schema environment.")
    info = _schema_info_from_payload(profile, payload["result"])
    with _info_lock:
        _info_cache[profile.key] = (stamp, info)
    return info


def ensure_schema_ready(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """Validate that the environment of the selected profile is usable."""
    return _schema_info_from_environment(_resolve_profile(profile, package=package, base_namespace=base_namespace))


def current_schema_info(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """Return current schema metadata for the selected profile."""
    return _schema_info_from_environment(_resolve_profile(profile, package=package, base_namespace=base_namespace))


def _run_uv(arguments: list[str], profile: SchemaProfile) -> None:
    uv = shutil.which("uv")
    if not uv:
        raise SchemaUnavailable(
            "Schema environments are managed with `uv`, which was not found on PATH. "
            "Install it (https://docs.astral.sh/uv/) and try again."
        )
    # The environment is selected by --project; do not let the app's own
    # virtual environment leak into the command.
    env = {k: v for k, v in os.environ.items() if k not in {"VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PYTHONPATH"}}
    try:
        proc = subprocess.run(
            [uv, *arguments, "--project", str(profile.environment.directory)],
            capture_output=True, text=True, env=env, timeout=UPDATE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise SchemaUnavailable(f"Schema update timed out after {UPDATE_TIMEOUT_SECONDS}s.") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise SchemaUnavailable(f"Schema update failed: {detail or 'uv failed'}")


def update_schema(profile: SchemaProfile | str | None = None, *, package: str | None = None, base_namespace: str | None = None) -> SchemaInfo:
    """
    Create the profile environment, or move it to the latest commit of its
    tracked branch. Keeps local Light Mode edits in SQLite.
    """
    resolved = _resolve_profile(profile, package=package, base_namespace=base_namespace)
    if _is_packaged_backend():
        raise SchemaUnavailable(
            "Schema updates are disabled in the packaged desktop build. Reinstall a newer desktop release to get a newer bundled schema."
        )
    if not (resolved.environment.directory / "pyproject.toml").is_file():
        raise SchemaUnavailable(
            f"No environment definition found for profile '{resolved.key}' in {resolved.environment.directory}."
        )

    _run_uv(["lock", "--upgrade-package", resolved.package_dist], resolved)
    _run_uv(["sync"], resolved)

    with _info_lock:
        _info_cache.pop(resolved.key, None)
    return _schema_info_from_environment(resolved)

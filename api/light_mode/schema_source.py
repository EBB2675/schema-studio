"""Schema sourcing for Light Mode.

Policy:
- Always use the installed `nomad-simulations` Python package.
- Always target the remote `develop` branch lineage for updates.
- Never use local checkouts/worktrees.
"""
from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import json
import pkgutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PACKAGE_IMPORT = "nomad_simulations"
PACKAGE_DIST = "nomad-simulations"
DEFAULT_BRANCH = "develop"
DEFAULT_REMOTE_REPO = "https://github.com/nomad-coe/nomad-simulations.git"
UPGRADE_TARGET = f"git+{DEFAULT_REMOTE_REPO}@{DEFAULT_BRANCH}"


@dataclass
class SchemaInfo:
    package_root: Path
    version: str
    source: str  # "installed" | "remote-develop"


class SchemaUnavailable(RuntimeError):
    pass


def _distribution() -> importlib.metadata.Distribution:
    try:
        return importlib.metadata.distribution(PACKAGE_DIST)
    except importlib.metadata.PackageNotFoundError as exc:
        raise SchemaUnavailable(
            "nomad-simulations is not installed. Reinstall Light Mode so it pulls the remote develop package."
        ) from exc


def _package_root() -> Path:
    spec = importlib.util.find_spec(PACKAGE_IMPORT)
    if spec is None:
        raise SchemaUnavailable(
            "Could not import nomad_simulations. Reinstall Light Mode to restore schema package availability."
        )
    location = spec.submodule_search_locations
    if location:
        return Path(next(iter(location))).resolve()
    if spec.origin:
        return Path(spec.origin).resolve().parent
    raise SchemaUnavailable("Could not determine nomad_simulations install location.")


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


def _schema_info_from_install() -> SchemaInfo:
    dist = _distribution()
    package_root = _package_root()
    if str(package_root.parent) not in sys.path:
        sys.path.insert(0, str(package_root.parent))

    direct_url = _direct_url_payload(dist)
    if not direct_url:
        # Regular index/wheel installs do not include direct_url.json.
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    source_url = direct_url.get("url")
    if not isinstance(source_url, str) or source_url.startswith("file://"):
        raise SchemaUnavailable("Light Mode does not support local nomad-simulations sources.")

    def normalize_repo(url: str) -> str:
        base = url.rstrip("/")
        return base[:-4] if base.endswith(".git") else base

    if normalize_repo(source_url) != normalize_repo(DEFAULT_REMOTE_REPO):
        raise SchemaUnavailable(
            "Light Mode must use the remote nomad-simulations repository on develop."
        )

    vcs_info = direct_url.get("vcs_info")
    if not isinstance(vcs_info, dict):
        return SchemaInfo(package_root=package_root, version=dist.version, source="installed")

    requested = vcs_info.get("requested_revision")
    if requested and requested != DEFAULT_BRANCH:
        raise SchemaUnavailable(
            f"Light Mode is pinned to remote {DEFAULT_BRANCH}; found installed revision {requested!r}."
        )

    commit = vcs_info.get("commit_id")
    version = commit if isinstance(commit, str) and commit else dist.version
    return SchemaInfo(package_root=package_root, version=version, source="remote-develop")


def ensure_schema_ready() -> SchemaInfo:
    """Validate that the installed schema package is available."""
    return _schema_info_from_install()


def current_schema_info() -> SchemaInfo:
    """Return current installed schema metadata."""
    return _schema_info_from_install()


def update_schema() -> SchemaInfo:
    """
    Upgrade to the latest develop branch package using pip.
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
    List importable modules under an installed package without filesystem checkout.
    """
    try:
        pkg = importlib.import_module(base_package)
    except Exception:
        return []

    modules: set[str] = {base_package}
    pkg_paths = getattr(pkg, "__path__", None)
    if not pkg_paths:
        return sorted(modules)

    prefix = f"{base_package}."
    for mod in pkgutil.walk_packages(pkg_paths, prefix=prefix):
        modules.add(mod.name)
    return sorted(modules)

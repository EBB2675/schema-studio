from pathlib import Path
from urllib.parse import urlparse
import os
import re

# Where to keep a bare clone + worktrees
DATA_DIR = Path(os.getenv("SCHEMA_UML_DATA_DIR", Path(__file__).resolve().parent / "_data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Local path or remote URL to the primary schema repository
SCHEMA_REPO = (
    os.getenv("SCHEMA_UML_REPO")
    or os.getenv("NOMAD_SIM_REPO")
    or os.getenv("GIT_REPO_DIR")
    or str(Path.home() / "src/nomad-simulations")
)

# Optional secondary repositories keyed by namespace prefix
MEASURE_REPO = os.getenv("NOMAD_MEASURE_REPO") or str(Path.home() / "src/nomad-measurements")
BAM_MASTERDATA_REPO = os.getenv("BAM_MASTERDATA_REPO")


def _repo_slug(src: str) -> str:
    """Return a filesystem-friendly slug for the bare mirror."""

    path = urlparse(src).path or src
    name = Path(path).name or "schema-repo"
    if name.endswith(".git"):
        name = name[:-4]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name or "schema-repo"


REPO_SLUG = _repo_slug(SCHEMA_REPO)

# Default base package/section can be overridden per request or via env vars
DEFAULT_BASE_PACKAGE = os.getenv(
    "SCHEMA_UML_BASE_PACKAGE",
    "nomad_simulations.schema_packages",
)


def _primary_base_package(base_packages: str) -> str:
    """Return the first non-empty base package from a comma-separated list."""

    for chunk in base_packages.split(","):
        candidate = chunk.strip()
        if candidate:
            return candidate
    return "nomad_simulations.schema_packages"


def _default_package_for_base(base_package: str) -> str:
    """Return a sensible default module for a base namespace."""

    base = base_package.strip()
    if base.startswith("bam_masterdata.datamodel"):
        return "bam_masterdata.datamodel.object_types"
    if base.startswith("bam_masterdata"):
        return f"{base}.object_types"
    return f"{base}.model_method"


DEFAULT_PACKAGE = os.getenv(
    "SCHEMA_UML_PACKAGE",
    _default_package_for_base(_primary_base_package(DEFAULT_BASE_PACKAGE)),
)

# Default branch for git operations
DEFAULT_BRANCH = os.getenv("SCHEMA_UML_BRANCH", "develop")

EXTRACTOR_ENTRY = os.getenv("SCHEMA_UML_EXTRACTOR", "extractor.graph_builder:build_graph")

# Mongo configuration
MONGO_URI = os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml")


def _parse_repo_map(raw: str | None) -> list[tuple[str, str]]:
    """
    Parse SCHEMA_UML_REPO_MAP entries in the form:
    "ns.prefix=/path/or/url,other.prefix=/path/or/url"
    """

    if not raw:
        return []

    pairs: list[tuple[str, str]] = []
    for item in raw.split(","):
        chunk = item.strip()
        if not chunk or "=" not in chunk:
            continue
        prefix, repo = chunk.split("=", 1)
        prefix = prefix.strip()
        repo = repo.strip()
        if prefix and repo:
            pairs.append((prefix, repo))
    # Longest-prefix first so specific namespaces override broader ones.
    pairs.sort(key=lambda p: len(p[0]), reverse=True)
    return pairs


_NAMESPACE_REPO_DEFAULTS: list[tuple[str, str]] = [("nomad_measurements", MEASURE_REPO)]
if BAM_MASTERDATA_REPO:
    _NAMESPACE_REPO_DEFAULTS.append(("bam_masterdata", BAM_MASTERDATA_REPO))
_NAMESPACE_REPO_DEFAULTS = [(ns, repo) for ns, repo in _NAMESPACE_REPO_DEFAULTS if repo]
_NAMESPACE_REPO_DEFAULTS.sort(key=lambda p: len(p[0]), reverse=True)

# TODO(plugin): replace env-based mapping with a first-class plugin manifest.
_NAMESPACE_REPO_OVERRIDES = _parse_repo_map(os.getenv("SCHEMA_UML_REPO_MAP"))


def repo_for_base_namespace(base_package: str) -> str:
    """Return the repository source that owns the given base namespace."""

    base = (base_package or "").strip()

    for ns_prefix, repo in _NAMESPACE_REPO_OVERRIDES:
        if base == ns_prefix or base.startswith(f"{ns_prefix}."):
            return repo

    for ns_prefix, repo in _NAMESPACE_REPO_DEFAULTS:
        if base == ns_prefix or base.startswith(f"{ns_prefix}."):
            return repo

    return SCHEMA_REPO

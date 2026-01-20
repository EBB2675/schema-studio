from pathlib import Path
from urllib.parse import urlparse
import os
import re

# Where to keep a bare clone + worktrees
DATA_DIR = Path(os.getenv("SCHEMA_UML_DATA_DIR", Path(__file__).resolve().parent / "_data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Local path or remote URL to the schema repository (supports NOMAD-compatible schemas)
SCHEMA_REPO = (
    os.getenv("SCHEMA_UML_REPO")
    or os.getenv("NOMAD_SIM_REPO")
    or os.getenv("GIT_REPO_DIR")
    or str(Path.home() / "src/nomad-simulations")
)

# Optional: secondary repo for nomad-measurements
MEASURE_REPO = os.getenv("NOMAD_MEASURE_REPO") or str(Path.home() / "src/nomad-measurements")


def _repo_slug(src: str) -> str:
    """Return a filesystem-friendly slug for the bare mirror."""

    path = urlparse(src).path or src
    name = Path(path).name or "schema-repo"
    if name.endswith(".git"):
        name = name[:-4]
    # Keep alnum + separators stable
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name or "schema-repo"


REPO_SLUG = _repo_slug(SCHEMA_REPO)

# Default base package/section can be overridden per request or via env vars
DEFAULT_BASE_PACKAGE = os.getenv(
    "SCHEMA_UML_BASE_PACKAGE",
    # Default to the simulations schema; opt into nomad-measurements via env var
    "nomad_simulations.schema_packages",
)


def _primary_base_package(base_packages: str) -> str:
    """Return the first non-empty base package from a comma-separated list."""

    for chunk in base_packages.split(","):
        candidate = chunk.strip()
        if candidate:
            return candidate
    return "nomad_simulations.schema_packages"


DEFAULT_PACKAGE = os.getenv(
    "SCHEMA_UML_PACKAGE", f"{_primary_base_package(DEFAULT_BASE_PACKAGE)}.model_method"
)

# Default branch for git operations
DEFAULT_BRANCH = os.getenv("SCHEMA_UML_BRANCH", "develop")

EXTRACTOR_ENTRY = os.getenv("SCHEMA_UML_EXTRACTOR", "extractor.graph_builder:build_graph")

# Storage backend toggles
DB_BACKEND = os.getenv("SCHEMA_UML_STORAGE", "sqlite").lower()
MONGO_URI = os.getenv("SCHEMA_UML_MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.getenv("SCHEMA_UML_MONGO_DB", "schema_uml")


def repo_for_base_namespace(base_package: str) -> str:
    """Return the repository source that owns the given base namespace."""

    base = base_package.strip()
    if base.startswith("nomad_measurements"):
        return MEASURE_REPO
    return SCHEMA_REPO

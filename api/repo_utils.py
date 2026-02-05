"""
Helpers for selecting the correct repository/paths for schema operations.
"""
from __future__ import annotations

from pathlib import Path
from typing import List

from .settings import DEFAULT_BASE_PACKAGE, repo_for_base_namespace


def python_root(wt: Path) -> Path:
    """
    Return the directory under which Python packages live in the worktree.

    In many NOMAD schemas this is typically <worktree>/src.
    If that does not exist, fall back to the worktree root.
    """
    src = wt / "src"
    return src if src.exists() else wt


def list_modules_under(root: Path, base_package: str) -> List[str]:
    """
    List all importable Python modules under the given base package.

    Example:
        root         = /.../worktrees/develop/src
        base_package = "nomad_simulations.schema_packages"
        → finds modules like:
          "nomad_simulations.schema_packages.model_method",
          "nomad_simulations.schema_packages.workflow.general", ...
    """
    parts = base_package.split(".")
    pkg_dir = root.joinpath(*parts)
    if not pkg_dir.exists():
        return []

    modules: set[str] = set()

    for path in pkg_dir.rglob("*.py"):
        # Compute module name relative to python root (src or repo root)
        rel = path.relative_to(root)

        # Strip .py suffix and convert path to dotted module path
        rel_no_ext = rel.with_suffix("")
        mod_name = ".".join(rel_no_ext.parts)

        modules.add(mod_name)

    return sorted(modules)


def parse_base_packages(raw: str) -> list[str]:
    """Normalize a comma-separated list of base packages."""

    return [chunk.strip() for chunk in raw.split(",") if chunk.strip()]


def bases_by_repo(base_packages: list[str]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    for base in base_packages:
        repo = repo_for_base_namespace(base)
        mapping.setdefault(repo, []).append(base)
    return mapping


def primary_repo(package: str | None, base_namespace: str | None) -> str:
    """
    Decide which repo should be used for a given package/base namespace.

    Mirrors the previous logic embedded in routes_git.
    """
    if base_namespace:
        bases = parse_base_packages(base_namespace)
        if bases:
            return repo_for_base_namespace(bases[0])
    if package:
        # Use the top-level namespace to infer the owning repository
        prefix = package.split(".")
        for i in range(len(prefix), 0, -1):
            candidate = ".".join(prefix[:i])
            if candidate.startswith("nomad_measurements"):
                return repo_for_base_namespace(candidate)
        return repo_for_base_namespace(package)

    defaults = parse_base_packages(DEFAULT_BASE_PACKAGE)
    if defaults:
        return repo_for_base_namespace(defaults[0])
    return repo_for_base_namespace(DEFAULT_BASE_PACKAGE)


__all__ = [
    "python_root",
    "list_modules_under",
    "parse_base_packages",
    "bases_by_repo",
    "primary_repo",
    "DEFAULT_BASE_PACKAGE",
]

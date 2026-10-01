from __future__ import annotations
from pathlib import Path
from typing import Dict, Any

from .repo_utils import python_root
from .settings import EXTRACTOR_ENTRY
from .sources.legacy import build_graph


def build_graph_in_subprocess(
    worktree: Path,
    package: str,
    extractor: str | None = None,
    *,
    sha: str | None = None,
    **kwargs
) -> Dict[str, Any]:
    """
    Build a graph from a git worktree.

    The extraction runs with the interpreter of the matching profile
    environment, never with the app's own. The worktree's source folder is
    handed to the script, which puts it first on its import path, so the schema
    comes from the worktree and its dependencies from the environment.
    `sha` is the worktree's commit; with it the result can be cached.
    """
    try:
        return build_graph(
            package,
            extractor=extractor or EXTRACTOR_ENTRY,
            source_root=python_root(worktree),
            source_version=sha,
            **kwargs,
        )
    except (ImportError, RuntimeError) as exc:
        raise RuntimeError(f"Extractor failed for package '{package}': {exc}") from exc

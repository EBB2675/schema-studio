from __future__ import annotations
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Dict, Any

from .git_utils import materialize_worktree
from .repo_utils import primary_repo, python_root
from .settings import EXTRACTOR_ENTRY
from .sources import editing
from .sources.extraction import build_graph


def branch_source(branch: str, package: str, base_namespace: str | None) -> editing.Source:
    """The git worktree of a branch, to read the module's schema from."""
    worktree, sha = materialize_worktree(branch, primary_repo(package, base_namespace))
    return editing.Source(root=python_root(worktree), sha=sha)


def build_graph_in_subprocess(
    worktree: Path,
    package: str,
    extractor: str | None = None,
    *,
    sha: str | None = None,
    edits: Sequence[Mapping[str, Any]] | None = None,
    **kwargs
) -> Dict[str, Any]:
    """
    Build a graph from a git worktree.

    The extraction runs with the interpreter of the matching profile
    environment, never with the app's own. The worktree's source folder is
    handed to the script, which puts it first on its import path, so the schema
    comes from the worktree and its dependencies from the environment.
    `sha` is the worktree's commit; with it the result can be cached.
    With `edits` (the user's stored edits) they are replayed onto the
    worktree's schema, as for the installed one; without, the graph is the
    branch as it is (branch comparison).
    """
    try:
        if edits is not None:
            return editing.build_graph(
                package, edits, source=editing.Source(root=python_root(worktree), sha=sha),
                extractor=extractor or EXTRACTOR_ENTRY, **kwargs,
            )
        return build_graph(
            package,
            extractor=extractor or EXTRACTOR_ENTRY,
            source_root=python_root(worktree),
            source_version=sha,
            **kwargs,
        )
    except (ImportError, RuntimeError) as exc:
        raise RuntimeError(f"Extractor failed for package '{package}': {exc}") from exc

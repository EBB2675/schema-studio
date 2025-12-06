from __future__ import annotations
from pathlib import Path
from typing import List, Tuple
import os
import shutil

from git import Repo, GitCommandError

from .settings import DATA_DIR, SCHEMA_REPO, _repo_slug

def _bare_dir(src: str) -> Path:
    return Path(DATA_DIR) / f"{_repo_slug(src)}.bare"


def _wt_dir(src: str) -> Path:
    root = Path(DATA_DIR) / "worktrees" / _repo_slug(src)
    root.mkdir(parents=True, exist_ok=True)
    return root

def ensure_bare(src: str = SCHEMA_REPO) -> Repo:
    """Make sure we have a bare mirror of the repo with all branches fetched."""
    bare_dir = _bare_dir(src)

    if not Path(src, ".git").exists() and not (Path(src).is_dir() and (Path(src) / "HEAD").exists()):
        raise RuntimeError("Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / NOMAD_MEASURE_REPO / GIT_REPO_DIR to a git repository")

    if bare_dir.exists():
        repo = Repo(str(bare_dir))
        try:
            repo.git.fetch("--all", "--prune")
        except Exception as e:
            print("DEBUG: fetch failed, recreating bare repo:", e)
            shutil.rmtree(bare_dir)
            repo = Repo.clone_from(src, str(bare_dir), bare=True)
        return repo

    # First-time clone
    print(f"DEBUG: Cloning bare mirror from {src} → {bare_dir}")
    repo = Repo.clone_from(src, str(bare_dir), bare=True)
    repo.git.fetch("--all", "--prune")
    return repo


def list_branches(src: str = SCHEMA_REPO) -> List[str]:
    """Return all local + remote branches available in the mirrored repo."""
    repo = ensure_bare(src)
    names = set()

    # include local branches
    for head in repo.heads:
        names.add(head.name)

    # include remote branches
    try:
        for ref in repo.remotes.origin.refs:
            name = ref.name.replace("origin/", "")
            names.add(name)
    except Exception as e:
        print("DEBUG: could not read remote refs:", e)

    if os.getenv("SCHEMA_UML_DEBUG_BRANCHES", "").lower() in {"1", "true", "yes"}:
        print("DEBUG: branches seen by backend:", sorted(names))
    return sorted(names)

def materialize_worktree(branch: str, src: str = SCHEMA_REPO) -> Tuple[Path, str]:
    """
    Create or update a worktree for the given branch.
    Works both for local branches and bare mirrors without remotes.
    """
    repo = ensure_bare(src)

    # make sure refs exist locally
    try:
        repo.git.fetch("--all", "--prune")
    except Exception as e:
        print("DEBUG: fetch skipped/failed:", e)

    # try to resolve branch name
    try:
        head = repo.git.rev_parse(branch)
    except Exception:
        try:
            # try prefixed with origin/
            head = repo.git.rev_parse(f"origin/{branch}")
        except Exception as e:
            raise RuntimeError(f"Branch '{branch}' not found in bare repo ({repo.git_dir}): {e}")

    wt_root = _wt_dir(src)
    wt = wt_root / branch.replace("/", "__")

    # recreate if stale
    if wt.exists():
        marker = wt / ".head"
        if marker.exists() and marker.read_text().strip() == head:
            return wt, head
        shutil.rmtree(wt)

    wt.mkdir(parents=True, exist_ok=True)

    # add worktree from the correct ref
    repo.git.worktree("add", "--force", str(wt), head)
    (wt / ".head").write_text(head)
    return wt, head

from __future__ import annotations
from pathlib import Path
from typing import List, Tuple
import shutil
from git import Repo, GitCommandError
from .settings import DATA_DIR, SCHEMA_REPO, REPO_SLUG

BARE_DIR = Path(DATA_DIR) / f"{REPO_SLUG}.bare"
WT_DIR   = Path(DATA_DIR) / "worktrees"
WT_DIR.mkdir(parents=True, exist_ok=True)

def ensure_bare() -> Repo:
    """Make sure we have a bare mirror of the repo with all branches fetched."""
    src = SCHEMA_REPO
    if not Path(src, ".git").exists() and not (Path(src).is_dir() and (Path(src) / "HEAD").exists()):
        raise RuntimeError("Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / GIT_REPO_DIR to a git repository")

    if BARE_DIR.exists():
        repo = Repo(str(BARE_DIR))
        try:
            repo.git.fetch("--all", "--prune")
        except Exception as e:
            print("DEBUG: fetch failed, recreating bare repo:", e)
            shutil.rmtree(BARE_DIR)
            repo = Repo.clone_from(src, str(BARE_DIR), bare=True)
        return repo

    # First-time clone
    print(f"DEBUG: Cloning bare mirror from {src} → {BARE_DIR}")
    repo = Repo.clone_from(src, str(BARE_DIR), bare=True)
    repo.git.fetch("--all", "--prune")
    return repo


def list_branches() -> List[str]:
    """Return all local + remote branches available in the mirrored repo."""
    repo = ensure_bare()
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

    print("DEBUG: branches seen by backend:", sorted(names))
    return sorted(names)

def materialize_worktree(branch: str) -> Tuple[Path, str]:
    """
    Create or update a worktree for the given branch.
    Works both for local branches and bare mirrors without remotes.
    """
    repo = ensure_bare()

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

    wt = WT_DIR / branch.replace("/", "__")

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

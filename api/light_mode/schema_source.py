"""Schema sourcing for Light Mode.

- Ships with a bundled bare repo snapshot (pinned).
- On first use, copies that bare repo to the user config dir and materializes a worktree.
- Exposes current schema version and supports explicit update from upstream develop.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

from git import Repo, GitCommandError
from platformdirs import user_config_dir

from api.repo_utils import python_root

DEFAULT_APP_NAME = "schema_studio_light"


def _config_root() -> Path:
    env_root = os.getenv("SCHEMA_STUDIO_HOME")
    if env_root:
        return Path(env_root)
    try:
        root = Path(user_config_dir(DEFAULT_APP_NAME))
        root.mkdir(parents=True, exist_ok=True)
        return root
    except Exception:
        root = Path.cwd() / ".schema_studio_light"
        root.mkdir(parents=True, exist_ok=True)
        return root


def _schema_dir() -> Path:
    return _config_root() / "schema_base"


SCHEMA_DIR = _schema_dir()
BUNDLED_BARE = Path(__file__).resolve().parent.parent / "_data" / "nomad-simulations.bare"
VERSION_FILE = SCHEMA_DIR / "version.json"
PINNED_REF = os.getenv("SCHEMA_STUDIO_PINNED_REF")  # optional override
UPSTREAM_REPO = os.getenv("SCHEMA_UML_REPO") or None
DEFAULT_BRANCH = os.getenv("SCHEMA_STUDIO_DEFAULT_BRANCH", "develop")


@dataclass
class SchemaInfo:
    worktree: Path
    python_path: Path
    version: str
    source: str  # "pinned" | "updated"


class SchemaUnavailable(RuntimeError):
    pass


def _ensure_dirs(schema_dir: Path) -> None:
    schema_dir.mkdir(parents=True, exist_ok=True)


def _copy_bundled_bare(target: Path) -> Path:
    if target.exists():
        return target
    if not BUNDLED_BARE.exists():
        raise SchemaUnavailable("Bundled schema snapshot not found")
    shutil.copytree(BUNDLED_BARE, target)
    # clear worktrees to shrink size
    wt_dir = target / "worktrees"
    if wt_dir.exists():
        shutil.rmtree(wt_dir, ignore_errors=True)
    return target


def _pinned_commit(bare_repo: Repo) -> str:
    if PINNED_REF:
        try:
            return bare_repo.git.rev_parse(PINNED_REF)
        except Exception as exc:
            raise SchemaUnavailable(f"Pinned ref {PINNED_REF} missing in bundled repo: {exc}")
    # fallback to HEAD of bundled bare
    return bare_repo.head.commit.hexsha


def _write_version(schema_dir: Path, version: str, source: str) -> None:
    vf = schema_dir / "version.json"
    vf.parent.mkdir(parents=True, exist_ok=True)
    vf.write_text(json.dumps({"version": version, "source": source}, indent=2))


def _read_version(schema_dir: Path) -> Tuple[str | None, str | None]:
    vf = schema_dir / "version.json"
    if not vf.exists():
        return None, None
    try:
        data = json.loads(vf.read_text())
        return data.get("version"), data.get("source")
    except Exception:
        return None, None


def _materialize_worktree(bare_repo: Repo, ref: str, dest: Path) -> Path:
    if dest.exists():
        # if existing worktree matches ref, keep
        head_file = dest / ".head"
        if head_file.exists():
            current = head_file.read_text().strip()
            if current == ref:
                return dest
        shutil.rmtree(dest, ignore_errors=True)
    bare_repo.git.worktree("add", "--force", str(dest), ref)
    (dest / ".head").write_text(ref)
    return dest


def _reset_if_invalid(path: Path) -> None:
    if not path.exists():
        return
    try:
        Repo(str(path))
    except Exception:
        shutil.rmtree(path, ignore_errors=True)


def ensure_schema_ready() -> SchemaInfo:
    """Prepare local schema worktree from bundled snapshot; returns paths + version."""
    schema_dir = _schema_dir()
    _ensure_dirs(schema_dir)
    bare_dst = schema_dir / "nomad-simulations.bare"
    _reset_if_invalid(bare_dst)
    _copy_bundled_bare(bare_dst)
    repo = Repo(str(bare_dst))
    pinned = _pinned_commit(repo)
    worktree = _materialize_worktree(repo, pinned, schema_dir / "worktree")
    py_root = python_root(worktree)
    if str(py_root) not in sys.path:
        sys.path.insert(0, str(py_root))
    _write_version(schema_dir, pinned, "pinned")
    return SchemaInfo(worktree=worktree, python_path=py_root, version=pinned, source="pinned")


def current_schema_info() -> SchemaInfo:
    """Return current schema info, ensuring availability."""
    schema_dir = _schema_dir()
    _ensure_dirs(schema_dir)
    bare_dst = schema_dir / "nomad-simulations.bare"
    _reset_if_invalid(bare_dst)
    if not bare_dst.exists():
        return ensure_schema_ready()
    try:
        repo = Repo(str(bare_dst))
    except Exception:
        return ensure_schema_ready()
    version, source = _read_version(schema_dir)
    if not version:
        version = repo.head.commit.hexsha
        source = "pinned"
        _write_version(schema_dir, version, source)
    worktree = schema_dir / "worktree"
    if not worktree.exists():
        worktree = _materialize_worktree(repo, version, worktree)
    py_root = python_root(worktree)
    if str(py_root) not in sys.path:
        sys.path.insert(0, str(py_root))
    return SchemaInfo(worktree=worktree, python_path=py_root, version=version, source=source or "pinned")


def update_schema() -> SchemaInfo:
    """Explicitly fetch latest develop and refresh worktree; keeps edits in SQLite."""
    schema_dir = _schema_dir()
    _ensure_dirs(schema_dir)
    bare_dst = schema_dir / "nomad-simulations.bare"
    _reset_if_invalid(bare_dst)
    _copy_bundled_bare(bare_dst)
    repo = Repo(str(bare_dst))
    try:
        if UPSTREAM_REPO:
            origin = repo.remotes.origin if repo.remotes else None
            if not origin:
                repo.create_remote("origin", UPSTREAM_REPO, fetch="+refs/heads/*:refs/heads/*")
                origin = repo.remotes.origin
            else:
                # ensure a fetch refspec exists; older GitPython lacks fetch_refspec attribute
                try:
                    with origin.config_writer as cw:
                        cw.set("fetch", "+refs/heads/*:refs/heads/*")
                except Exception:
                    pass
            origin.fetch("+refs/heads/*:refs/heads/*", prune=True)
        else:
            if not repo.remotes:
                raise SchemaUnavailable("No remote configured for updates; set SCHEMA_UML_REPO to enable updating.")
            repo.git.fetch("--all", "--prune")
    except GitCommandError as exc:
        raise SchemaUnavailable(f"Fetch failed: {exc}")
    except SchemaUnavailable:
        raise
    except Exception as exc:
        raise SchemaUnavailable(f"Update failed: {exc}")
    try:
        ref = repo.git.rev_parse(f"origin/{DEFAULT_BRANCH}")
    except Exception:
        try:
            ref = repo.git.rev_parse(DEFAULT_BRANCH)
        except Exception as exc:
            raise SchemaUnavailable(f"Develop branch not found: {exc}")
    worktree = _materialize_worktree(repo, ref, schema_dir / "worktree")
    py_root = python_root(worktree)
    if str(py_root) not in sys.path:
        sys.path.insert(0, str(py_root))
    _write_version(schema_dir, ref, "updated")
    return SchemaInfo(worktree=worktree, python_path=py_root, version=ref, source="updated")

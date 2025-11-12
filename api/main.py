from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import ORJSONResponse
from extractor.graph_builder import build_graph, list_sections
from fastapi.middleware.cors import CORSMiddleware
import os, subprocess, tempfile, shutil, ast
from pathlib import Path
from pydantic import BaseModel

from .routes_git import router as git_router

app = FastAPI(title="Schema UML API", default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(git_router)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/")
def root():
    return {"message": "Schema UML API is running"}

@app.get("/roots")
def roots(package: str = Query(...)):
    """List available section classes for a given package."""
    try:
        return {"package": package, "sections": sorted(list_sections(package))}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")

@app.get("/schema")
def schema(
    package: str = Query(...),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    allow_cross_module: bool = Query(True),                 
    base_namespace: str | None = Query(None),               
):
    data = build_graph(
        package=package,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        allow_cross_module=allow_cross_module,
        base_namespace=base_namespace
    )
    return data

def _repo_root() -> Path:
    root = os.environ.get("NOMAD_SIM_REPO") or os.environ.get("GIT_REPO_DIR")
    if not root:
        raise RuntimeError("Set NOMAD_SIM_REPO or GIT_REPO_DIR to a local clone of nomad-simulations")
    return Path(root).resolve()

def _run_git(repo: Path, *args: str) -> str:
    cp = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if cp.returncode != 0:
        raise subprocess.CalledProcessError(cp.returncode, cp.args, cp.stdout, cp.stderr)
    return cp.stdout

def _git_path_exists(repo: Path, branch: str, path: str) -> bool:
    # returns True if path exists at branch (dir tree or file)
    try:
        out = _run_git(repo, "ls-tree", "-d", "--name-only", branch, path).strip()
        if out:
            return True
        # if not a dir, check any file under it
        out2 = _run_git(repo, "ls-tree", "-r", "--name-only", branch, path).strip()
        return bool(out2)
    except subprocess.CalledProcessError:
        return False

def _resolve_base_tree(repo: Path, branch: str, base_path: str) -> str:
    """
    Try to find the tree path that contains the given base package.
    Tries:
      1) base_path
      2) src/base_path
      3) search the tree for */base_path/__init__.py and infer the prefix
    Returns a repository-relative path suitable for `git archive`.
    """
    candidates = [base_path, f"src/{base_path}"]
    for c in candidates:
        if _git_path_exists(repo, branch, c):
            return c

    # Fallback: search entire tree for any file under the base
    try:
        listing = _run_git(repo, "ls-tree", "-r", "--name-only", branch)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=404, detail=f"Branch not found: {branch}") from e

    target_suffix = f"{base_path}/__init__.py"
    prefix = None
    for line in listing.splitlines():
        if line.endswith(target_suffix):
            # line is like "src/nomad_simulations/schema_packages/__init__.py"
            prefix = line[: -len(target_suffix)].rstrip("/")
            break
    if prefix is not None:
        resolved = f"{prefix}/{base_path}" if prefix else base_path
        return resolved

    raise HTTPException(
        status_code=404,
        detail=f"Cannot locate {base_path} at {branch} (tried {base_path}, src/{base_path})"
    )

def _export_subtree(repo: Path, branch: str, rel_path: str, outdir: Path) -> None:
    archive = outdir / "tree.zip"
    subprocess.run(
        ["git", "-C", str(repo), "archive", branch, rel_path, "-o", str(archive)],
        check=True
    )
    shutil.unpack_archive(str(archive), str(outdir))

def _collect_classes_from_file(py_path: Path) -> list[str]:
    try:
        src = py_path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(src)
        return [n.name for n in tree.body if isinstance(n, ast.ClassDef)]
    except Exception:
        return []

class PackageClasses(BaseModel):
    package: str
    classes: list[str]

class OverviewOut(BaseModel):
    branch: str
    base: str
    items: list[PackageClasses]

@app.get("/overview", response_model=OverviewOut)
def overview(
    branch: str = Query("develop"),
    base: str = Query("nomad_simulations.schema_packages"),
):
    """
    Bird's-eye overview: packages under `base` and their top-level classes at `branch`.
    Resolves repo layout prefixes (e.g., src/).
    """
    try:
        repo = _repo_root()
        base_path = base.replace(".", "/")

        # resolve actual tree path (handles src/ layout)
        resolved_tree = _resolve_base_tree(repo, branch, base_path)

        with tempfile.TemporaryDirectory() as td_str:
            td = Path(td_str)
            try:
                _export_subtree(repo, branch, resolved_tree, td)
            except subprocess.CalledProcessError as e:
                raise HTTPException(status_code=404, detail=f"Cannot export {resolved_tree} at {branch}") from e

            # the extracted folder root is td / <resolved_tree>
            extract_root = td / resolved_tree
            if not extract_root.exists():
                raise HTTPException(status_code=404, detail=f"Extracted path missing: {resolved_tree}")

            items: list[PackageClasses] = []
            for dirpath, dirnames, filenames in os.walk(extract_root):
                pkg_dir = Path(dirpath)
                if "__init__.py" not in filenames:
                    continue

                # rel path from the resolved tree root
                rel_from_resolved = pkg_dir.relative_to(extract_root)
                # Build full dotted package name: base + (optional tail)
                tail = str(rel_from_resolved).replace("/", ".")
                package_name = base if tail in ("", ".") else f"{base}.{tail}"

                cls_names: set[str] = set()
                for f in filenames:
                    if f.endswith(".py"):
                        cls_names.update(_collect_classes_from_file(pkg_dir / f))

                items.append(PackageClasses(package=package_name, classes=sorted(cls_names)))

            items.sort(key=lambda x: x.package)
            return OverviewOut(branch=branch, base=base, items=items)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")
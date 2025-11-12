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
        # only top-level classes
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
    Return packages under `base` and top-level classes in each package, at `branch`.
    """
    try:
        repo = _repo_root()
        base_path = base.replace(".", "/")
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            try:
                _export_subtree(repo, branch, base_path, td)
            except subprocess.CalledProcessError as e:
                raise HTTPException(status_code=404, detail=f"Cannot export {base} at {branch}") from e

            root_dir = td / base_path
            if not root_dir.exists():
                raise HTTPException(status_code=404, detail=f"{base} not found at {branch}")

            items: list[PackageClasses] = []
            for dirpath, dirnames, filenames in os.walk(root_dir):
                pkg_dir = Path(dirpath)
                if "__init__.py" not in filenames:
                    continue
                rel = pkg_dir.relative_to(td)
                package_name = str(rel).replace("/", ".")
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
from typing import List, Optional

from fastapi import Depends, FastAPI, Query, HTTPException
from fastapi.responses import ORJSONResponse
from extractor.graph_builder import build_graph, list_sections
from fastapi.middleware.cors import CORSMiddleware
import os, subprocess, tempfile, shutil, ast
from pathlib import Path
from pydantic import BaseModel

from .routes_git import router as git_router
from extractor.usage_index import UsageEntry, get_usage_for_section
from .settings import SCHEMA_REPO, DEFAULT_BASE_PACKAGE, DEFAULT_BRANCH, repo_for_base_namespace
from .auth import (
    authenticate_user,
    create_access_token,
    get_user_and_workspace,
    get_workspace,
    init_db,
    update_workspace,
    workspace_payload,
)

# Keep this list in sync with `web/src/components/quantityShared.ts`.
SUPPORTED_CUSTOM_DTYPES = {
    # Booleans / strings / datetime
    "bool",
    "str",
    "datetime",
    # Generic numbers
    "int",
    "float",
    # NumPy-style integers
    "int32",
    "int64",
    "np.int32",
    "np.int64",
    # NumPy-style floats
    "float32",
    "float64",
    "np.float32",
    "np.float64",
}

init_db()


class LoginRequest(BaseModel):
    username: str
    password: str


class WorkspaceUpdate(BaseModel):
    branch: str | None = None
    package: str | None = None
    base_namespace: str | None = None



app = FastAPI(title="Schema UML API", default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def _startup() -> None:
    init_db()


app.include_router(git_router)


@app.post("/auth/login")
def login(req: LoginRequest):
    user = authenticate_user(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user)
    workspace = workspace_payload(get_workspace(user["id"]))
    return {"access_token": token, "token_type": "bearer", "workspace": workspace, "user": {"username": user["username"]}}


@app.get("/workspace")
def read_workspace(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"workspace": workspace_payload(workspace)}


@app.put("/workspace")
def update_workspace_route(req: WorkspaceUpdate, user_ws=Depends(get_user_and_workspace)):
    user, workspace = user_ws
    updated = update_workspace(
        user["id"],
        branch=req.branch or workspace.get("branch"),
        package=req.package or workspace.get("package"),
        base_namespace=req.base_namespace or workspace.get("base_namespace"),
    )
    return {"workspace": workspace_payload(updated)}


@app.get("/health")
def health(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"ok": True, "workspace": workspace_payload(workspace)}

@app.get("/")
def root(user_ws=Depends(get_user_and_workspace)):
    _, workspace = user_ws
    return {"message": "Schema UML API is running", "workspace": workspace_payload(workspace)}

@app.get("/roots")
def roots(package: str | None = Query(None), user_ws=Depends(get_user_and_workspace)):
    """List available section classes for a given package."""
    _, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    try:
        return {"package": pkg, "sections": sorted(list_sections(pkg)), "workspace": workspace_payload(workspace)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")

@app.get("/schema")
def schema(
    package: str | None = Query(None),
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
):
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    ns = base_namespace or workspace.get("base_namespace")
    if package or base_namespace:
        workspace = update_workspace(user["id"], package=pkg, base_namespace=ns)
    data = build_graph(
        package=pkg,
        root=root,
        include_quantities=include_quantities,
        include_subsections=include_subsections,
        allow_cross_module=allow_cross_module,
        base_namespace=ns
    )
    data["workspace"] = workspace_payload(workspace)
    return data


def _repo_root(base_package: str | None = None) -> Path:
    if base_package:
        repo_src = repo_for_base_namespace(base_package)
    else:
        repo_src = SCHEMA_REPO

    if not repo_src:
        raise RuntimeError(
            "Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / NOMAD_MEASURE_REPO / GIT_REPO_DIR to a local schema clone"
        )

    repo_path = Path(repo_src).expanduser().resolve()
    if not (repo_path / ".git").exists():
        raise RuntimeError(
            "Set SCHEMA_UML_REPO / NOMAD_SIM_REPO / NOMAD_MEASURE_REPO / GIT_REPO_DIR to a local schema clone"
        )
    return repo_path

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


def _parse_base_packages(raw: str) -> list[str]:
    """Normalize a comma-separated list of base packages."""

    return [chunk.strip() for chunk in raw.split(",") if chunk.strip()]


class PackageClasses(BaseModel):
    package: str
    classes: list[str]

class OverviewOut(BaseModel):
    branch: str
    base: str
    items: list[PackageClasses]


class OverviewResponse(BaseModel):
    workspace: dict
    branch: str
    base: str
    items: list[PackageClasses]


class CustomQuantityRequest(BaseModel):
    package: str
    class_name: str
    quantity_name: str
    dtype: str
    docstring: str | None = None


def _attach_custom_quantity(graph: dict, req: CustomQuantityRequest) -> dict:
    """
    Inject a synthetic quantity node and edge into the graph without rebuilding it.
    Performs validation to ensure the target section exists and no duplicate
    quantities are added.
    """
    if req.dtype not in SUPPORTED_CUSTOM_DTYPES:
        allowed = ", ".join(sorted(SUPPORTED_CUSTOM_DTYPES))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dtype '{req.dtype}'. Supported: {allowed}",
        )

    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    target_section = None
    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("label") != req.class_name:
            continue
        module = node.get("module") or ""
        if module.startswith(req.package):
            target_section = node
            break

    if target_section is None:
        raise HTTPException(
            status_code=404,
            detail=f"Section '{req.class_name}' not found in package '{req.package}'",
        )

    section_id = target_section["id"]
    for node in nodes:
        if node.get("kind") == "quantity" and node.get("owner") == section_id:
            if node.get("label") == req.quantity_name:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Quantity '{req.quantity_name}' already exists on section "
                        f"'{req.class_name}'"
                    ),
                )

    qid = f"{section_id}.{req.quantity_name}"
    new_node = {
        "id": qid,
        "kind": "quantity",
        "label": req.quantity_name,
        "doc": req.docstring or None,
        "dtype": req.dtype,
        "owner": section_id,
        "module": target_section.get("module"),
    }
    nodes = nodes + [new_node]
    edges = edges + [
        {"source": section_id, "target": qid, "type": "hasQuantity", "card": None}
    ]

    graph = dict(graph)
    graph["nodes"] = nodes
    graph["edges"] = edges
    return graph


@app.post("/schema/custom-quantity")
def add_custom_quantity(
    req: CustomQuantityRequest,
    root: str | None = Query(None),
    include_subsections: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
):
    user, workspace = user_ws
    ns = base_namespace
    if ns is None and workspace.get("package") == req.package:
        ns = workspace.get("base_namespace")
    workspace = update_workspace(
        user["id"],
        package=req.package,
        base_namespace=ns or workspace.get("base_namespace"),
    )
    try:
        graph = build_graph(
            package=req.package,
            root=root,
            include_quantities=True,
            include_subsections=include_subsections,
            allow_cross_module=allow_cross_module,
            base_namespace=ns
        )
        result = _attach_custom_quantity(graph, req)
        result["workspace"] = workspace_payload(workspace)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")

@app.get("/overview", response_model=OverviewResponse)
def overview(
    branch: str | None = Query(None),
    base: str | None = Query(None),
    user_ws=Depends(get_user_and_workspace),
):
    """
    Bird's-eye overview: packages under `base` and their top-level classes at `branch`.
    Resolves repo layout prefixes (e.g., src/).
    """
    try:
        user, workspace = user_ws
        branch_to_use = branch or workspace.get("branch") or DEFAULT_BRANCH
        base_to_use = base or workspace.get("base_namespace") or DEFAULT_BASE_PACKAGE
        if branch or base:
            workspace = update_workspace(user["id"], branch=branch_to_use, base_namespace=base_to_use)

        base_packages = _parse_base_packages(base_to_use)
        if not base_packages:
            raise HTTPException(status_code=400, detail="Provide at least one base package")

        modules: dict[str, set[str]] = {}

        for base_pkg in base_packages:
            repo = _repo_root(base_pkg)
            base_path = base_pkg.replace(".", "/")

            # resolve actual tree path (handles src/ layout)
            resolved_tree = _resolve_base_tree(repo, branch_to_use, base_path)

            with tempfile.TemporaryDirectory() as td_str:
                td = Path(td_str)
                try:
                    _export_subtree(repo, branch_to_use, resolved_tree, td)
                except subprocess.CalledProcessError as e:
                    raise HTTPException(status_code=404, detail=f"Cannot export {resolved_tree} at {branch_to_use}") from e

                # the extracted folder root is td / <resolved_tree>
                extract_root = td / resolved_tree
                if not extract_root.exists():
                    raise HTTPException(status_code=404, detail=f"Extracted path missing: {resolved_tree}")

                for dirpath, dirnames, filenames in os.walk(extract_root):
                    pkg_dir = Path(dirpath)
                    if "__init__.py" not in filenames:
                        continue

                    # rel path from the resolved tree root
                    rel_from_resolved = pkg_dir.relative_to(extract_root)
                    # Build full dotted package name: base + (optional tail)
                    tail = str(rel_from_resolved).replace("/", ".")
                    package_name = base_pkg if tail in ("", ".") else f"{base_pkg}.{tail}"

                    for f in filenames:
                        if not f.endswith(".py"):
                            continue

                        module_name = package_name
                        if f != "__init__.py":
                            module_name = f"{package_name}.{Path(f).stem}"

                        cls_names = _collect_classes_from_file(pkg_dir / f)
                        if not cls_names:
                            continue

                        if module_name not in modules:
                            modules[module_name] = set()
                        modules[module_name].update(cls_names)

        items = [
            PackageClasses(package=module, classes=sorted(classes))
            for module, classes in sorted(modules.items())
        ]

        return OverviewResponse(
            workspace=workspace_payload(workspace),
            branch=branch_to_use,
            base=",".join(base_packages),
            items=items,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")
    

class UsageEntryModel(BaseModel):
    kind: str
    qualname: str
    module: str
    short_name: str
    doc: Optional[str]


class UsageResponse(BaseModel):
    workspace: dict
    usage: List[UsageEntryModel]

@app.get("/usage", response_model=UsageResponse)
def get_usage(
    section_id: str = Query(..., description="Fully qualified section class name"),
    user_ws=Depends(get_user_and_workspace),
):
    """
    Return "under the hood" usage information for a given section class.

    section_id should be the same as the node id for class nodes,
    e.g. "nomad_simulations.schema_packages.model_method.ModelMethod".
    """
    _, workspace = user_ws
    entries = get_usage_for_section(section_id)
    usage = [
        UsageEntryModel(
            kind=e.kind,
            qualname=e.qualname,
            module=e.module,
            short_name=e.short_name,
            doc=e.doc,
        )
        for e in entries
    ]
    return {"usage": usage, "workspace": workspace_payload(workspace)}

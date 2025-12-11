from typing import List, Optional, Literal

from fastapi import Depends, FastAPI, Query, HTTPException
from fastapi.responses import ORJSONResponse
from extractor.graph_builder import build_graph, list_sections, _root_namespace
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
from .edit_store import (
    EditConflict,
    PersistedEdit,
    init_db as init_edit_store,
    list_edits,
    save_edit,
    split_conflicts,
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
init_edit_store()


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
    init_edit_store()


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
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False, description="Return an empty graph shell (replay persisted edits only)"),
    user_ws=Depends(get_user_and_workspace),
):
    user, workspace = user_ws
    pkg = package or workspace.get("package") or DEFAULT_BASE_PACKAGE
    ns = base_namespace or workspace.get("base_namespace")
    if base_namespace is None and package and not empty:
        ns = _root_namespace(pkg)
    if package or base_namespace:
        workspace = update_workspace(user["id"], package=pkg, base_namespace=ns)
    if empty:
        data = {"package": pkg, "root": root, "nodes": [], "edges": []}
    else:
        data = build_graph(
            package=pkg,
            root=root,
            include_quantities=include_quantities,
            include_subsections=include_subsections,
            include_inheritance=include_inheritance,
            allow_cross_module=allow_cross_module,
            base_namespace=ns
        )
    persisted, stale_conflicts, current_sha = _persisted_state(
        user_id=user["id"], workspace=workspace, package=pkg, base_namespace=ns
    )
    data, apply_conflicts = _apply_persisted_edits(data, persisted)
    data["workspace"] = workspace_payload(workspace)
    conflicts = stale_conflicts + apply_conflicts
    if conflicts:
        data["edit_conflicts"] = conflicts
        data["branch_head"] = current_sha
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


def _current_branch_head(branch: str | None, base_namespace: str | None) -> str | None:
    """Best-effort helper to read the branch head SHA for conflict tracking."""
    if not branch:
        return None
    try:
        repo = _repo_root(base_namespace)
        return _run_git(repo, "rev-parse", branch).strip()
    except Exception:
        # Fallback to None when git metadata is unavailable (e.g., synthetic packages).
        return None

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
    parent_name: str | None = None
    parent_relation: Literal["inherits", "hasSubSection"] | None = None

class CustomClassRequest(BaseModel):
    package: str
    name: str
    parent: str | None = None
    relation: Literal["inherits", "hasSubSection"] = "inherits"
    docstring: str | None = None


def _serialize_edit(edit: PersistedEdit) -> dict:
    return {
        "id": edit.id,
        "user_id": edit.user_id,
        "branch": edit.branch,
        "package": edit.package,
        "class_name": edit.class_name,
        "quantity_name": edit.quantity_name,
        "dtype": edit.dtype,
        "docstring": edit.docstring,
        "parent_name": edit.parent_name,
        "parent_relation": edit.parent_relation,
        "edit_type": edit.edit_type,
        "base_sha": edit.base_sha,
        "created_at": edit.created_at,
        "updated_at": edit.updated_at,
    }


def _apply_persisted_edits(graph: dict, edits: list[PersistedEdit]) -> tuple[dict, list[dict]]:
    """Replay persisted edits onto a graph; collect application-time conflicts."""

    conflicts: list[dict] = []
    sorted_edits = sorted(edits, key=lambda e: 0 if e.edit_type == "class" else 1)
    for edit in sorted_edits:
        try:
            if edit.edit_type == "class":
                graph = _attach_custom_class(
                    graph,
                    CustomClassRequest(
                        package=edit.package,
                        name=edit.class_name,
                        parent=edit.parent_name,
                        relation=edit.parent_relation or "inherits",
                        docstring=edit.docstring,
                    ),
                )
            else:
                graph = _attach_custom_quantity(
                    graph,
                    CustomQuantityRequest(
                        package=edit.package,
                        class_name=edit.class_name,
                        quantity_name=edit.quantity_name or "",
                        dtype=edit.dtype or "str",
                        docstring=edit.docstring,
                        parent_name=edit.parent_name,
                        parent_relation=edit.parent_relation,
                    ),
                )
        except HTTPException as exc:
            conflicts.append({"edit": _serialize_edit(edit), "reason": "validation_error", "detail": exc.detail})
    return graph, conflicts


def _persisted_state(
    *, user_id: int, workspace: dict, package: str, base_namespace: str | None
) -> tuple[list[PersistedEdit], list[dict], str | None]:
    branch = workspace.get("branch") or DEFAULT_BRANCH
    current_sha = _current_branch_head(branch, base_namespace)
    edits = list_edits(user_id, branch, package)
    applicable, stale = split_conflicts(edits, current_sha=current_sha)
    stale_conflicts = [
        {"edit": _serialize_edit(edit), "reason": "stale_branch_head", "current_sha": current_sha}
        for edit in stale
    ]
    return applicable, stale_conflicts, current_sha


def _persist_edit(
    *,
    user_id: int,
    workspace: dict,
    edit_type: Literal["class", "quantity"],
    req: CustomClassRequest | CustomQuantityRequest,
    current_sha: str | None,
) -> PersistedEdit:
    branch = workspace.get("branch") or DEFAULT_BRANCH
    try:
        if edit_type == "class":
            payload = PersistedEdit(
                user_id=user_id,
                branch=branch,
                package=req.package,
                class_name=req.name,
                parent_name=req.parent,
                parent_relation=req.relation,
                docstring=req.docstring,
                edit_type="class",
                base_sha=current_sha,
            )
        else:
            payload = PersistedEdit(
                user_id=user_id,
                branch=branch,
                package=req.package,
                class_name=req.class_name,
                quantity_name=req.quantity_name,
                dtype=req.dtype,
                docstring=req.docstring,
                parent_name=req.parent_name,
                parent_relation=req.parent_relation,
                edit_type="quantity",
                base_sha=current_sha,
            )
        return save_edit(payload, current_sha=current_sha)
    except EditConflict as conflict:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Edit is based on an older branch head; refresh the graph before retrying.",
                "stored_base_sha": conflict.existing.base_sha,
                "current_base_sha": conflict.current_sha,
                "existing_edit": _serialize_edit(conflict.existing),
            },
        )


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
        if not req.parent_name:
            raise HTTPException(
                status_code=404,
                detail=f"Section '{req.class_name}' not found in package '{req.package}'",
            )

        # Allow adding a quantity to a freshly created synthetic class by materializing it here.
        new_id = f"{req.package}.{req.class_name}"
        target_section = {
            "id": new_id,
            "kind": "section",
            "label": req.class_name,
            "doc": None,
            "module": req.package,
        }
        nodes = nodes + [target_section]

        # If a parent is provided, add an edge with the requested relation (default inherits).
        parent = next(
            (
                n
                for n in nodes
                if n.get("kind") == "section"
                and (n.get("id") == req.parent_name or n.get("label") == req.parent_name)
            ),
            None,
        )
        parent_id = parent.get("id") if parent else req.parent_name
        relation = req.parent_relation or "inherits"
        edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": None}]

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


def _attach_custom_class(graph: dict, req: CustomClassRequest) -> dict:
    """
    Inject a synthetic class node (and optional inheritance edge) into the graph.
    """
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])

    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("label") == req.name or node.get("id") == req.name:
            raise HTTPException(status_code=400, detail=f"Class '{req.name}' already exists")

    # Always use a fully qualified id to keep consistency when adding quantities later.
    new_id = f"{req.package}.{req.name}"

    new_node = {
        "id": new_id,
        "kind": "section",
        "label": req.name,
        "doc": req.docstring or None,
        "module": req.package,
    }
    nodes = nodes + [new_node]

    if req.parent:
        parent = next((n for n in nodes if n.get("id") == req.parent or n.get("label") == req.parent), None)
        parent_id = parent.get("id") if parent else req.parent
        relation = req.relation if req.relation in ("inherits", "hasSubSection") else "inherits"
        edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": None}]

    graph = dict(graph)
    graph["nodes"] = nodes
    graph["edges"] = edges
    return graph


@app.post("/schema/custom-quantity")
def add_custom_quantity(
    req: CustomQuantityRequest,
    root: str | None = Query(None),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False, description="Skip base graph; start from an empty canvas"),
    user_ws=Depends(get_user_and_workspace),
):
    user, workspace = user_ws
    ns = base_namespace
    if ns is None and workspace.get("package") == req.package:
        ns = workspace.get("base_namespace")
    if ns is None and not empty:
        ns = _root_namespace(req.package)
    workspace = update_workspace(
        user["id"],
        package=req.package,
        base_namespace=ns or workspace.get("base_namespace"),
    )
    try:
        if empty:
            graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
        else:
            graph = build_graph(
                package=req.package,
                root=root,
                include_quantities=True,
                include_subsections=include_subsections,
                include_inheritance=include_inheritance,
                allow_cross_module=allow_cross_module,
                base_namespace=ns
            )
        persisted, stale_conflicts, current_sha = _persisted_state(
            user_id=user["id"], workspace=workspace, package=req.package, base_namespace=ns
        )
        graph, apply_conflicts = _apply_persisted_edits(graph, persisted)
        result = _attach_custom_quantity(graph, req)
        saved = _persist_edit(
            user_id=user["id"],
            workspace=workspace,
            edit_type="quantity",
            req=req,
            current_sha=current_sha,
        )
        result["workspace"] = workspace_payload(workspace)
        conflicts = stale_conflicts + apply_conflicts
        if conflicts:
            result["edit_conflicts"] = conflicts
        result["persisted_edit"] = _serialize_edit(saved)
        result["branch_head"] = current_sha
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{type(e).__name__}: {e}")


@app.post("/schema/custom-class")
def add_custom_class(
    req: CustomClassRequest,
    root: str | None = Query(None),
    include_quantities: bool = Query(True),
    include_subsections: bool = Query(True),
    include_inheritance: bool = Query(True),
    allow_cross_module: bool = Query(True),
    base_namespace: str | None = Query(None),
    empty: bool = Query(False, description="Skip base graph; start from an empty canvas"),
    user_ws=Depends(get_user_and_workspace),
):
    user, workspace = user_ws
    ns = base_namespace
    if ns is None and workspace.get("package") == req.package:
        ns = workspace.get("base_namespace")
    if ns is None and not empty:
        ns = _root_namespace(req.package)
    workspace = update_workspace(
        user["id"],
        package=req.package,
        base_namespace=ns or workspace.get("base_namespace"),
    )
    try:
        if empty:
            graph = {"package": req.package, "root": root, "nodes": [], "edges": []}
        else:
            graph = build_graph(
                package=req.package,
                root=root,
                include_quantities=include_quantities,
                include_subsections=include_subsections,
                include_inheritance=include_inheritance,
                allow_cross_module=allow_cross_module,
                base_namespace=ns
            )
        persisted, stale_conflicts, current_sha = _persisted_state(
            user_id=user["id"], workspace=workspace, package=req.package, base_namespace=ns
        )
        graph, apply_conflicts = _apply_persisted_edits(graph, persisted)
        result = _attach_custom_class(graph, req)
        saved = _persist_edit(
            user_id=user["id"],
            workspace=workspace,
            edit_type="class",
            req=req,
            current_sha=current_sha,
        )
        result["workspace"] = workspace_payload(workspace)
        conflicts = stale_conflicts + apply_conflicts
        if conflicts:
            result["edit_conflicts"] = conflicts
        result["persisted_edit"] = _serialize_edit(saved)
        result["branch_head"] = current_sha
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

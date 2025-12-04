from dataclasses import dataclass, asdict
from typing import Dict, Any, List, Iterable, Tuple, Optional, Set
import importlib
import inspect


@dataclass
class Node:
    id: str
    kind: str                  # "section" | "quantity"
    label: str
    doc: Optional[str] = None
    module: Optional[str] = None
    dtype: Optional[str] = None
    shape: Optional[str] = None
    card: Optional[str] = None
    owner: Optional[str] = None
    methods: Optional[List[str]] = None  # utility methods for UML "operations"


@dataclass
class Edge:
    source: str
    target: str
    type: str                  # "hasQuantity" | "hasSubSection"
    card: Optional[str] = None


# -------- doc helpers --------

def _normalize_doc(s: Any) -> Optional[str]:
    """Trim edges, preserve newlines, strip trailing spaces per line."""
    if not isinstance(s, str):
        return None
    return "\n".join(line.rstrip() for line in s.strip().splitlines())


def _doc_from(obj: Any) -> Optional[str]:
    """
    Try to extract a human doc/description from common attributes used by
    NOMAD-style metainfo (description, m_def.description) and fall back to __doc__.
    """
    for attr in ("description", "doc", "desc"):
        v = getattr(obj, attr, None)
        v = _normalize_doc(v)
        if v:
            return v
    mdef = getattr(obj, "m_def", None)
    if mdef is not None:
        v = _normalize_doc(getattr(mdef, "description", None))
        if v:
            return v
    return _normalize_doc(getattr(obj, "__doc__", None))


# -------- main API --------

def list_sections(package: str) -> List[str]:
    mod = importlib.import_module(package)
    base_ns = _root_namespace(package)
    return sorted(
        name for name, obj in vars(mod).items()
        if _is_section(obj) and _module_in_namespace(obj, base_ns)
    )


def build_graph(
    package: str,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    allow_cross_module: bool = True,
    base_namespace: Optional[str] = None,
    exclude_prefixes: Tuple[str, ...] = ("nomad.metainfo.",),
    max_nodes: int = 8000,
    max_depth: int = 20,  # recurse reasonably deep
) -> Dict[str, Any]:
    """
    Build a graph starting at `root` (if given) or all section classes in `package`.
    Properly resolves SubSection targets that are Section definitions, and recurses.
    """
    mod = importlib.import_module(package)
    if base_namespace is None:
        base_namespace = _root_namespace(package)

    sections_local: Dict[str, Any] = {
        name: obj for name, obj in vars(mod).items() if _is_section(obj)
    }

    nodes: Dict[str, Node] = {}
    edges: List[Edge] = []
    seen: Set[str] = set()

    def add_section(sec_obj: Any, depth: int = 0):
        if depth > max_depth:
            return

        sec_mod = getattr(sec_obj, "__module__", "")
        sec_name = getattr(sec_obj, "__name__", str(sec_obj))
        sec_id = f"{sec_mod}.{sec_name}"

        if sec_id in seen:
            return
        seen.add(sec_id)

        if not _module_allowed(sec_mod, base_namespace, exclude_prefixes, allow_cross_module):
            return

        # collect methods defined in your package
        methods = _public_methods(sec_obj, base_namespace)

        # robust doc extraction
        doc = _doc_from(sec_obj)

        nodes[sec_id] = Node(
            id=sec_id,
            kind="section",
            label=sec_name,
            doc=doc,
            module=sec_mod,
            methods=methods or None
        )
        if len(nodes) > max_nodes:
            return

        if include_quantities:
            for qname, q in _get_quantities(sec_obj):
                qid = f"{sec_id}.{qname}"
                if qid not in nodes:
                    nodes[qid] = Node(
                        id=qid,
                        kind="quantity",
                        label=qname,
                        doc=_doc_from(q),               # ← include quantity doc
                        dtype=_dtype_from(q),
                        shape=_shape_from(q),
                        card=_cardinality_from(q),
                        owner=sec_id,
                        module=sec_mod
                    )
                edges.append(Edge(source=sec_id, target=qid, type="hasQuantity", card=_cardinality_from(q)))
                if len(nodes) > max_nodes:
                    return

        if include_subsections:
            for sname, s in _get_subsections(sec_obj):
                tgt_cls = _resolve_section_class(_target_section_obj(s))
                if tgt_cls is None:
                    continue
                tgt_mod = getattr(tgt_cls, "__module__", "")
                if not _module_allowed(tgt_mod, base_namespace, exclude_prefixes, allow_cross_module):
                    continue

                tgt_name = getattr(tgt_cls, "__name__", str(tgt_cls))
                tgt_id = f"{tgt_mod}.{tgt_name}"
                # add child section and quantities recursively
                add_section(tgt_cls, depth + 1)
                # add UML composition edge
                edges.append(Edge(source=sec_id, target=tgt_id, type="hasSubSection", card=_cardinality_from(s)))
                if len(nodes) > max_nodes:
                    return

    if root:
        sec_obj = sections_local.get(root)
        if not sec_obj:
            avail = ", ".join(sorted(sections_local)[:25])
            raise ValueError(f"Root section '{root}' not found in {package}. Available (first 25): {avail}")
        add_section(sec_obj, 0)
    else:
        for obj in sections_local.values():
            add_section(obj, 0)

    node_list = list(nodes.values())
    node_list.sort(key=lambda n: (n.kind, n.module or "", n.label))
    edges.sort(key=lambda e: (e.source, e.type, e.target))
    return {
        "package": package,
        "root": root,
        "base_namespace": base_namespace,
        "nodes": [asdict(n) for n in node_list],
        "edges": [asdict(e) for e in edges]
    }


# -------- introspection helpers --------

def _is_section(obj) -> bool:
    # Section classes have m_def; be liberal to support variations
    return inspect.isclass(obj) and (hasattr(obj, "m_def") or hasattr(obj, "quantities") or hasattr(obj, "sub_sections"))


def _items_from_mapping_or_list(x) -> Iterable[Tuple[str, Any]]:
    if x is None:
        return []
    if isinstance(x, dict):
        return x.items()
    if isinstance(x, (list, tuple)):
        out = []
        for obj in x:
            name = getattr(obj, "name", None) or getattr(obj, "__name__", None)
            if name:
                out.append((name, obj))
        return out
    return []


def _cardinality_from(obj) -> Optional[str]:
    if hasattr(obj, "repeats"):
        try:
            return "0..*" if bool(getattr(obj, "repeats")) else "0..1"
        except Exception:
            pass
    if hasattr(obj, "cardinality"):
        c = getattr(obj, "cardinality")
        try:
            low, high = c
            hi = "*" if (high is None or high == -1) else str(int(high))
            return f"{int(low)}..{hi}"
        except Exception:
            return str(c)
    return None


def _ref_target_name(dtype_obj) -> Optional[str]:
    """Best-effort human-friendly target for Reference-like dtypes."""

    def _name_from_target(target: Any) -> Optional[str]:
        cls = _resolve_section_class(target)
        if cls is None:
            cls = target if inspect.isclass(target) else None
        if cls is None:
            return None
        mod = getattr(cls, "__module__", "")
        name = getattr(cls, "__name__", None) or getattr(cls, "name", None)
        return f"{mod}.{name}" if (mod and name) else name

    # Common attributes exposed by NOMAD Reference dtypes
    for attr in (
        "target_section_def",
        "target_section_cls",
        "target",
        "section_def",
        "section",
    ):
        if hasattr(dtype_obj, attr):
            name = _name_from_target(getattr(dtype_obj, attr))
            if name:
                return name
    return None


def _dtype_from(q) -> Optional[str]:
    for attr in ("dtype", "type"):
        if not hasattr(q, attr):
            continue
        try:
            dtype_obj = getattr(q, attr)
            target = _ref_target_name(dtype_obj)
            if target:
                return f"Reference[{target}]"

            # If the object itself is a class, prefer its qualified name
            if inspect.isclass(dtype_obj):
                mod = getattr(dtype_obj, "__module__", "")
                name = getattr(dtype_obj, "__name__", None) or str(dtype_obj)
                return f"{mod}.{name}" if (mod and name) else name

            # Otherwise use the class name instead of the default repr
            cls = getattr(dtype_obj, "__class__", None)
            if cls is not None and cls is not object:
                mod = getattr(cls, "__module__", "")
                name = getattr(cls, "__name__", None)
                if name:
                    return f"{mod}.{name}" if mod and not mod.startswith("builtins") else name

            return str(dtype_obj)
        except Exception:
            pass
    return None


def _shape_from(q) -> Optional[str]:
    if hasattr(q, "shape"):
        try:
            return str(getattr(q, "shape"))
        except Exception:
            return None
    return None


def _get_quantities(sec_obj) -> Iterable[Tuple[str, Any]]:
    # Try class-level first
    qmap = getattr(sec_obj, "quantities", None)
    if qmap:
        return _items_from_mapping_or_list(qmap)
    # Then via m_def reflection
    mdef = getattr(sec_obj, "m_def", None)
    if mdef is not None:
        for attr in ("all_quantities", "quantities"):
            qmap = getattr(mdef, attr, None)
            if qmap:
                return _items_from_mapping_or_list(qmap)
    return []


def _get_subsections(sec_obj) -> Iterable[Tuple[str, Any]]:
    # Try class-level first
    smap = getattr(sec_obj, "sub_sections", None)
    if smap:
        return _items_from_mapping_or_list(smap)
    # Then via m_def reflection
    mdef = getattr(sec_obj, "m_def", None)
    if mdef is not None:
        for attr in ("all_sub_sections", "sub_sections"):
            smap = getattr(mdef, attr, None)
            if smap:
                return _items_from_mapping_or_list(smap)
    return []


def _target_section_obj(subsec_obj):
    """
    Return the raw target stored in SubSection definition.
    It may be a *Section class* or a *Section definition* (metainfo Section).
    """
    for attr in ("section_def", "target", "sub_section", "section"):
        if hasattr(subsec_obj, attr):
            return getattr(subsec_obj, attr)
    return None


def _resolve_section_class(target) -> Optional[type]:
    """
    If target is already a class, return it.
    If it's a metainfo Section definition, try common attributes to reach the Python class.
    """
    if target is None:
        return None
    if inspect.isclass(target):
        return target
    # NOMAD metainfo Section definitions often expose the class as section_cls / section_class
    for attr in ("section_cls", "section_class", "cls", "python_type"):
        if hasattr(target, attr):
            cand = getattr(target, attr)
            if inspect.isclass(cand):
                return cand
    # Some definitions keep a 'm_root' or similar to the owning class; try heuristics
    mod = getattr(target, "__module__", "")
    name = getattr(target, "__name__", None) or getattr(target, "name", None)
    if mod and name:
        try:
            mod_obj = importlib.import_module(mod)
            cand = getattr(mod_obj, name, None)
            if inspect.isclass(cand):
                return cand
        except Exception:
            pass
    return None


def _root_namespace(package: str) -> str:
    parts = package.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    return parts[0]


def _module_allowed(module: str, base_namespace: str, exclude_prefixes: Tuple[str, ...], allow_cross_module: bool) -> bool:
    if any(module.startswith(p) for p in exclude_prefixes):
        return False
    if allow_cross_module:
        return module.startswith(base_namespace)
    # same module only if cross-mod disabled
    return module.startswith(base_namespace)


def _module_in_namespace(obj, package_namespace: str) -> bool:
    mod = getattr(obj, "__module__", "")
    return mod.startswith(package_namespace)


def _public_methods(sec_obj, base_namespace: Optional[str] = None) -> List[str]:
    """Only public methods implemented under the active base namespace."""
    base = base_namespace or _root_namespace(getattr(sec_obj, "__module__", ""))
    names = []
    for name, member in inspect.getmembers(sec_obj, predicate=inspect.isfunction):
        if name.startswith("_"):
            continue
        mod = getattr(member, "__module__", "")
        if base and not mod.startswith(base):
            continue
        names.append(name)
    return sorted(set(names))

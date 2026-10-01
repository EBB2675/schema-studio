"""Read NOMAD schema packages inside their profile environment; print an extraction document.

Adapted from schematerial `src/schematerial/extractors/nomad.py` at commit
df3839b. Changes from that file:

- works for any NOMAD schema package (nomad-simulations, nomad-measurements):
  the distribution and the modules to read are arguments, and modules can be
  found through NOMAD schema entry points or by walking a package;
- several modules in one run, each listed under `modules` with the classes it
  exposes at module level;
- the display values the graph shows today, as attribute annotations
  `display_dtype`, `display_card` and `display_shape`, computed with the rules
  of `extractor/graph_builder.py` (`_dtype_from`, `_cardinality_from`,
  `_shape_from`), copied below;
- class descriptions fall back to the docstring, as in the graph today;
- per class: public methods with their module, and the source file and line
  as annotations `source_file` and `source_line`;
- `usage`: normalizers and helpers per class, from `usage_index.py`;
- a reference to a section that cannot be read keeps the quantity, with a
  datatype range and a `partial` report entry, instead of dropping it;
- an inherited member whose declaration could not be read is left out of
  `effective_attributes` alone (with a `partial` report entry), instead of
  emptying the class's whole list; framework bases are left out silently;
- the source commit, when the package was installed from git.

Standard library only. Started by `extractor/runner.py` in isolated mode:

    python -I nomad.py --dist DIST (--module MODULE ... | --base PACKAGE)
        [--discovery entry-points] [--discovery walk] [--root NAME ...]
        [--source-root DIR] [--no-usage]

stdout carries exactly one JSON document: {"ok": true, "result": <extraction
document>} or {"ok": false, "error": {"type", "message", "name"}} together with
a non-zero exit code. Everything else, including output printed by schema
imports, goes to stderr.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib
import importlib.metadata
import importlib.util
import inspect
import json
import re
import sys
import traceback
from collections import deque
from dataclasses import asdict
from pathlib import Path
from types import ModuleType
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
CONTRACT_VERSION = "1.0"
# Classes of the metainfo framework itself are not part of a schema.
FRAMEWORK_PREFIX = "nomad.metainfo."
DEPENDENCIES = ("nomad-lab", "numpy")
USAGE_KIND_ORDER = {"normalize_method": 0, "normalize_function": 1, "utility_function": 2}


def _load_sibling(name: str):
    """Load a module from this folder by file path, without touching the import path."""
    module_name = f"_schema_studio_{name}"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# -------- metainfo access --------

def section_class(target: Any) -> type:
    if inspect.isclass(target):
        return target
    for name in ("section_cls", "section_class", "cls", "python_type"):
        candidate = getattr(target, name, None)
        if inspect.isclass(candidate):
            return candidate
    raise ValueError("cannot resolve section definition to a Python class")


def identifier(cls: type) -> str:
    return f"{cls.__module__}.{cls.__qualname__}"


def members(value: Any) -> list[tuple[str, Any]]:
    if isinstance(value, dict):
        return sorted(value.items())
    if isinstance(value, (list, tuple)):
        return sorted(((item.name, item) for item in value), key=lambda pair: pair[0])
    raise ValueError("expected metainfo definition collection")


def raw_datatype(dtype: Any) -> str:
    if inspect.isclass(dtype):
        return identifier(dtype)
    # NOMAD DataType objects expose their serialization representation.
    serialize = getattr(dtype, "serialize_self", None)
    if callable(serialize):
        value = serialize()
        return value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    value = str(dtype)
    if not value or re.search(r" at 0x[0-9a-fA-F]+", value):
        raise ValueError(f"no stable source datatype representation for {type(dtype).__name__}")
    return value


def root_namespace(package: str) -> str:
    """The namespace the graph uses to decide which classes a module defines."""
    parts = package.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    return ".".join(parts)


# -------- display values (rules of extractor/graph_builder.py) --------

def _normalize_doc(s: Any) -> str | None:
    """Trim edges, preserve newlines, strip trailing spaces per line."""
    if not isinstance(s, str):
        return None
    return "\n".join(line.rstrip() for line in s.strip().splitlines())


def class_doc(cls: type) -> str | None:
    """Description of a section class, falling back to its docstring."""
    for attr in ("description", "doc", "desc"):
        value = _normalize_doc(getattr(cls, attr, None))
        if value:
            return value
    definition = getattr(cls, "m_def", None)
    if definition is not None:
        value = _normalize_doc(getattr(definition, "description", None))
        if value:
            return value
    return _normalize_doc(getattr(cls, "__doc__", None))


def attribute_doc(item: Any) -> str | None:
    # Only the attribute's own description: the graph today falls back to the
    # docstring of NOMAD's Quantity and SubSection classes, which says nothing
    # about the attribute.
    return _normalize_doc(getattr(item, "description", None))


def display_card(obj: Any) -> str | None:
    """Best-effort conversion of source cardinality fields to UML-style ranges."""
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
    if hasattr(obj, "mandatory"):
        try:
            return "1..1" if bool(getattr(obj, "mandatory")) else "0..1"
        except Exception:
            pass
    return None


def _resolve_section_class(target: Any) -> type | None:
    """A section class from a class or a metainfo section definition."""
    if target is None:
        return None
    if inspect.isclass(target):
        return target
    for attr in ("section_cls", "section_class", "cls", "python_type"):
        if hasattr(target, attr):
            candidate = getattr(target, attr)
            if inspect.isclass(candidate):
                return candidate
    module_name = getattr(target, "__module__", "")
    name = getattr(target, "__name__", None) or getattr(target, "name", None)
    if module_name and name:
        try:
            candidate = getattr(importlib.import_module(module_name), name, None)
            if inspect.isclass(candidate):
                return candidate
        except Exception:
            pass
    return None


def _ref_target_name(dtype_obj: Any) -> str | None:
    """Best-effort human-friendly target for Reference-like dtypes."""

    def _name_from_target(target: Any) -> str | None:
        cls = _resolve_section_class(target)
        if cls is None:
            cls = target if inspect.isclass(target) else getattr(target, "__class__", None)
        if cls is None:
            return None
        name = getattr(cls, "__name__", None) or getattr(cls, "name", None)
        if not name:
            return None
        module_name = getattr(cls, "__module__", "")
        if module_name and not module_name.startswith("builtins"):
            mod_short = module_name.rsplit(".", 1)[-1]
            if mod_short and mod_short != name:
                return f"{mod_short}.{name}"
        return name

    for attr in ("target_section_def", "target_section_cls", "target", "section_def", "section"):
        if hasattr(dtype_obj, attr):
            name = _name_from_target(getattr(dtype_obj, attr))
            if name:
                return name
    return None


def display_dtype(q: Any) -> str | None:
    """Display dtype of a NOMAD quantity: `str()` of its type, or `Reference[Target]`."""
    for attr in ("dtype", "type"):
        if not hasattr(q, attr):
            continue
        try:
            dtype_obj = getattr(q, attr)
            target = _ref_target_name(dtype_obj)
            if target:
                return f"Reference[{target}]"
            return str(dtype_obj)
        except Exception:
            pass
    return None


def display_shape(q: Any) -> str | None:
    if hasattr(q, "shape"):
        try:
            return str(getattr(q, "shape"))
        except Exception:
            return None
    return None


def display_annotations(item: Any, kind: str) -> dict[str, str]:
    """The strings the graph shows for a quantity (dtype, card, shape) or a subsection (card)."""
    values = {"display_card": display_card(item)}
    if kind == "quantity":
        values["display_dtype"] = display_dtype(item)
        values["display_shape"] = display_shape(item)
    return {key: value for key, value in values.items() if value is not None}


# -------- code facts --------

def public_methods(cls: type) -> list[dict[str, str]]:
    """Public functions on the class with their defining module; the graph filters them by namespace."""
    methods = []
    for name, member in inspect.getmembers(cls, predicate=inspect.isfunction):
        if name.startswith("_"):
            continue
        module_name = getattr(member, "__module__", None) or ""
        if not module_name or module_name.startswith(FRAMEWORK_PREFIX):
            continue
        methods.append({"name": name, "module": module_name})
    return sorted(methods, key=lambda item: item["name"])


def source_location(cls: type) -> dict[str, Any]:
    """Source file (relative to the folder holding the top-level package) and line of a class."""
    try:
        path = Path(inspect.getsourcefile(cls) or "").resolve()
        top = sys.modules[cls.__module__.split(".")[0]]
        top_file = Path(top.__file__).resolve()
        base = top_file.parent.parent if top_file.name == "__init__.py" else top_file.parent
        location: dict[str, Any] = {"source_file": path.relative_to(base).as_posix()}
    except Exception:
        return {}
    try:
        location["source_line"] = inspect.getsourcelines(cls)[1]
    except Exception:
        pass
    return location


def usage_for(class_ids: list[str]) -> dict[str, list[dict[str, str]]]:
    usage_index = _load_sibling("usage_index")
    usage: dict[str, list[dict[str, str]]] = {}
    for class_id in class_ids:
        entries = [
            {key: value for key, value in asdict(entry).items() if value is not None}
            for entry in usage_index.get_usage_for_section(class_id)
        ]
        if entries:
            # usage_index orders by kind and name; the qualname makes ties stable.
            entries.sort(key=lambda e: (USAGE_KIND_ORDER.get(e["kind"], 99), e["short_name"], e["qualname"]))
            usage[class_id] = entries
    return usage


# -------- extraction --------

def module_sections(module: ModuleType, roots: tuple[str, ...] = ()) -> list[type]:
    """Section classes a module exposes (or the requested roots), without framework classes."""
    if roots:
        found = []
        for root in roots:
            value = getattr(module, root, None)
            if not (inspect.isclass(value) and hasattr(value, "m_def")):
                raise ValueError(f"Root section '{root}' not found in {module.__name__}")
            found.append(value)
    else:
        found = [
            value for _, value in sorted(vars(module).items())
            if inspect.isclass(value) and hasattr(value, "m_def")
        ]
    return [cls for cls in found if not identifier(cls).startswith(FRAMEWORK_PREFIX)]


def extract(
    modules: list[ModuleType],
    source: dict[str, Any],
    roots: tuple[str, ...] = (),
    *,
    usage: bool = True,
    report: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    classes: dict[str, dict[str, Any]] = {}
    enums: dict[str, dict[str, Any]] = {}
    report = list(report or [])
    pending: deque[tuple[str, Any]] = deque()
    visited: set[str] = set()
    definitions: dict[str, Any] = {}
    exposed: dict[str, list[str]] = {}

    def warn(path: str, reason: str, status: str = "skipped") -> None:
        report.append({"path": path, "status": status, "reason": reason})

    def enqueue(target: Any) -> str:
        cls = section_class(target)
        name = identifier(cls)
        if name.startswith(FRAMEWORK_PREFIX):
            raise ValueError("metainfo framework class excluded from source model")
        pending.append((name, cls))
        return name

    for module in modules:
        sections = module_sections(module, roots)
        namespace = root_namespace(module.__name__)
        # Like the module list in the app: a module that only re-exports
        # classes from elsewhere is not a schema module.
        if not roots and not any(cls.__module__.startswith(namespace) for cls in sections):
            warn(module.__name__, "module defines no sections", "warning")
            continue
        exposed[module.__name__] = [identifier(cls) for cls in sections]
        for cls in sections:
            pending.append((identifier(cls), cls))

    while pending:
        path, candidate = pending.popleft()
        if path in visited:
            continue
        visited.add(path)
        try:
            cls = section_class(candidate)
            canonical_path = identifier(cls)
            if canonical_path != path:
                if canonical_path in visited:
                    continue
                visited.add(canonical_path)
                path = canonical_path
            definition = vars(cls).get("m_def")
            if definition is None:
                raise ValueError("class has no local metainfo section definition")
            if not hasattr(definition, "quantities"):
                # For example a metainfo Category, which has an m_def but no members.
                warn(path, f"not a section: its definition is a {type(definition).__name__}")
                continue
            quantities = members(definition.quantities)
            subsections = members(definition.sub_sections)
            record: dict[str, Any] = {
                "id": identifier(cls), "name": cls.__name__, "bases": [], "attributes": [],
                "effective_attributes": [],
            }
            description = class_doc(cls)
            if description:
                record["description"] = description
            annotations = source_location(cls)
            if annotations:
                record["annotations"] = annotations
            methods = public_methods(cls)
            if methods:
                record["methods"] = methods
        except Exception as error:
            warn(path, f"malformed section: {type(error).__name__}: {error}")
            continue
        classes[record["id"]] = record
        definitions[record["id"]] = definition
        for base in cls.__bases__:
            # The framework root (MSection) is every section's base; leaving it
            # out loses nothing, so it is not reported.
            if base is object or identifier(base).startswith(FRAMEWORK_PREFIX):
                continue
            try:
                record["bases"].append(enqueue(base))
            except Exception as error:
                warn(f"{path}.__bases__.{base.__name__}", str(error))
        for kind, items in (("quantity", quantities), ("subsection", subsections)):
            for name, item in items:
                attribute_path = f"{path}.{name}"
                try:
                    if not isinstance(name, str) or not name:
                        raise ValueError("attribute name must be a nonempty string")
                    if any(attribute["name"] == name for attribute in record["attributes"]):
                        raise ValueError("duplicate class-local attribute name")
                    attribute: dict[str, Any] = {"name": name, "kind": kind}
                    description = attribute_doc(item)
                    if description:
                        attribute["description"] = description
                    annotations = display_annotations(item, kind)
                    if kind == "subsection":
                        target = enqueue(item.sub_section)
                        if not isinstance(item.repeats, bool):
                            raise ValueError("subsection repeats is not boolean")
                        attribute.update(range={"kind": "class", "name": target},
                                         repeats=item.repeats)
                    else:
                        dtype = item.type
                        if dtype is None:
                            raise ValueError("quantity has no source type")
                        serialize = getattr(dtype, "serialize_self", None)
                        # Reference.serialize_self needs a section context; resolve it below.
                        reference = getattr(dtype, "target_section_def", None)
                        serialized = (
                            serialize() if callable(serialize) and reference is None else None
                        )
                        if isinstance(serialized, dict) and serialized.get("type_kind") == "enum":
                            values = serialized["type_data"]
                            if not isinstance(values, list) or not all(
                                isinstance(value, str) for value in values
                            ):
                                raise ValueError("enum contains non-string values")
                            if len(values) != len(set(values)):
                                raise ValueError("enum contains duplicate values")
                            enums[attribute_path] = {"id": attribute_path, "values": values}
                            annotations["source_type"] = json.dumps(serialized, sort_keys=True)
                            range_ = {"kind": "enum", "name": attribute_path}
                        elif reference is not None:
                            try:
                                range_ = {"kind": "class", "name": enqueue(reference)}
                            except Exception as error:
                                range_ = {"kind": "datatype", "name": annotations.get("display_dtype") or "Reference"}
                                warn(attribute_path, f"reference target unreadable, kept as datatype: {error}", "partial")
                        else:
                            try:
                                range_ = {"kind": "datatype", "name": raw_datatype(dtype)}
                            except Exception as error:
                                range_ = {"kind": "datatype", "name": type(dtype).__name__}
                                warn(attribute_path, f"datatype kept by type name: {error}", "partial")
                        attribute["range"] = range_
                        if item.unit is not None:
                            attribute["unit"] = str(item.unit)
                        shape = item.shape
                        if shape is not None:
                            if not isinstance(shape, list) or not all(
                                (type(dim) is int and dim >= 0) or
                                (isinstance(dim, str) and bool(dim)) for dim in shape
                            ):
                                raise ValueError(f"shape cannot be preserved as JSON: {shape!r}")
                            attribute["shape"] = list(shape)
                    if annotations:
                        attribute["annotations"] = annotations
                    record["attributes"].append(attribute)
                except Exception as error:
                    warn(attribute_path, f"unreadable {kind}: {type(error).__name__}: {error}")

    # Targets can fail after discovery. Remove each dangling base and subsection
    # with a report; a reference quantity stays, with a datatype range.
    for record in classes.values():
        bases = []
        for base in record["bases"]:
            if base in classes:
                bases.append(base)
            else:
                warn(f"{record['id']}.__bases__.{base}", "target section was skipped")
        record["bases"] = bases
        attributes = []
        for attribute in record["attributes"]:
            range_ = attribute["range"]
            path = f"{record['id']}.{attribute['name']}"
            if range_["kind"] == "class" and range_["name"] not in classes:
                if attribute["kind"] == "subsection":
                    warn(path, "target section was skipped")
                    continue
                shown = attribute.get("annotations", {}).get("display_dtype")
                attribute["range"] = {"kind": "datatype", "name": shown or "Reference"}
                warn(path, "reference target section was skipped, kept as datatype", "partial")
            attributes.append(attribute)
        record["attributes"] = attributes

    # Read NOMAD's resolved dictionaries, never reconstruct inheritance from bases.
    declarations = {(record["id"], attr["name"]): attr["kind"]
                    for record in classes.values() for attr in record["attributes"]}
    for path, record in classes.items():
        definition = definitions[path]
        try:
            if getattr(definition, "extending_sections", []):
                raise ValueError("metainfo extending sections are unsupported")
            for kind, properties in (("quantity", definition.all_quantities),
                                     ("subsection", definition.all_sub_sections)):
                for name, prop in members(properties):
                    owner = identifier(section_class(prop.m_parent))
                    if declarations.get((owner, name)) != kind:
                        # The declaration itself could not be read (reported
                        # there); leave out only this member.
                        warn(path, f"effective {kind} {owner}.{name} left out: its declaration was not read", "partial")
                        continue
                    if any(ref["name"] == name for ref in record["effective_attributes"]):
                        raise ValueError(f"cross-kind effective name collision: {name}")
                    record["effective_attributes"].append({
                        "kind": kind, "name": name, "declaring_class_id": owner,
                    })
        except Exception as error:
            record["effective_attributes"] = []
            warn(path, f"incomplete effective definitions: {type(error).__name__}: {error}")
        record["effective_attributes"].sort(key=lambda ref: ref["name"])

    document: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "source": source,
        "modules": [
            {"name": name, "classes": sorted({cid for cid in ids if cid in classes})}
            for name, ids in sorted(exposed.items())
        ],
        "classes": [classes[key] for key in sorted(classes)],
        "enums": [enums[key] for key in sorted(enums)],
        "report": sorted(report, key=lambda row: (row["path"], row["reason"])),
    }
    if usage:
        document["usage"] = usage_for(sorted(classes))
    return document


# -------- command line --------

def source_facts(dist: str, module: str, *, from_installed: bool) -> dict[str, Any]:
    """Name, version, commit and main dependency versions of the installed schema package."""
    distribution = importlib.metadata.distribution(dist)
    source: dict[str, Any] = {"name": dist, "version": distribution.version, "module": module}
    if from_installed:
        try:
            direct_url = json.loads(distribution.read_text("direct_url.json") or "null")
            commit = direct_url["vcs_info"]["commit_id"]
            if isinstance(commit, str) and commit:
                source["commit"] = commit
        except Exception:
            pass
    dependencies = {}
    for name in DEPENDENCIES:
        try:
            dependencies[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    source["dependencies"] = dict(sorted(dependencies.items()))
    return source


def _common_package(names: list[str]) -> str:
    parts = [name.split(".") for name in names]
    common = []
    for level in zip(*parts):
        if len(set(level)) != 1:
            break
        common.append(level[0])
    return ".".join(common) or names[0]


def run(args: argparse.Namespace) -> dict[str, Any]:
    report: list[dict[str, str]] = []
    if args.module:
        module_names = sorted(set(args.module))
        base = args.base or _common_package(module_names)
        modules = [importlib.import_module(name) for name in module_names]
    else:
        if not args.base:
            raise ValueError("give --module or --base")
        base = args.base
        discovery = _load_sibling("discovery")
        module_names, failed = discovery.candidate_modules(base, args.dist, args.discovery or ["walk"])
        report.extend(
            {"path": item["module"], "status": "skipped", "reason": item["error"]} for item in failed
        )
        modules = []
        for name in module_names:
            try:
                modules.append(importlib.import_module(name))
            except Exception as exc:
                report.append({"path": name, "status": "skipped", "reason": f"{type(exc).__name__}: {exc}"})
    if args.root and len(modules) != 1:
        raise ValueError("--root needs exactly one --module")
    source = source_facts(args.dist, base, from_installed=not args.source_root)
    return extract(modules, source, tuple(args.root), usage=not args.no_usage, report=report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="Distribution name of the schema package, e.g. nomad-measurements")
    parser.add_argument("--module", action="append", default=[], help="Module to read; repeat for several")
    parser.add_argument("--base", help="Package whose schema modules are read when no --module is given")
    parser.add_argument("--discovery", action="append", choices=["entry-points", "walk"],
                        help="How modules under --base are found (default: walk); repeat for both")
    parser.add_argument("--root", action="append", default=[], help="Start from this section only (needs one --module)")
    parser.add_argument("--source-root", help="Folder to import the schema package from instead of the installed one")
    parser.add_argument("--no-usage", action="store_true", help="Leave out normalizer usage")
    args = parser.parse_args(argv)

    out = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.source_root:
                sys.path.insert(0, args.source_root)
            document = run(args)
        payload = {"ok": True, "result": document}
        code = 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        payload = {
            "ok": False,
            "error": {"type": type(exc).__name__, "message": str(exc), "name": getattr(exc, "name", None)},
        }
        code = 1
    out.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False))
    out.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

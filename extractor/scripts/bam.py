"""Read bam-masterdata inside its profile environment; print an extraction document.

Adapted from schematerial `src/schematerial/extractors/bam.py` at commit
df3839b. As there, only `bam_masterdata.datamodel` and `bam_masterdata.metadata`
are read, never the command line package; properties are class attributes
holding a `PropertyTypeAssignment`, vocabulary terms class attributes holding a
`VocabularyTerm`; `CONTROLLEDVOCABULARY` and `OBJECT` properties name their
target by code, resolved over the whole datamodel; entity and property fields
are kept as annotations. Changes from that file:

- entities are recognized as in `extractor/graph_builder.py`: a class with
  `ObjectType` or `VocabularyType` of `bam_masterdata.metadata.entities` among
  its bases, so a class without its own `defs` is not lost; the `defs` it has
  still give its annotations;
- the openBIS entity types themselves (`ObjectType`, `VocabularyType`,
  `CollectionType`, `DatasetType`) are kept as the base classes of the schema,
  like NOMAD's `ArchiveSection`; only their roots (`BaseEntity`, pydantic's
  `BaseModel`) are left out. They are reached as bases only: no module
  exposes them and they hold no vocabulary terms of their own;
- several modules in one run (`--base` walks `bam_masterdata.datamodel`), each
  listed under `modules` with the entities it exposes at module level, in
  module order, and every module-level name bound to one of them (`names`);
- vocabulary terms keep their Python attribute name as the value annotation
  `python_name`, because the graph names term nodes after it; terms inherited
  from a base vocabulary stay on the base (the graph collects them);
- `effective_attributes` follow the graph's order (base classes first, each in
  declaration order) instead of being sorted by name;
- the display values the graph shows today, as attribute annotations
  `display_dtype` and `display_card`, computed with the rules of
  `extractor/graph_builder.py` (`_dtype_from`, `_cardinality_from`), copied below;
- class descriptions fall back like the graph does (to the docstring); an
  attribute or term without a description of its own gets none;
- a vocabulary code held by two vocabularies resolves to the one in the same
  package as the property's class, with a `warning` report entry; otherwise it
  stays unresolved, as in schematerial;
- no check against `get_property_metadata()`, which needs instances;
- the source commit, when the package was installed from git.

Standard library only. Started by `extractor/runner.py` in isolated mode:

    python -I bam.py --dist DIST (--module MODULE ... | --base PACKAGE)
        [--discovery walk] [--root NAME ...] [--source-root DIR]

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
import sys
import traceback
from collections import deque
from enum import Enum
from pathlib import Path
from types import ModuleType
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
CONTRACT_VERSION = "1.0"
DATAMODEL = "bam_masterdata.datamodel"
# Classes of the openBIS framework itself are not part of a schema, apart from
# the entity types of ENTITIES_MODULE that schema classes derive from.
FRAMEWORK_PREFIX = "bam_masterdata.metadata."
ENTITIES_MODULE = "bam_masterdata.metadata.entities"
DEFINITIONS_MODULE = "bam_masterdata.metadata.definitions"
DEPENDENCIES = ("pydantic", "pint")

# Entity definition fields kept verbatim; `code` is the entity's identity in openBIS.
ENTITY_FIELDS = (
    "code", "iri", "validation_script", "generated_code_prefix", "auto_generate_codes",
    "url_template", "main_dataset_pattern", "main_dataset_path",
)
# Property assignment fields kept verbatim, beyond the ones that become contract
# fields (`data_type`, `units`, `description`). `code` is kept as `property_code`.
PROPERTY_FIELDS = (
    "code", "iri", "property_label", "section", "mandatory", "show_in_edit_views", "ordinal",
    "unique", "internal_assignment", "dynamic_script", "vocabulary_code", "object_code", "metadata",
)


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


# -------- masterdata access --------

def identifier(cls: type) -> str:
    return f"{cls.__module__}.{cls.__qualname__}"


def _has_entity_base(obj: Any, names: frozenset[str]) -> bool:
    return any(
        getattr(base, "__module__", "") == ENTITIES_MODULE and base.__name__ in names
        for base in getattr(obj, "__mro__", ())
    )


def is_framework(cls: type) -> bool:
    return identifier(cls).startswith(FRAMEWORK_PREFIX)


def is_entity(obj: Any) -> bool:
    """An object type or vocabulary class: of a schema, or one of the framework's entity types."""
    return (
        inspect.isclass(obj)
        and _has_entity_base(obj, frozenset({"ObjectType", "VocabularyType"}))
        and (not is_framework(obj) or obj.__module__ == ENTITIES_MODULE)
    )


def is_schema_entity(obj: Any) -> bool:
    """An object type or vocabulary class of a schema (not of the framework)."""
    return is_entity(obj) and not is_framework(obj)


def is_vocabulary(cls: type) -> bool:
    """A vocabulary of a schema; `VocabularyType` itself has no terms."""
    return not is_framework(cls) and _has_entity_base(cls, frozenset({"VocabularyType"}))


def _is_definition(value: Any, name: str) -> bool:
    return type(value).__name__ == name and type(value).__module__ == DEFINITIONS_MODULE


def is_property(value: Any) -> bool:
    return _is_definition(value, "PropertyTypeAssignment")


def is_term(value: Any) -> bool:
    return _is_definition(value, "VocabularyTerm")


def definition_of(cls: type) -> Any:
    """The entity definition a class declares itself (`defs`), never an inherited one."""
    definition = vars(cls).get("defs")
    return definition if type(definition).__name__.endswith("TypeDef") else None


def enum_id(cls: type) -> str:
    """A vocabulary is both a class and an enum, so the two get different ids."""
    return f"{identifier(cls)}.terms"


def scalar(value: Any) -> str | int | float | bool | None:
    """One annotation value, or None when the source states nothing; anything else as sorted JSON text."""
    if isinstance(value, Enum):
        value = value.value
    if value is None or value == "":
        return None
    if isinstance(value, (bool, int, float, str)):
        return value
    return json.dumps(value, sort_keys=True, default=str)


def annotations_of(definition: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for field in fields:
        value = scalar(getattr(definition, field, None))
        if value is not None:
            result[field] = value
    return result


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
    """Description of an entity class: its definition's, falling back to the docstring."""
    for attr in ("description", "doc", "desc"):
        value = _normalize_doc(getattr(cls, attr, None))
        if value:
            return value
    for holder in ("m_def", "defs"):
        definition = getattr(cls, holder, None)
        if definition is not None:
            value = _normalize_doc(getattr(definition, "description", None))
            if value:
                return value
    return _normalize_doc(getattr(cls, "__doc__", None))


def own_doc(item: Any) -> str | None:
    # Only the item's own description: the graph today falls back to the
    # docstring of the PropertyTypeAssignment and VocabularyTerm classes, which
    # says nothing about the item.
    return _normalize_doc(getattr(item, "description", None)) or None


def _enumish_value(value: Any) -> str:
    """Convert enum-like values into a stable scalar string."""
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str) and enum_value:
        return enum_value
    text = str(value)
    if text.startswith("DataType."):
        return text.split(".", 1)[1]
    return text


def display_dtype(q: Any) -> str | None:
    """openBIS type, with the vocabulary or object code in brackets for links."""
    try:
        raw_dtype = _enumish_value(getattr(q, "data_type"))
        vocabulary_code = getattr(q, "vocabulary_code", None)
        object_code = getattr(q, "object_code", None)
        if vocabulary_code:
            return f"{raw_dtype}[{vocabulary_code}]"
        if object_code:
            return f"{raw_dtype}[{object_code}]"
        return raw_dtype
    except Exception:
        return None


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


# -------- extraction --------

def datamodel_modules() -> list[ModuleType]:
    """Every module of the datamodel, including its domain subpackages."""
    modules = []
    for name in _load_sibling("discovery").list_modules_for_base(DATAMODEL):
        with contextlib.suppress(Exception):
            modules.append(importlib.import_module(name))
    return modules


def build_catalog(modules: list[ModuleType]) -> dict[tuple[str, str], list[type]]:
    """Entity classes by (definition kind, openBIS code), over the whole datamodel.

    Properties name their vocabulary and object targets by code. A code held by
    two definitions is kept with both, to be resolved or reported, never raced.
    """
    catalog: dict[tuple[str, str], list[type]] = {}
    for module in modules:
        for value in vars(module).values():
            if not is_schema_entity(value) or value.__module__ != module.__name__:
                continue
            definition = definition_of(value)
            code = getattr(definition, "code", None)
            if isinstance(code, str) and code:
                found = catalog.setdefault((type(definition).__name__, code), [])
                if value not in found:
                    found.append(value)
    return catalog


def module_entities(module: ModuleType, roots: tuple[str, ...] = ()) -> list[type]:
    """Schema entity classes a module exposes, in module order (or the requested roots).

    The framework's entity types, which every module imports, are bases only.
    """
    if roots:
        found = []
        for root in roots:
            value = getattr(module, root, None)
            if not is_schema_entity(value):
                raise ValueError(f"Root section '{root}' not found in {module.__name__}")
            found.append(value)
        return found
    return list(dict.fromkeys(value for value in vars(module).values() if is_schema_entity(value)))


def extract(
    modules: list[ModuleType],
    source: dict[str, Any],
    roots: tuple[str, ...] = (),
    *,
    catalog: dict[tuple[str, str], list[type]],
    report: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    classes: dict[str, dict[str, Any]] = {}
    enums: dict[str, dict[str, Any]] = {}
    objects: dict[str, type] = {}
    report = list(report or [])
    pending: deque[type] = deque()
    exposed: dict[str, list[str]] = {}
    names: dict[str, dict[str, str]] = {}

    def warn(path: str, reason: str, status: str = "skipped") -> None:
        report.append({"path": path, "status": status, "reason": reason})

    for module in modules:
        entities = module_entities(module, roots)
        namespace = root_namespace(module.__name__)
        # Like the module list in the app: a module that only imports entities
        # from elsewhere is not a schema module.
        if not roots and not any(cls.__module__.startswith(namespace) for cls in entities):
            warn(module.__name__, "module defines no entities", "warning")
            continue
        exposed[module.__name__] = [identifier(cls) for cls in entities]
        if roots:
            pending.extend(entities)
            continue
        names[module.__name__] = {
            name: identifier(value) for name, value in vars(module).items()
            if any(value is cls for cls in entities)
        }
        pending.extend(entities)

    def resolve(raw: str, assignment: Any, owner: type, path: str) -> dict[str, str]:
        """The property's range: the vocabulary or object type its code names, else the raw type."""
        targets = {
            "CONTROLLEDVOCABULARY": ("vocabulary_code", "VocabularyTypeDef", "enum"),
            "OBJECT": ("object_code", "ObjectTypeDef", "class"),
        }
        if raw not in targets:
            return {"kind": "datatype", "name": raw}
        field, kind, range_kind = targets[raw]
        code = getattr(assignment, field, None)
        found = catalog.get((kind, code), []) if isinstance(code, str) else []
        if len(found) > 1:
            package = owner.__module__.rpartition(".")[0]
            near = [target for target in found if target.__module__.rpartition(".")[0] == package]
            names = ", ".join(sorted(identifier(target) for target in found))
            if len(near) != 1:
                warn(path, f"ambiguous {field} {code!r}: {names}", "partial")
                return {"kind": "datatype", "name": raw}
            warn(path, f"ambiguous {field} {code!r}: {names}; took {identifier(near[0])} "
                       "from the same package", "warning")
            found = near
        if not found:
            warn(path, f"unresolved {field} {code!r} for {raw} property", "partial")
            return {"kind": "datatype", "name": raw}
        pending.append(found[0])
        return {"kind": range_kind, "name": enum_id(found[0]) if range_kind == "enum" else identifier(found[0])}

    while pending:
        cls = pending.popleft()
        path = identifier(cls)
        if path in classes:
            continue
        try:
            definition = definition_of(cls)
            record: dict[str, Any] = {
                "id": path, "name": cls.__name__, "bases": [], "attributes": [], "effective_attributes": [],
            }
            description = class_doc(cls)
            if description:
                record["description"] = description
            annotations: dict[str, Any] = {}
            if definition is not None:
                annotations["entity_kind"] = type(definition).__name__
                annotations.update(annotations_of(definition, ENTITY_FIELDS))
            vocabulary = is_vocabulary(cls)
            if vocabulary:
                annotations["vocabulary_enum"] = enum_id(cls)
            if annotations:
                record["annotations"] = annotations
            local = list(vars(cls).items())
        except Exception as error:
            warn(path, f"malformed entity: {type(error).__name__}: {error}")
            continue
        classes[path] = record
        objects[path] = cls

        for base in cls.__bases__:
            if is_entity(base):
                record["bases"].append(identifier(base))
                pending.append(base)
            elif base is object or is_framework(base):
                # The root of the entity types (BaseEntity, and pydantic's
                # BaseModel above it) holds no properties; leaving it out loses nothing.
                continue
            else:
                warn(f"{path}.__bases__.{base.__name__}", "base is not a masterdata entity")

        if vocabulary:
            values: list[dict[str, Any]] = []
            for name, term in local:
                if not is_term(term):
                    continue
                try:
                    code = getattr(term, "code", None)
                    if not isinstance(code, str) or not code:
                        raise ValueError("vocabulary term has no code")
                    if any(value["value"] == code for value in values):
                        raise ValueError(f"duplicate vocabulary term code {code!r}")
                    value: dict[str, Any] = {"value": code}
                    label = scalar(getattr(term, "label", None))
                    if isinstance(label, str):
                        value["title"] = label
                    term_description = own_doc(term)
                    if term_description:
                        value["description"] = term_description
                    value_annotations: dict[str, Any] = {"python_name": name}
                    official = getattr(term, "official", None)
                    if isinstance(official, bool):
                        value_annotations["official"] = official
                    value["annotations"] = value_annotations
                    values.append(value)
                except Exception as error:
                    warn(f"{path}.{name}", f"unreadable term: {type(error).__name__}: {error}")
            enums[enum_id(cls)] = {"id": enum_id(cls), "values": values}

        for name, assignment in local:
            if not is_property(assignment):
                continue
            attribute_path = f"{path}.{name}"
            try:
                raw = scalar(_enumish_value(getattr(assignment, "data_type", None)))
                if not isinstance(raw, str) or raw == "None":
                    raise ValueError("property assignment has no data type")
                annotations = {"data_type": raw, **{
                    ("property_code" if field == "code" else field): value
                    for field, value in annotations_of(assignment, PROPERTY_FIELDS).items()
                }}
                for tag, value in (("display_dtype", display_dtype(assignment)),
                                   ("display_card", display_card(assignment))):
                    if value is not None:
                        annotations[tag] = value
                attribute: dict[str, Any] = {"name": name, "kind": "property"}
                description = own_doc(assignment)
                if description:
                    attribute["description"] = description
                attribute["range"] = resolve(raw, assignment, cls, attribute_path)
                units = getattr(assignment, "units", None)
                if units:
                    attribute["unit"] = str(units)
                attribute["annotations"] = annotations
                record["attributes"].append(attribute)
            except Exception as error:
                warn(attribute_path, f"unreadable property: {type(error).__name__}: {error}")

    # Targets can fail after discovery. Remove each dangling base and range with a report.
    for record in classes.values():
        bases = []
        for base in record["bases"]:
            if base in classes:
                bases.append(base)
            else:
                warn(f"{record['id']}.__bases__.{base}", "target entity was skipped")
        record["bases"] = bases
        attributes = []
        for attribute in record["attributes"]:
            range_ = attribute["range"]
            known = classes if range_["kind"] == "class" else enums
            if range_["kind"] in ("class", "enum") and range_["name"] not in known:
                warn(f"{record['id']}.{attribute['name']}", "target entity was skipped")
            else:
                attributes.append(attribute)
        record["attributes"] = attributes

    # Python's own lookup: the most derived declaration of a name wins; the
    # order is the graph's (base classes first, each in declaration order).
    declarations = {(record["id"], attribute["name"]) for record in classes.values() for attribute in record["attributes"]}
    for path, record in classes.items():
        resolved: dict[str, str] = {}
        for ancestor in reversed(objects[path].__mro__):
            for name, value in vars(ancestor).items():
                if is_property(value):
                    resolved[name] = identifier(ancestor)
        for name, owner in resolved.items():
            if (owner, name) not in declarations:
                warn(path, f"effective property {owner}.{name} left out: its declaration was not read", "partial")
                continue
            record["effective_attributes"].append({"kind": "property", "name": name, "declaring_class_id": owner})

    return {
        "contract_version": CONTRACT_VERSION,
        "source": source,
        "modules": [
            {"name": name, "classes": list(dict.fromkeys(cid for cid in ids if cid in classes)),
             **({"names": found} if (found := {
                 binding: cid for binding, cid in names.get(name, {}).items() if cid in classes
             }) else {})}
            for name, ids in sorted(exposed.items())
        ],
        "classes": [classes[key] for key in sorted(classes)],
        "enums": [enums[key] for key in sorted(enums)],
        "report": sorted(report, key=lambda row: (row["path"], row["reason"])),
    }


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
    """The package the modules have in common: the module itself when there is one."""
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
        module_names, failed = _load_sibling("discovery").candidate_modules(base, args.dist, args.discovery or ["walk"])
        report.extend({"path": item["module"], "status": "skipped", "reason": item["error"]} for item in failed)
        modules = []
        for name in module_names:
            try:
                modules.append(importlib.import_module(name))
            except Exception as exc:
                report.append({"path": name, "status": "skipped", "reason": f"{type(exc).__name__}: {exc}"})
    for name in module_names:
        if name != DATAMODEL and not name.startswith(f"{DATAMODEL}."):
            raise ValueError(f"{name}: only modules within {DATAMODEL} are read")
    if args.root and len(modules) != 1:
        raise ValueError("--root needs exactly one --module")
    source = source_facts(args.dist, base, from_installed=not args.source_root)
    return extract(modules, source, tuple(args.root), catalog=build_catalog(datamodel_modules()), report=report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", required=True, help="Distribution name of the schema package (bam-masterdata)")
    parser.add_argument("--module", action="append", default=[], help="Module to read; repeat for several")
    parser.add_argument("--base", help="Package whose modules are read when no --module is given")
    parser.add_argument("--discovery", action="append", choices=["walk"],
                        help="How modules under --base are found (walk: every module file)")
    parser.add_argument("--root", action="append", default=[], help="Start from this entity only (needs one --module)")
    parser.add_argument("--source-root", help="Folder to import the schema package from instead of the installed one")
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

"""Graph adapter: a LinkML schema held as plain JSON data to the graph JSON the frontend reads.

Plain data in and out, standard library only, so the same code can run in the
browser. The graph follows the conventions of `extractor/graph_builder.py`:

- each class is a `section` node; its id is the class name (the source id),
  its label the class title, its doc the class description;
- each attribute a class has in the current schema, declared or inherited
  (the source's attribute list only sets their order), with `source_kind`
  `quantity` (NOMAD) or `property` (bam-masterdata) is a `quantity` node owned
  by that class (id `<class>.<name>`) with a `hasQuantity` edge; with
  `source_kind` `subsection` it is a `hasSubSection` edge to its range;
- a bam-masterdata vocabulary is a class linked to its enum
  (`source_vocabulary_enum`); each of its terms, its bases' terms included, is
  a `quantity` node with dtype `VOCAB_TERM`, named after the term's Python
  attribute (`source_python_name`);
- `dtype`, `card` and `shape` are the extractor's display annotations, not
  values derived from LinkML ranges; `unit` is the source unit;
- bam-masterdata nodes also carry the openBIS facts the doc panel shows, when
  the source states them: `code`, `title` (property or term label), `title_de`,
  `doc_de` (the German half of the description), `mandatory`, `section`, `iri`;
- each class gets an `inherits` edge to every ancestor (from `is_a` and
  `mixins`, in Python's method resolution order), not only to its direct bases;
- the query flags of the graph endpoints are applied here, with the same
  traversal, depth and size limits as the graph builder.

The extraction document of the snapshot supplies what LinkML does not hold:
the classes each module exposes (the starting points of a graph) and the
public methods of each class.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

# Framework base classes (NOMAD metainfo, openBIS entity types) are not part of a schema.
EXCLUDE_PREFIXES = ("nomad.metainfo.", "bam_masterdata.metadata.")
# Attribute kinds shown as quantity nodes: NOMAD quantities and bam-masterdata properties.
QUANTITY_KINDS = ("quantity", "property")
VOCABULARY_TERM_DTYPE = "VOCAB_TERM"
MAX_NODES = 8000
MAX_DEPTH = 20


class RootNotFound(ValueError):
    """The requested root is not a class the module exposes."""


def root_namespace(package: str) -> str:
    """The namespace a module's graph is limited to when cross-module links are off."""
    parts = package.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    return ".".join(parts)


def annotation(element: Mapping[str, Any], tag: str) -> str | None:
    """An annotation value, whether stored as plain text or as a LinkML `{tag, value}` object."""
    value = (element.get("annotations") or {}).get(tag)
    if isinstance(value, Mapping):
        value = value.get("value")
    return None if value is None else str(value)


def _json_annotation(element: Mapping[str, Any], tag: str) -> Any:
    text = annotation(element, tag)
    return None if text is None else json.loads(text)


def class_module(name: str, cls: Mapping[str, Any]) -> str:
    """The Python module of a class: its source id without the class name."""
    title = cls.get("title")
    if title and name.endswith(f".{title}"):
        return name[: -len(title) - 1]
    return name.rpartition(".")[0]


def _mro(name: str, classes: Mapping[str, Mapping[str, Any]], memo: dict[str, list[str]]) -> list[str]:
    """Python's C3 linearization over `is_a` + `mixins`, limited to classes in the schema."""
    if name in memo:
        return memo[name]
    memo[name] = [name]  # guards against cycles while this class is being linearized
    cls = classes[name]
    bases = [base for base in [cls.get("is_a"), *(cls.get("mixins") or [])] if base and base in classes]
    sequences = [list(_mro(base, classes, memo)) for base in bases] + [list(bases)]
    result = [name]
    while True:
        sequences = [seq for seq in sequences if seq]
        if not sequences:
            break
        for seq in sequences:
            head = seq[0]
            if not any(head in other[1:] for other in sequences):
                break
        else:
            # Not linearizable (cannot happen for real Python classes); keep depth-first order.
            head = sequences[0][0]
        result.append(head)
        for seq in sequences:
            if seq and seq[0] == head:
                del seq[0]
    deduplicated = list(dict.fromkeys(result))
    memo[name] = deduplicated
    return deduplicated


def effective_attributes(
    name: str, classes: Mapping[str, Mapping[str, Any]], memo: dict[str, list[str]],
) -> list[tuple[str, dict[str, Any]]]:
    """(declaring class, attribute) for every attribute a class has, declared or inherited.

    The current schema decides which attributes a class has: its own ones
    override inherited ones along the resolution order, so edits (added,
    removed or moved attributes, changed bases) show up. The source's list
    (`source_effective_attributes`) only gives the order of the attributes it
    still names, which is NOMAD's own order; any others follow, base classes
    first and in declaration order.
    """
    collected: dict[str, tuple[str, dict[str, Any]]] = {}
    for ancestor in reversed(_mro(name, classes, memo)):
        for attribute_name, slot in (classes[ancestor].get("attributes") or {}).items():
            collected[attribute_name] = (ancestor, slot)
    hint = _json_annotation(classes[name], "source_effective_attributes") or []
    rank = {ref["name"]: index for index, ref in enumerate(hint)}
    natural = {key: index for index, key in enumerate(collected)}
    ordered = sorted(natural, key=lambda key: (0, rank[key]) if key in rank else (1, natural[key]))
    return [collected[key] for key in ordered]


def vocabulary_terms(
    name: str, schema: Mapping[str, Any], memo: dict[str, list[str]],
) -> list[tuple[str, str, Mapping[str, Any]]]:
    """(Python name, term code, permissible value) of every term of a vocabulary class.

    Terms of base vocabularies come first, as the graph builder collects them;
    a term a class redeclares under the same Python name replaces the base's.
    Empty for a class that is not a vocabulary.
    """
    classes = schema.get("classes") or {}
    enums = schema.get("enums") or {}
    collected: dict[str, tuple[str, Mapping[str, Any]]] = {}
    for ancestor in reversed(_mro(name, classes, memo)):
        enum = enums.get(annotation(classes[ancestor], "source_vocabulary_enum") or "") or {}
        for code, value in (enum.get("permissible_values") or {}).items():
            value = value or {}
            collected[annotation(value, "source_python_name") or code] = (code, value)
    return [(python_name, code, value) for python_name, (code, value) in collected.items()]


def _present(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


def _class_details(cls: Mapping[str, Any]) -> dict[str, Any]:
    """openBIS facts of a bam-masterdata class (none for NOMAD classes)."""
    if annotation(cls, "source_entity_code") is None:
        return {}
    source = _json_annotation(cls, "source_annotations") or {}
    return _present(code=annotation(cls, "source_entity_code"), iri=source.get("iri"),
                    doc_de=annotation(cls, "description_de"))


def _property_details(slot: Mapping[str, Any]) -> dict[str, Any]:
    """openBIS facts of a bam-masterdata property."""
    source = _json_annotation(slot, "source_annotations") or {}
    return _present(code=annotation(slot, "source_property_code"), title=slot.get("title"),
                    title_de=annotation(slot, "title_de"), doc_de=annotation(slot, "description_de"),
                    mandatory=bool(slot.get("required")), section=source.get("section"), iri=source.get("iri"))


def _term_details(code: str, value: Mapping[str, Any]) -> dict[str, Any]:
    return _present(code=code, title=value.get("title"), title_de=annotation(value, "title_de"),
                    doc_de=annotation(value, "description_de"))


def _methods(record: Mapping[str, Any] | None, base_namespace: str) -> list[str] | None:
    """Public method names implemented under the active base namespace, as the graph builder lists them."""
    names = {
        method["name"] for method in (record or {}).get("methods") or ()
        if base_namespace and method.get("module", "").startswith(base_namespace)
    }
    return sorted(names) or None


def module_classes(extraction: Mapping[str, Any], package: str) -> list[str]:
    """The classes a module exposes, in module order: the starting points of its graph."""
    for module in extraction.get("modules") or ():
        if module["name"] == package:
            return list(module["classes"])
    return []


def module_aliases(extraction: Mapping[str, Any], package: str) -> dict[str, str]:
    """Other module-level names of the module's classes (`Symmetry = GlobalCrystalSymmetry`)."""
    for module in extraction.get("modules") or ():
        if module["name"] == package:
            return dict(module.get("aliases") or {})
    return {}


def _title(name: str, cls: Mapping[str, Any]) -> str:
    return cls.get("title") or name.rpartition(".")[2]


def section_names(schema: Mapping[str, Any], extraction: Mapping[str, Any], package: str) -> list[str]:
    """Names of the classes a module exposes that belong to its namespace: the roots it offers."""
    classes = schema.get("classes") or {}
    namespace = root_namespace(package)

    def inside(name: str) -> bool:
        return name in classes and class_module(name, classes[name]).startswith(namespace)

    names = {_title(name, classes[name]) for name in module_classes(extraction, package) if inside(name)}
    names.update(alias for alias, name in module_aliases(extraction, package).items() if inside(name))
    return sorted(names)


def schema_modules(schema: Mapping[str, Any], extraction: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every module of the document that offers at least one root, as `{"package", "sections"}`."""
    found = []
    for module in extraction.get("modules") or ():
        sections = section_names(schema, extraction, module["name"])
        if sections:
            found.append({"package": module["name"], "sections": sections})
    return found


def build_graph(
    schema: Mapping[str, Any],
    extraction: Mapping[str, Any],
    package: str,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    base_namespace: str | None = None,
    empty: bool = False,
    *,
    exclude_prefixes: tuple[str, ...] = EXCLUDE_PREFIXES,
    max_nodes: int = MAX_NODES,
    max_depth: int = MAX_DEPTH,
) -> dict[str, Any]:
    """The graph of `package`, starting at `root` (a class title) or at every class the module exposes."""
    if empty:
        return {"package": package, "root": root, "nodes": [], "edges": []}
    if base_namespace is None:
        base_namespace = root_namespace(package)
    classes: Mapping[str, Mapping[str, Any]] = schema.get("classes") or {}
    records = {record["id"]: record for record in extraction.get("classes") or ()}
    memo: dict[str, list[str]] = {}

    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    edge_keys: set[tuple[str, str, str]] = set()
    seen: set[str] = set()

    def allowed(module: str) -> bool:
        if any(module.startswith(prefix) for prefix in exclude_prefixes):
            return False
        return allow_cross_module or module.startswith(base_namespace)

    def add_edge(source: str, target: str, kind: str, card: str | None = None) -> None:
        key = (source, target, kind)
        if key not in edge_keys:
            edge_keys.add(key)
            edges.append({"source": source, "target": target, "type": kind, "card": card})

    def add_section(name: str, depth: int = 0) -> None:
        if depth > max_depth or name in seen:
            return
        seen.add(name)
        cls = classes[name]
        module = class_module(name, cls)
        if not allowed(module):
            return
        nodes[name] = {
            "id": name, "kind": "section", "label": _title(name, cls),
            "doc": cls.get("description"), "module": module, "dtype": None, "shape": None, "card": None,
            "owner": None, "methods": _methods(records.get(name), base_namespace), **_class_details(cls),
        }
        if len(nodes) > max_nodes:
            return

        members = effective_attributes(name, classes, memo)
        if include_quantities:
            for _, slot in members:
                kind = annotation(slot, "source_kind")
                if kind not in QUANTITY_KINDS:
                    continue
                quantity_id = f"{name}.{slot['name']}"
                card = annotation(slot, "display_card")
                if quantity_id not in nodes:
                    nodes[quantity_id] = {
                        "id": quantity_id, "kind": "quantity", "label": slot["name"],
                        "doc": slot.get("description"), "module": module,
                        "dtype": annotation(slot, "display_dtype"), "shape": annotation(slot, "display_shape"),
                        "card": card, "owner": name, "methods": None, "unit": annotation(slot, "source_unit"),
                        **(_property_details(slot) if kind == "property" else {}),
                    }
                add_edge(name, quantity_id, "hasQuantity", card)
                if len(nodes) > max_nodes:
                    return
            for python_name, code, value in vocabulary_terms(name, schema, memo):
                term_id = f"{name}.{python_name}"
                if term_id not in nodes:
                    nodes[term_id] = {
                        "id": term_id, "kind": "quantity", "label": python_name,
                        "doc": value.get("description"), "module": module,
                        "dtype": VOCABULARY_TERM_DTYPE, "shape": None, "card": None, "owner": name,
                        "methods": None, "unit": None, **_term_details(code, value),
                    }
                add_edge(name, term_id, "hasQuantity", None)
                if len(nodes) > max_nodes:
                    return

        if include_inheritance:
            for ancestor in _mro(name, classes, memo)[1:]:
                if not allowed(class_module(ancestor, classes[ancestor])):
                    continue
                add_section(ancestor, depth + 1)
                add_edge(name, ancestor, "inherits")

        if include_subsections:
            for _, slot in members:
                if annotation(slot, "source_kind") != "subsection":
                    continue
                target = slot.get("range")
                if target not in classes or not allowed(class_module(target, classes[target])):
                    continue
                add_section(target, depth + 1)
                add_edge(name, target, "hasSubSection", annotation(slot, "display_card"))
                if len(nodes) > max_nodes:
                    return

    starts = [name for name in module_classes(extraction, package) if name in classes]
    if root:
        aliases = {alias: name for alias, name in module_aliases(extraction, package).items() if name in classes}
        matches = [aliases[root]] if root in aliases else [name for name in starts if _title(name, classes[name]) == root]
        if not matches:
            available = ", ".join(sorted({_title(name, classes[name]) for name in starts} | set(aliases))[:25])
            raise RootNotFound(f"Root section '{root}' not found in {package}. Available (first 25): {available}")
        add_section(matches[0], 0)
    else:
        for name in starts:
            add_section(name, 0)

    node_list = sorted(nodes.values(), key=lambda node: (node["kind"], node["module"] or "", node["label"]))
    edges.sort(key=lambda edge: (edge["source"], edge["type"], edge["target"]))
    return {
        "package": package,
        "root": root,
        "base_namespace": base_namespace,
        "nodes": node_list,
        "edges": edges,
    }


def usage_entries(extraction: Mapping[str, Any], section_id: str) -> list[dict[str, Any]] | None:
    """Normalizers and helpers acting on a class, as `/usage` lists them; None if the class is not in the document."""
    usage = extraction.get("usage") or {}
    if section_id in usage:
        return [
            {"kind": entry["kind"], "qualname": entry["qualname"], "module": entry["module"],
             "short_name": entry["short_name"], "doc": entry.get("doc")}
            for entry in usage[section_id]
        ]
    if any(record["id"] == section_id for record in extraction.get("classes") or ()):
        return []
    return None

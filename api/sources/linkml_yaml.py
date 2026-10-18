"""Write a LinkML schema held as plain JSON data as YAML.

Standard library and PyYAML only, so the same code can run in the browser.
Output is deterministic: element fields come in a fixed order, named maps
(classes, attributes, enums, ...) keep the order they were built in, and the
header names the profile, the source commit and the tool versions.

`export_schema` makes the schema fit for the standard LinkML generators
(`gen-pydantic`, `gen-python`, `linkml lint`). Only the download is changed:
the schema the app works with keeps its dotted names.
"""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

import yaml

# Field order inside an element (schema, class, slot, enum, ...). Fields not
# listed follow in alphabetical order.
FIELD_ORDER = (
    "id", "name", "text", "title", "description", "version", "license",
    "prefixes", "prefix_prefix", "prefix_reference", "default_prefix", "default_range", "imports",
    "class_uri", "slot_uri", "enum_uri", "is_a", "mixins", "abstract", "tree_root",
    "range", "multivalued", "required", "identifier", "minimum_value", "maximum_value",
    "ucum_code", "unit", "array", "exact_number_dimensions", "dimensions", "alias",
    "exact_cardinality", "minimum_cardinality", "maximum_cardinality",
    "permissible_values", "attributes", "annotations", "enums", "slots", "classes",
)
_RANK = {name: index for index, name in enumerate(FIELD_ORDER)}
# Fields whose value maps a name to an element; their own key order is kept.
NAMED_MAPS = frozenset({"prefixes", "enums", "classes", "slots", "types", "subsets",
                        "attributes", "permissible_values", "annotations"})


_NOT_IDENTIFIER = re.compile(r"[^A-Za-z0-9_]")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# The class an attribute gets when its source type has no LinkML type.
ANY_CLASS = "Any"


class ExportError(ValueError):
    """The schema has no export with valid, distinct class and enum names."""


def export_name(name: str) -> str:
    """A class or enum name as exported: every character other than a letter, digit or `_` becomes `_`."""
    return _NOT_IDENTIFIER.sub("_", name)


def export_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """The schema as downloaded: valid identifiers as class and enum names, and a range on every attribute.

    The dotted name of each class and enum is kept as its `source_id`
    annotation; `is_a`, `mixins`, enum `inherits` and attribute ranges use the
    new names. An attribute without a range (its source type has no LinkML
    type) gets the range `Any` (`linkml:Any`). `schema` is not changed.
    """
    classes = schema.get("classes") or {}
    enums = schema.get("enums") or {}
    renamed: dict[str, str] = {}
    taken: dict[str, str] = {}
    for name in [*classes, *enums]:
        new = export_name(name)
        if not _IDENTIFIER.fullmatch(new):
            raise ExportError(f"{name!r} has no valid LinkML name ({new!r})")
        if new in taken:
            raise ExportError(f"{taken[new]!r} and {name!r} would both be exported as {new!r}")
        renamed[name] = taken[new] = new

    def ref(name: str) -> str:
        return renamed.get(name, name)

    def element(name: str, value: Mapping[str, Any]) -> dict[str, Any]:
        return {**value, "name": renamed[name], "annotations": {"source_id": name, **(value.get("annotations") or {})}}

    untyped = False
    exported_classes: dict[str, Any] = {}
    for name, value in classes.items():
        cls = element(name, value)
        if "is_a" in cls:
            cls["is_a"] = ref(cls["is_a"])
        if "mixins" in cls:
            cls["mixins"] = [ref(base) for base in cls["mixins"]]
        if cls.get("attributes"):
            attributes = {}
            for slot_name, slot in cls["attributes"].items():
                slot = dict(slot)
                if slot.get("range"):
                    slot["range"] = ref(slot["range"])
                else:
                    slot["range"] = ANY_CLASS
                    untyped = True
                attributes[slot_name] = slot
            cls["attributes"] = attributes
        exported_classes[renamed[name]] = cls
    if untyped:
        if ANY_CLASS in taken:
            raise ExportError(f"{taken[ANY_CLASS]!r} would be exported as {ANY_CLASS!r}, the range of untyped attributes")
        exported_classes[ANY_CLASS] = {"name": ANY_CLASS, "class_uri": "linkml:Any"}

    exported_enums: dict[str, Any] = {}
    for name, value in enums.items():
        enum = element(name, value)
        if "inherits" in enum:
            enum["inherits"] = [ref(base) for base in enum["inherits"]]
        exported_enums[renamed[name]] = enum

    exported = dict(schema)
    if "classes" in schema or exported_classes:
        exported["classes"] = exported_classes
    if "enums" in schema:
        exported["enums"] = exported_enums
    return exported


def _ordered(value: Any, *, named: bool = False) -> Any:
    if isinstance(value, Mapping):
        if named:
            return {key: _ordered(item) for key, item in value.items()}
        keys = sorted(value, key=lambda key: (_RANK.get(key, len(_RANK)), key))
        return {key: _ordered(value[key], named=key in NAMED_MAPS) for key in keys}
    if isinstance(value, (list, tuple)):
        return [_ordered(item) for item in value]
    return value


class _Dumper(yaml.SafeDumper):
    """Block style for multi-line text, so descriptions stay readable."""


def _represent_str(dumper: yaml.SafeDumper, value: str) -> yaml.Node:
    style = "|" if "\n" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_Dumper.add_representer(str, _represent_str)


def header_lines(
    *,
    profile: str,
    source: Mapping[str, Any],
    tools: Mapping[str, str],
    edited: bool = False,
    report: Sequence[Mapping[str, str]] | None = None,
) -> list[str]:
    name = source.get("name") or profile
    version = source.get("version") or "unknown version"
    commit = source.get("commit") or "unknown commit"
    lines = [
        "LinkML schema exported by schema-studio" + (" (with edits)" if edited else ""),
        f"profile: {profile}",
        f"source: {name} {version}, commit {commit}",
        "tools: " + ", ".join(f"{tool} {tool_version}" for tool, tool_version in sorted(tools.items())),
    ]
    if report is not None:
        lines.append(report_summary(report))
    return lines


def report_summary(report: Sequence[Mapping[str, str]]) -> str:
    """One line saying how much of the source did not convert cleanly."""
    if not report:
        return "conversion report: everything converted"
    counts = Counter(row["status"] for row in report)
    order = ("partial", "skipped", "warning")
    parts = [f"{counts[status]} {status}" for status in order if counts[status]]
    parts += [f"{count} {status}" for status, count in sorted(counts.items()) if status not in order]
    return (
        "conversion report: " + ", ".join(parts)
        + " (partial: not fully expressed in LinkML; the source facts are kept as source_* annotations)"
    )


def dump_yaml(
    schema: Mapping[str, Any],
    *,
    profile: str,
    source: Mapping[str, Any],
    tools: Mapping[str, str],
    edited: bool = False,
    report: Sequence[Mapping[str, str]] | None = None,
) -> str:
    """The schema as YAML text, with a comment header naming its origin and, if given, a report summary."""
    lines = header_lines(profile=profile, source=source, tools=tools, edited=edited, report=report)
    header = "".join(f"# {line}\n" for line in lines)
    body = yaml.dump(
        # No line folding: one value per line keeps diffs between exports readable.
        _ordered(schema), Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=float("inf"),
        default_flow_style=False,
    )
    return header + body

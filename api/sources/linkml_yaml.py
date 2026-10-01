"""Write a LinkML schema held as plain JSON data as YAML.

Standard library and PyYAML only, so the same code can run in the browser.
Output is deterministic: element fields come in a fixed order, named maps
(classes, attributes, enums, ...) keep the order they were built in, and the
header names the profile, the source commit and the tool versions.
"""
from __future__ import annotations

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

"""NOMAD extraction document to a LinkML schema (plain JSON data).

Adapted from schematerial `src/schematerial/parsers/nomad_json.py` at commit
df3839b. The mapping is the same: the first base becomes `is_a`, further bases
`mixins`; each attribute becomes a class-local attribute with a class, enum or
LinkML type range; repeating subsections become `multivalued`; units and shapes
become UCUM units and array expressions; every source fact is kept as an
annotation (`source_kind`, `source_declaring_class`, `source_range`,
`source_type`, `source_unit`, `source_shape`, `source_annotations`).

Differences: one converter for nomad-simulations and nomad-measurements, with
the id prefix passed in; the display values from the extractor
(`display_dtype`, `display_card`, `display_shape`) are kept as their own
annotations; bounded NOMAD number types get their underlying type and, for
closed bounds, `minimum_value` / `maximum_value`; an inheritance mismatch or an
incomplete extraction is reported as `partial` instead of refusing the schema;
no reference to schematerial's core schema, no facets and no cache.
"""
from __future__ import annotations

import json
import re
from graphlib import CycleError, TopologicalSorter
from typing import Any

from extractor.contract import validate_document

from .common import (
    NAMESPACE_BASE,
    Conversion,
    ConversionError,
    Report,
    array,
    check_inheritance,
    element_id,
    json_text,
    permissible_values,
    prefixes,
    unit,
)

NOMAD_PREFIXES = {"nomad-simulations": "nomadsim", "nomad-measurements": "nomadmeas"}
DISPLAY_ANNOTATIONS = ("display_dtype", "display_card", "display_shape")

# (type_kind, type_data) -> LinkML type. None: kept as a source fact only.
TYPE_RANGES: dict[tuple[str, str], str | None] = {
    ("python", "str"): "string",
    ("python", "bool"): "boolean",
    ("python", "int"): "integer",
    ("python", "float"): "float",
    ("python", "complex"): None,
    ("numpy", "int32"): "integer",
    ("numpy", "int64"): "integer",
    ("numpy", "float32"): "float",
    ("numpy", "float64"): "double",
    ("numpy", "str_"): "string",
    ("numpy", "complex128"): None,
    ("custom", "nomad.metainfo.data_type.Datetime"): "datetime",
    ("custom", "nomad.metainfo.data_type.URL"): "uri",
    ("custom", "nomad.metainfo.data_type.Capitalized"): "string",
    ("custom", "nomad.metainfo.data_type.JSON"): None,
    ("custom", "nomad.metainfo.data_type.Any"): None,
    ("custom", "nomad.metainfo.data_type.Bytes"): None,
}
# Settings of a bounded number type that LinkML's minimum/maximum express exactly.
_PLAIN_BOUND = {"type_bound_clamp": False, "type_bound_on_violation": "raise", "type_bound_slack": 0.0}
_BOUND = re.compile(r"^([\[(])\s*([^,\s]*)\s*,\s*([^,\s\])]*)\s*([\])])$")


def _number(text: str) -> int | float:
    value = float(text)
    return int(value) if value.is_integer() and re.fullmatch(r"[+-]?\d+", text) else value


def _datatype(slot: dict[str, Any], raw: str, path: str, report: Report) -> None:
    """Set the LinkML range (and bounds) for a NOMAD datatype, or report what is lost."""
    try:
        data = json.loads(raw)
    except ValueError:
        # Raw Python/numpy names emitted for actual type objects.
        module, _, name = raw.rpartition(".")
        data = {"type_kind": "python" if module == "builtins" else module, "type_data": name}
    if not isinstance(data, dict) or not isinstance(data.get("type_kind"), str) or not isinstance(data.get("type_data"), str):
        report.partial(path, f"unmapped source type: {raw}")
        return
    extra = set(data) - {"type_kind", "type_data"}
    if "type_dtype" in data and "type_bound" in data:
        dtype = str(data["type_dtype"])
        target = TYPE_RANGES.get(("python", dtype)) or TYPE_RANGES.get(("numpy", dtype))
        extra -= {"type_dtype", "type_bound", *_PLAIN_BOUND}
        _bounds(slot, data, path, report)
    else:
        target = TYPE_RANGES.get((data["type_kind"], data["type_data"]))
    if target is None:
        report.partial(path, f"unmapped source type: {data['type_kind']} {data['type_data']}")
        return
    slot["range"] = target
    if extra:
        report.partial(path, f"source type settings kept in source_type only: {', '.join(sorted(extra))}")


def _bounds(slot: dict[str, Any], data: dict[str, Any], path: str, report: Report) -> None:
    """Closed bounds that NOMAD enforces strictly become minimum_value / maximum_value."""
    match = _BOUND.match(str(data["type_bound"]))
    if not match:
        report.partial(path, f"bound kept in source_type only: {data['type_bound']}")
        return
    # A clamped, logged-only or slack bound is not a hard limit; LinkML's would be.
    relaxed = [f"{name}={data[name]}" for name, plain in _PLAIN_BOUND.items() if name in data and data[name] != plain]
    if relaxed:
        report.partial(path, f"bound {data['type_bound']} kept in source_type only: {', '.join(relaxed)}")
        return
    opening, low, high, closing = match.groups()
    exclusive = []
    for text, inclusive, key in ((low, opening == "[", "minimum_value"), (high, closing == "]", "maximum_value")):
        if not text:
            continue
        if inclusive:
            slot[key] = _number(text)
        else:
            exclusive.append(text)
    if exclusive:
        report.partial(path, f"exclusive bound kept in source_type only: {', '.join(exclusive)}")


def _attribute(prefix: str, owner: str, raw: dict[str, Any], report: Report) -> dict[str, Any]:
    name = raw["name"]
    path = f"{owner}.{name}"
    range_ = raw["range"]
    slot: dict[str, Any] = {"name": name}
    if raw.get("description"):
        slot["description"] = raw["description"]
    slot["slot_uri"] = element_id(prefix, (owner, name))
    annotations: dict[str, str] = {
        "source_declaring_class": owner,
        "source_kind": raw["kind"],
        "source_range": json_text(range_),
    }
    if range_["kind"] == "datatype":
        annotations["source_type"] = range_["name"]
        _datatype(slot, range_["name"], path, report)
    else:
        slot["range"] = range_["name"]
    if raw["kind"] == "subsection":
        slot["multivalued"] = bool(raw.get("repeats"))
    if "unit" in raw:
        annotations["source_unit"] = raw["unit"]
        unit(slot, raw["unit"], path, report)
    if "shape" in raw:
        annotations["source_shape"] = json_text(raw["shape"])
        expression = array(raw["shape"], path, report)
        if expression is not None:
            slot["array"] = expression
    source_annotations = dict(raw.get("annotations") or {})
    # The extractor states the NOMAD type of enum quantities this way.
    if "source_type" in source_annotations and "source_type" not in annotations:
        annotations["source_type"] = str(source_annotations.pop("source_type"))
    for tag in DISPLAY_ANNOTATIONS:
        if tag in source_annotations:
            annotations[tag] = str(source_annotations.pop(tag))
    if source_annotations:
        annotations["source_annotations"] = json_text(source_annotations)
    slot["annotations"] = annotations
    return slot


def convert_nomad(document: dict[str, Any], *, prefix: str | None = None) -> Conversion:
    """Convert a validated NOMAD extraction document; the prefix follows from `source.name`."""
    document = validate_document(document)
    source = document["source"]
    prefix = prefix or NOMAD_PREFIXES.get(source["name"])
    if prefix is None:
        raise ConversionError(f"no LinkML prefix for source {source['name']!r}")
    report = Report(document["report"])
    records = {row["id"]: row for row in sorted(document["classes"], key=lambda row: row["id"])}
    try:
        tuple(TopologicalSorter({name: row["bases"] for name, row in records.items()}).static_order())
    except CycleError as error:
        raise ConversionError(f"inheritance cycle: {error.args[1]}") from error

    schema_annotations = {
        "source_name": source["name"],
        "source_module": source["module"],
        "source_dependencies": json_text(source["dependencies"]),
    }
    if source.get("commit"):
        schema_annotations["source_commit"] = source["commit"]
    schema: dict[str, Any] = {
        "id": f"{NAMESPACE_BASE}/{source['name']}/{source['module']}",
        "name": source["module"],
        "title": f"{source['name']} {source['module']}",
        "version": source["version"],
        "prefixes": prefixes(prefix),
        "default_prefix": prefix,
        "imports": ["linkml:types"],
        "annotations": schema_annotations,
        "enums": {
            row["id"]: {"name": row["id"], "permissible_values": permissible_values(row["values"])}
            for row in sorted(document["enums"], key=lambda row: row["id"])
        },
        "classes": {},
    }
    for name, row in records.items():
        cls: dict[str, Any] = {"name": name, "title": row["name"]}
        if row.get("description"):
            cls["description"] = row["description"]
        cls["class_uri"] = element_id(prefix, (name,))
        if row["bases"]:
            cls["is_a"] = row["bases"][0]
        if row["bases"][1:]:
            cls["mixins"] = list(row["bases"][1:])
        if row["attributes"]:
            # Source order is kept: it is the order the attributes are declared in.
            cls["attributes"] = {raw["name"]: _attribute(prefix, name, raw, report) for raw in row["attributes"]}
        annotations = {
            "source_bases": json_text(row["bases"]),
            "source_effective_attributes": json_text(sorted(row["effective_attributes"], key=lambda ref: ref["name"])),
        }
        if row.get("annotations"):
            annotations["source_annotations"] = json_text(row["annotations"])
        cls["annotations"] = annotations
        schema["classes"][name] = cls

    report.rows.extend(check_inheritance(
        schema, {name: row["effective_attributes"] for name, row in records.items()}
    ))
    return Conversion(schema=schema, report=report.rows)

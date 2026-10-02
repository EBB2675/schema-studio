"""bam-masterdata extraction document to a LinkML schema (plain JSON data).

Adapted from schematerial `src/schematerial/parsers/bam_json.py` at commit
df3839b. The mapping is the same: the first base becomes `is_a`, further bases
`mixins`; each property becomes a class-local attribute whose range is the
LinkML type of its openBIS data type, the vocabulary enum of a
`CONTROLLEDVOCABULARY` property or the object type of an `OBJECT` property;
`mandatory` becomes `required`; the property label becomes the attribute's
title; each vocabulary becomes an enum with the term codes as values;
descriptions written as `English//Deutsch` are split, the English half becoming
the description and the German half the annotation `description_de` (labels:
`title_de`); every source fact is kept as an annotation (`source_kind`,
`source_declaring_class`, `source_range`, `source_type`, `source_unit`,
`source_annotations`, `source_property_code`, `source_entity_code`).

Differences: plain JSON data instead of LinkML runtime objects; the display
values from the extractor (`display_dtype`, `display_card`) are kept as their
own annotations; a vocabulary links to its enum (`source_vocabulary_enum`), each
term keeps its Python attribute name (`source_python_name`), and a vocabulary
based on another one has an enum that `inherits` the other's; more exact unit
spellings; an incomplete extraction or an inheritance mismatch is reported as
`partial` instead of refusing the schema; no reference to schematerial's core
schema, no facets and no cache.
"""
from __future__ import annotations

import re
from graphlib import CycleError, TopologicalSorter
from typing import Any

from extractor.contract import validate_document

from .common import (
    NAMESPACE_BASE,
    Conversion,
    ConversionError,
    Report,
    check_inheritance,
    element_id,
    json_text,
    prefixes,
    unit,
)

BAM_PREFIX = "bammd"
BAM_SOURCE = "bam-masterdata"
DISPLAY_ANNOTATIONS = ("display_dtype", "display_card", "display_shape")

# openBIS data type to LinkML type. None: kept as a source fact only. A
# CONTROLLEDVOCABULARY or OBJECT property arrives here only when its target
# could not be resolved (the extractor reports that).
TYPE_RANGES: dict[str, str | None] = {
    "BOOLEAN": "boolean",
    "INTEGER": "integer",
    "REAL": "double",
    "VARCHAR": "string",
    "MULTILINE_VARCHAR": "string",
    "HYPERLINK": "uri",
    "DATE": "date",
    "TIMESTAMP": "datetime",
    "XML": None,
    "SAMPLE": None,
    "CONTROLLEDVOCABULARY": None,
    "OBJECT": None,
}

# Exact pint spellings found in bam-masterdata, and their UCUM codes. Anything
# not listed (for example `pixels` or `% (mm)`) stays a source fact and is reported.
UNIT_CODES = {
    "s": "s", "h": "h", "days": "d", "ns": "ns",
    "mm": "mm", "µm": "um", "μm": "um", "angstrom": "Ao", "cm^2": "cm2",
    "K": "K", "degC": "Cel", "degree": "deg", "degrees": "deg", "deg": "deg",
    "A": "A", "mA": "mA", "nA": "nA", "pA": "pA", "V": "V", "mV": "mV", "kV": "kV",
    "kW": "kW", "kN": "kN", "MPa": "MPa", "Hz": "Hz", "mT": "mT", "%": "%",
    "kg/m^3": "kg/m3", "MPa/s": "MPa/s", "degC/min": "Cel/min", "K/min": "K/min",
    "cm/min": "cm/min", "l/minute": "L/min", "% / mm": "%/mm", "s / h": "s/h", "mm*mrad": "mm.mrad",
}

# BAM writes texts as `English//Deutsch`. The separator is a run of slashes not
# preceded by `:` or `/`, so a URL keeps its own slashes; a run that is not
# exactly two slashes, or more than one run, is reported rather than split.
# Known limit: an English half ending in `:` right before `//` (`Options://Optionen`)
# reads as a URL scheme, so it is neither split nor reported.
LANGUAGE_SEPARATOR = re.compile(r"(?<![:/])/{2,}")


def split_bilingual(raw: str | None, path: str, kind: str, report: Report) -> tuple[str | None, str | None]:
    """English and German halves of a bilingual text, or the text unchanged and no German."""
    if not raw:
        return raw or None, None
    runs = LANGUAGE_SEPARATOR.findall(raw)
    if not runs:
        return raw, None
    halves = [half.strip() for half in LANGUAGE_SEPARATOR.split(raw)]
    if runs != ["//"] or not all(halves):
        report.partial(path, f"bilingual {kind} not split: expected one // between two non-empty halves")
        return raw, None
    return halves[0], halves[1]


def _attribute(owner: str, raw: dict[str, Any], report: Report) -> dict[str, Any]:
    name = raw["name"]
    path = f"{owner}.{name}"
    range_ = raw["range"]
    source_annotations = dict(raw.get("annotations") or {})
    display = {tag: str(source_annotations.pop(tag)) for tag in DISPLAY_ANNOTATIONS if tag in source_annotations}
    slot: dict[str, Any] = {"name": name}
    label = source_annotations.get("property_label")
    label = label.strip() if isinstance(label, str) else None
    # A `[unit]` suffix stays part of the label; it is never read as a unit.
    label_en, label_de = split_bilingual(label, path, "property label", report)
    if label_en:
        slot["title"] = label_en
    description, german = split_bilingual(raw.get("description"), path, "description", report)
    if description:
        slot["description"] = description
    slot["slot_uri"] = element_id(BAM_PREFIX, (owner, name))
    annotations: dict[str, str] = {
        "source_declaring_class": owner,
        "source_kind": raw["kind"],
        "source_range": json_text(range_),
    }
    if range_["kind"] == "datatype":
        annotations["source_type"] = range_["name"]
        target = TYPE_RANGES.get(range_["name"])
        if target is None:
            known = range_["name"] in TYPE_RANGES
            report.partial(path, f"{'unsupported' if known else 'unmapped'} source type: {range_['name']}")
        else:
            slot["range"] = target
    else:
        slot["range"] = range_["name"]
    if source_annotations.get("mandatory") is True:
        slot["required"] = True
    if "unit" in raw:
        annotations["source_unit"] = raw["unit"]
        unit(slot, raw["unit"], path, report, UNIT_CODES)
    if isinstance(source_annotations.get("property_code"), str):
        annotations["source_property_code"] = source_annotations["property_code"]
    if german is not None:
        annotations["description_de"] = german
    if label_de is not None:
        annotations["title_de"] = label_de
    annotations.update(display)
    if raw.get("description"):
        # The bilingual original stays with the other source facts.
        source_annotations["description"] = raw["description"]
    if source_annotations:
        annotations["source_annotations"] = json_text(source_annotations)
    slot["annotations"] = annotations
    return slot


def _permissible_values(enum_id: str, values: list[Any], report: Report) -> dict[str, dict[str, Any]]:
    """Vocabulary terms in source order: code as the value, label as title, English description."""
    result: dict[str, dict[str, Any]] = {}
    for value in values:
        if isinstance(value, str):
            result[value] = {}
            continue
        path = f"{enum_id}.{value['value']}"
        entry: dict[str, Any] = {}
        title, title_de = split_bilingual(value.get("title"), path, "term label", report)
        if title:
            entry["title"] = title
        description, german = split_bilingual(value.get("description"), path, "description", report)
        if description:
            entry["description"] = description
        source_annotations = dict(value.get("annotations") or {})
        annotations: dict[str, str] = {}
        if isinstance(source_annotations.get("python_name"), str):
            annotations["source_python_name"] = source_annotations.pop("python_name")
        if german is not None:
            annotations["description_de"] = german
        if title_de is not None:
            annotations["title_de"] = title_de
        for key in ("title", "description"):
            if value.get(key):
                source_annotations[key] = value[key]
        if source_annotations:
            annotations["source_annotations"] = json_text(source_annotations)
        if annotations:
            entry["annotations"] = annotations
        result[value["value"]] = entry
    return result


def convert_bam(document: dict[str, Any], *, prefix: str | None = None) -> Conversion:
    """Convert a validated bam-masterdata extraction document."""
    document = validate_document(document)
    source = document["source"]
    prefix = prefix or BAM_PREFIX
    if prefix != BAM_PREFIX:
        raise ConversionError(f"bam-masterdata uses the id prefix {BAM_PREFIX!r}, not {prefix!r}")
    report = Report(document["report"])
    records = {row["id"]: row for row in sorted(document["classes"], key=lambda row: row["id"])}
    try:
        tuple(TopologicalSorter({name: row["bases"] for name, row in records.items()}).static_order())
    except CycleError as error:
        raise ConversionError(f"inheritance cycle: {error.args[1]}") from error

    vocabulary_enum = {
        name: str(row["annotations"]["vocabulary_enum"])
        for name, row in records.items() if (row.get("annotations") or {}).get("vocabulary_enum")
    }
    enums: dict[str, Any] = {}
    for row in sorted(document["enums"], key=lambda row: row["id"]):
        enums[row["id"]] = {"name": row["id"], "permissible_values": _permissible_values(row["id"], row["values"], report)}
    for name, enum_name in vocabulary_enum.items():
        if enum_name not in enums:
            continue
        # A vocabulary based on another one also offers the other's terms.
        inherited = [vocabulary_enum[base] for base in records[name]["bases"] if vocabulary_enum.get(base) in enums]
        if inherited:
            enums[enum_name]["inherits"] = inherited
        enums[enum_name]["annotations"] = {"source_vocabulary_class": name}

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
        "enums": enums,
        "classes": {},
    }
    for name, row in records.items():
        cls: dict[str, Any] = {"name": name, "title": row["name"]}
        description, german = split_bilingual(row.get("description"), name, "description", report)
        if description:
            cls["description"] = description
        cls["class_uri"] = element_id(prefix, (name,))
        if row["bases"]:
            cls["is_a"] = row["bases"][0]
        if row["bases"][1:]:
            cls["mixins"] = list(row["bases"][1:])
        if row["attributes"]:
            cls["attributes"] = {raw["name"]: _attribute(name, raw, report) for raw in row["attributes"]}
        source_annotations = dict(row.get("annotations") or {})
        annotations = {
            "source_bases": json_text(row["bases"]),
            # In source order: the graph follows it.
            "source_effective_attributes": json_text(row["effective_attributes"]),
        }
        if german is not None:
            annotations["description_de"] = german
        if isinstance(source_annotations.get("code"), str):
            annotations["source_entity_code"] = source_annotations["code"]
        if vocabulary_enum.get(name) in enums:
            annotations["source_vocabulary_enum"] = vocabulary_enum[name]
        if row.get("description"):
            source_annotations["description"] = row["description"]
        if source_annotations:
            annotations["source_annotations"] = json_text(source_annotations)
        cls["annotations"] = annotations
        schema["classes"][name] = cls

    report.rows.extend(check_inheritance(
        schema, {name: row["effective_attributes"] for name, row in records.items()}
    ))
    return Conversion(schema=schema, report=report.rows)

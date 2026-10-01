"""Helpers shared by the converters: ids, annotations, units, shapes, inheritance check.

Adapted from schematerial at commit df3839b:

- `src/schematerial/identity.py`: element ids (`element_id`, segment escaping)
  and the per-source prefixes;
- `src/schematerial/parsers/nomad_json.py`: the unit table (`UNIT_CODES`,
  `REFUSED_UNITS`), the array shapes and the inheritance check (`verify`);
- `src/schematerial/parsers/_shared.py`: permissible values.

Differences: schemas are built as plain JSON data (dicts and lists) instead of
LinkML runtime objects, so the graph adapter and the YAML export can work on
them without `linkml-runtime`. `linkml-runtime` is only used here to load the
finished schema into a SchemaView for the inheritance check. An inheritance
mismatch is reported as `partial` for the attribute concerned; the schema is
not refused. The unit table has more exact spellings, symbolic and open
dimensions keep their names as array aliases, and nothing refers to
schematerial's own core schema.
"""
from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

# Per-source prefixes, the same as schematerial's, so ids stay comparable.
PREFIXES = ("nomadsim", "nomadmeas", "bammd")
# The GitHub Pages site of schema-studio; ids need not resolve, only stay stable.
NAMESPACE_BASE = "https://ebb2675.github.io/schema-studio/linkml"
LINKML_PREFIX = {"linkml": "https://w3id.org/linkml/"}

# Exact spellings only: no dimensional analysis, no unit registry. A spelling
# that is not listed stays a source fact and is reported as `partial`.
UNIT_CODES = {
    # from schematerial
    "meter": "m", "meter ** 2": "m2", "meter ** 3": "m3", "1 / meter": "/m",
    "joule": "J", "1 / joule": "/J", "second": "s", "meter / second": "m/s",
    "kilogram": "kg", "kelvin": "K", "newton": "N", "electron_volt": "eV",
    "mole / liter": "mol/L",
    # base and derived units, decimal multiples
    "ampere": "A", "milliampere": "mA", "coulomb": "C", "volt": "V", "watt": "W",
    "ohm": "Ohm", "hertz": "Hz", "pascal": "Pa", "radian": "rad", "degree": "deg",
    "lux": "lx", "gauss": "G", "angstrom": "Ao", "nanometer": "nm", "millimeter": "mm",
    "picosecond": "ps", "dimensionless": "1", "elementary_charge": "[e]",
    "unified_atomic_mass_unit": "u",
    # compound spellings found in nomad-simulations and nomad-measurements
    "1 / second": "/s", "1 / picosecond": "/ps", "1 / kelvin": "/K", "1 / pascal": "/Pa",
    "1 / meter ** 2": "/m2", "1 / meter ** 3": "/m3",
    "meter ** 2 / second": "m2/s", "meter ** 3 / second": "m3/s", "meter ** 2 / gram": "m2/g",
    "joule / kelvin": "J/K", "joule / kilogram": "J/kg", "joule / meter": "J/m",
    "joule / meter ** 2": "J/m2", "joule / meter ** 3": "J/m3", "joule / radian": "J/rad",
    "joule / radian ** 2": "J/rad2", "joule / meter / radian": "J/m/rad",
    "joule / kelvin / kilogram": "J/K/kg", "kilogram / meter ** 3": "kg/m3",
    "coulomb * meter": "C.m", "coulomb / meter ** 3": "C/m3", "kelvin * watt / meter": "K.W/m",
    "watt / meter ** 2": "W/m2", "ampere / meter ** 2": "A/m2", "ohm / centimeter": "Ohm/cm",
    "mole / gram / second": "mol/g/s", "mole / meter ** 2 / second": "mol/m2/s",
    "milliliter / gram / second": "mL/g/s",
}

# NOMAD's registry and BAM's stock pint registry disagree on these spellings.
# Refused until a reviewed unit table records what each one is meant to be.
REFUSED_UNITS = {"rpm", "px", "dpi", "dB"}

_WHITESPACE = re.compile(r"\s")


class ConversionError(ValueError):
    """An extraction document that cannot be converted at all (not a partial gap)."""


@dataclass
class Conversion:
    """A LinkML schema as plain JSON data, and the report of what did not convert cleanly."""

    schema: dict[str, Any]
    report: list[dict[str, str]] = field(default_factory=list)


class Report:
    """Collects report rows in the contract's shape: path, status, reason."""

    def __init__(self, rows: Iterable[Mapping[str, str]] = ()) -> None:
        self.rows = [dict(row) for row in rows]

    def partial(self, path: str, reason: str) -> None:
        self.rows.append({"path": path, "status": "partial", "reason": reason})


# -------- ids --------

def _segment(segment: str, *, within: Sequence[str]) -> str:
    if not segment or _WHITESPACE.search(segment) or "[" in segment or "]" in segment:
        raise ConversionError(f"{'.'.join(within)!r}: {segment!r} cannot be part of an element id")
    return segment.replace("%", "%25").replace(".", "%2E")


def element_id(prefix: str, segments: Sequence[str]) -> str:
    """`<prefix>:<segment>.<segment>`, with dots inside a segment escaped as `%2E`."""
    if prefix not in PREFIXES:
        raise ConversionError(f"unknown id prefix {prefix!r}; known: {', '.join(PREFIXES)}")
    return f"{prefix}:" + ".".join(_segment(segment, within=segments) for segment in segments)


def prefixes(prefix: str) -> dict[str, str]:
    return {**LINKML_PREFIX, prefix: f"{NAMESPACE_BASE}/{prefix}/"}


# -------- annotations --------

def json_text(value: Any) -> str:
    """Structured source facts are kept as sorted JSON text, so they read back unchanged."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def permissible_values(values: Iterable[str | Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Enum values in source order, keeping the title, description and annotations a source states."""
    result: dict[str, dict[str, Any]] = {}
    for value in values:
        if isinstance(value, str):
            result[value] = {}
            continue
        entry: dict[str, Any] = {}
        for key in ("title", "description"):
            if value.get(key) is not None:
                entry[key] = value[key]
        if value.get("annotations"):
            # JSON text, so a boolean or numeric source fact reads back as what it was.
            entry["annotations"] = {tag: json_text(item) for tag, item in sorted(value["annotations"].items())}
        result[value["value"]] = entry
    return result


# -------- units and shapes --------

def unit(
    slot: dict[str, Any], source_unit: str, path: str, report: Report, codes: Mapping[str, str] = UNIT_CODES,
) -> None:
    """Set the UCUM unit for an exact known spelling (from `codes`); otherwise report it."""
    code = codes.get(source_unit)
    if source_unit in REFUSED_UNITS:
        report.partial(path, f"refused source unit: {source_unit}; source registries disagree about this spelling")
    elif code is None:
        report.partial(path, f"unmapped source unit: {source_unit}")
    else:
        slot["unit"] = {"ucum_code": code}


_CARDINALITY_RANGE = re.compile(r"^(\d+)\.\.(\d+|\*)$")


def array(shape: Sequence[int | str], path: str, report: Report) -> dict[str, Any] | None:
    """An array expression for a non-empty shape; None for a scalar.

    Integer dimensions become exact cardinalities, `*` an open dimension and
    `a..b` a cardinality range. A dimension named after another quantity (for
    example `n_atoms`) keeps its name as the alias, but LinkML cannot say that
    two dimensions must be equal, so it is reported as `partial`.
    """
    if not shape:
        return None
    dimensions: list[dict[str, Any]] = []
    symbolic: list[str] = []
    for index, dim in enumerate(shape):
        if isinstance(dim, int):
            dimensions.append({"alias": f"axis_{index}", "exact_cardinality": dim})
        elif dim == "*":
            dimensions.append({"alias": f"axis_{index}"})
        elif match := _CARDINALITY_RANGE.match(dim):
            entry: dict[str, Any] = {"alias": f"axis_{index}", "minimum_cardinality": int(match.group(1))}
            if match.group(2) != "*":
                entry["maximum_cardinality"] = int(match.group(2))
            dimensions.append(entry)
        else:
            dimensions.append({"alias": dim})
            symbolic.append(dim)
    if symbolic:
        report.partial(path, f"symbolic shape dimensions kept as names only: {', '.join(symbolic)}")
    return {"exact_number_dimensions": len(shape), "dimensions": dimensions}


# -------- inheritance check --------

_SIGNATURE_FIELDS = ("description", "range", "multivalued", "required", "minimum_value", "maximum_value")


def _plain(value: Any) -> Any:
    from linkml_runtime.dumpers import json_dumper

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return json.loads(json_dumper.dumps(value, inject_type=False))


def _signature(slot: Any) -> dict[str, Any]:
    """What must agree between an inherited LinkML slot and the source's own declaration."""
    signature = {name: _plain(getattr(slot, name, None)) for name in _SIGNATURE_FIELDS}
    for flag in ("multivalued", "required"):
        signature[flag] = bool(signature[flag])
    signature["unit"] = slot.unit.ucum_code if slot.unit is not None else None
    signature["array"] = _plain(slot.array)
    signature["annotations"] = _annotation_values(slot.annotations)
    return signature


def _annotation_values(annotations: Any) -> dict[str, str]:
    """Tag -> value text. Induced slots carry their annotations as JsonObj, local ones as a dict."""
    import jsonasobj2

    if not annotations:
        return {}
    pairs = annotations.items() if isinstance(annotations, dict) else jsonasobj2.items(annotations)
    values: dict[str, str] = {}
    for tag, item in pairs:
        if isinstance(item, jsonasobj2.JsonObj):
            item = jsonasobj2.as_dict(item)
        value = item.get("value") if isinstance(item, dict) else getattr(item, "value", item)
        values[str(tag)] = str(value)
    return values


def _short(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= 120 else text[:117] + "..."


def check_inheritance(schema: dict[str, Any], effective: Mapping[str, Sequence[Mapping[str, str]]]) -> list[dict[str, str]]:
    """Compare LinkML's induced attributes with the source's effective attributes.

    `effective` maps each class name to its `effective_attributes` entries
    (`name`, `declaring_class_id`). Every difference becomes one `partial`
    row for that class and attribute; the schema itself is left as it is.
    """
    from linkml_runtime.linkml_model.meta import SchemaDefinition
    from linkml_runtime.loaders import yaml_loader
    from linkml_runtime.utils.schemaview import SchemaView

    definition = yaml_loader.load_any(copy.deepcopy(schema), target_class=SchemaDefinition)
    view = SchemaView(definition)
    rows: list[dict[str, str]] = []
    declared: dict[tuple[str, str], dict[str, Any]] = {}

    def own(class_name: str, attribute: str) -> dict[str, Any]:
        key = (class_name, attribute)
        if key not in declared:
            declared[key] = _signature(view.get_class(class_name).attributes[attribute])
        return declared[key]

    for class_name in sorted(effective):
        induced = {str(slot.name): slot for slot in view.class_induced_slots(class_name)}
        expected = {ref["name"]: ref["declaring_class_id"] for ref in effective[class_name]}
        for name in sorted(induced.keys() | expected.keys()):
            path = f"{class_name}.{name}"
            if name not in induced:
                rows.append({"path": path, "status": "partial",
                             "reason": "inheritance mismatch: the source has this attribute, LinkML does not inherit it"})
                continue
            if name not in expected:
                rows.append({"path": path, "status": "partial",
                             "reason": "inheritance mismatch: LinkML inherits this attribute, the source does not have it"})
                continue
            observed = _signature(induced[name])
            wanted = own(expected[name], name)
            differing = [key for key in wanted if observed.get(key) != wanted[key]]
            if differing:
                details = "; ".join(
                    f"{key}: LinkML {_short(observed.get(key))}, source {_short(wanted[key])}" for key in differing
                )
                rows.append({"path": path, "status": "partial", "reason": f"inheritance mismatch: {details}"})
    return rows

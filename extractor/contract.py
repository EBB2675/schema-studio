"""Validate extraction documents without importing a schema package.

Adapted from schematerial `src/schematerial/extraction/contract.py` at commit
df3839b. Differences: the JSON schema is read from the file next to this module,
there is a single contract version with the requirements of schematerial's
contract 1.2, and the cross-reference checks also cover the fields schema-studio
adds (methods, modules and usage).

An extraction document is what a script in `extractor/scripts/` prints for one
schema; see `contract.schema.json` for its shape.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError, validators

CONTRACT_VERSION = "1.0"
SCHEMA_PATH = Path(__file__).with_name("contract.schema.json")

_SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _unique_items(validator, unique, instance, schema):
    """`uniqueItems` in linear time: jsonschema compares every pair, which takes
    minutes for vocabularies with thousands of terms. Items are JSON data, so
    their sorted JSON text identifies them."""
    if not unique or not validator.is_type(instance, "array"):
        return
    seen: set[str] = set()
    for item in instance:
        key = json.dumps(item, sort_keys=True)
        if key in seen:
            yield ValidationError(f"{instance!r} has non-unique elements")
            return
        seen.add(key)


_VALIDATOR = validators.extend(Draft202012Validator, {"uniqueItems": _unique_items})(_SCHEMA)


class ContractError(ValueError):
    """Invalid extraction output, with JSON paths identifying the problem."""


def enum_value(value: str | dict[str, Any]) -> str:
    """The value an enum entry names, whether or not it carries metadata."""
    return value if isinstance(value, str) else value["value"]


def _unique(values: list[str], path: str) -> None:
    seen: set[str] = set()
    for index, value in enumerate(values):
        if value in seen:
            raise ContractError(f"{path}[{index}]: duplicate identifier {value!r}")
        seen.add(value)


def validate_document(document: Any) -> dict[str, Any]:
    """Return the document unchanged if it follows the contract, else raise ContractError."""
    errors = sorted(_VALIDATOR.iter_errors(document), key=lambda error: str(error.json_path))
    if errors:
        raise ContractError("\n".join(f"{error.json_path}: {error.message}" for error in errors))

    classes = document["classes"]
    enums = document["enums"]
    _unique([item["id"] for item in classes], "$.classes")
    _unique([item["id"] for item in enums], "$.enums")
    # A value may be spelled plainly or carry metadata; both name the same value.
    for index, item in enumerate(enums):
        _unique([enum_value(value) for value in item["values"]], f"$.enums[{index}].values")
    class_ids = {item["id"] for item in classes}
    enum_ids = {item["id"] for item in enums}
    declarations = {
        (cls["id"], attribute["name"]): attribute["kind"]
        for cls in classes for attribute in cls["attributes"]
    }
    for index, cls in enumerate(classes):
        path = f"$.classes[{index}]"
        _unique(cls["bases"], f"{path}.bases")
        _unique([item["name"] for item in cls["attributes"]], f"{path}.attributes")
        _unique([item["name"] for item in cls.get("methods", [])], f"{path}.methods")
        effective = cls["effective_attributes"]
        _unique([item["name"] for item in effective], f"{path}.effective_attributes")
        for ref_index, reference in enumerate(effective):
            key = (reference["declaring_class_id"], reference["name"])
            if declarations.get(key) != reference["kind"]:
                raise ContractError(
                    f"{path}.effective_attributes[{ref_index}]: "
                    f"no matching local {reference['kind']} declaration {key!r}"
                )
        for base_index, base in enumerate(cls["bases"]):
            if base not in class_ids:
                raise ContractError(f"{path}.bases[{base_index}]: unknown class {base!r}")
        for attr_index, attribute in enumerate(cls["attributes"]):
            range_ = attribute["range"]
            allowed = {"class": class_ids, "enum": enum_ids}.get(range_["kind"])
            if allowed is not None and range_["name"] not in allowed:
                raise ContractError(
                    f"{path}.attributes[{attr_index}].range.name: "
                    f"unknown {range_['kind']} {range_['name']!r}"
                )
            if attribute["kind"] == "subsection" and (
                range_["kind"] != "class" or "repeats" not in attribute
            ):
                raise ContractError(
                    f"{path}.attributes[{attr_index}]: subsection requires class range and repeats"
                )

    modules = document.get("modules", [])
    _unique([item["name"] for item in modules], "$.modules")
    for index, module in enumerate(modules):
        path = f"$.modules[{index}].classes"
        _unique(module["classes"], path)
        for class_index, class_id in enumerate(module["classes"]):
            if class_id not in class_ids:
                raise ContractError(f"{path}[{class_index}]: unknown class {class_id!r}")
        for binding, class_id in module.get("names", {}).items():
            if class_id not in module["classes"]:
                raise ContractError(f"$.modules[{index}].names.{binding}: {class_id!r} is not a class of the module")
    for class_id in document.get("usage", {}):
        if class_id not in class_ids:
            raise ContractError(f"$.usage: unknown class {class_id!r}")
    return document


def read_document(content: str) -> dict[str, Any]:
    """Read strict JSON: duplicate keys and non-finite numbers are errors."""
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in items:
            if key in result:
                raise ContractError(f"$: duplicate JSON key {key!r}")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise ContractError(f"$: invalid JSON number {value}")

    def finite_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ContractError(f"$: non-finite JSON number {value}")
        return number

    try:
        document = json.loads(
            content, object_pairs_hook=pairs, parse_constant=invalid_constant,
            parse_float=finite_float,
        )
    except json.JSONDecodeError as error:
        raise ContractError(
            f"$: invalid JSON at line {error.lineno}, column {error.colno}"
        ) from error
    return validate_document(document)

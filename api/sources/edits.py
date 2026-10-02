"""Edit operations on a LinkML schema held as plain JSON data.

Plain data in and out, standard library only, so the same code can run in the
browser. Where edits are stored (SQLite on the server, browser storage in
static mode) is not decided here: an edit is a plain dict, and replaying a
list of them onto the freshly converted schema gives the edited schema, which
the graph adapter and the YAML export then read.

An edit:

    {"op": "add_attribute", "target": "<class or enum name>", "payload": {...},
     "profile": "nomad-simulations", "commit": "<schema commit it was made on>"}

plus whatever its store adds (`id`, `package`, times). `prepare_edit` checks a
new edit against the current schema and the profile's rules and fills in
everything it derives (the id of a new class, an attribute name derived from a
code, the value a `set_*` edit replaces), so replaying it later needs nothing
but the stored edit.

Operations (`target` is a class name unless noted):

- `add_class` (target: the new class's name, `<module>.<Name>`):
  `is_a`, `description`; bam-masterdata also `code`, `description_de`;
- `rename_class`: `new_name`; references (bases, ranges, the class's
  vocabulary enum) follow, and the class keeps its source id in the
  annotation `source_class`, so its module bindings, methods and usage stay;
- `remove_class`: refused while anything still refers to the class;
- `add_attribute`: NOMAD `name`, `kind` (`quantity` with `dtype`, or
  `subsection` with `range` and `multivalued`), `description`;
  bam-masterdata `code`, `data_type`, `range` (the object type or vocabulary
  class of an OBJECT or CONTROLLEDVOCABULARY property), `mandatory`, `label`,
  `section`, `description`, `description_de`, optional `name`;
- `rename_attribute`: `attribute`, `new_name`;
- `remove_attribute`: `attribute`;
- `set_range`: `attribute` and the same type fields as `add_attribute`;
- `set_description`: `description` (and `description_de` for
  bam-masterdata) of the class, of its `attribute`, or of an enum `value`;
- `set_required`: `attribute`, `required`;
- `add_enum_value`, `remove_enum_value` (target: an enum, or a
  bam-masterdata vocabulary class): `value`; bam-masterdata terms also
  `label`, `description`, optional `name` (the Python name).

Attributes are edited on the class that declares them; on a class that
inherits them they are read-only. New elements get the annotations extracted
ones have (source facts, display values, ids) and `edit_added`, so the graph
shows them the same way.
"""
from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, NamedTuple

OPS = (
    "add_class", "rename_class", "remove_class",
    "add_attribute", "rename_attribute", "remove_attribute",
    "set_range", "set_description", "set_required",
    "add_enum_value", "remove_enum_value",
)
SET_OPS = ("set_range", "set_description", "set_required")
ADDED = "edit_added"

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# bam-masterdata: uppercase segments separated by dots; `$` marks codes native to openBIS.
_BAM_CODE = re.compile(r"^[A-Z0-9_]+(\.[A-Z0-9_]+)*$")
BAM_TERM_CODE_LIMIT = 50


class EditError(ValueError):
    """An edit that cannot be applied to the schema; `reason` is a short machine-readable word."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


# -------- profile rules --------

def _nomad_type(kind: str, data: str) -> str:
    """The extractor's text for a NOMAD datatype (`range.name`, annotation `source_type`)."""
    return json.dumps({"type_data": data, "type_kind": kind}, sort_keys=True)


# Editable NOMAD dtypes: the name offered, the NOMAD type, its LinkML range and
# the text NOMAD shows for it (what the extractor puts in `display_dtype`).
NOMAD_DTYPES: dict[str, dict[str, str]] = {
    name: {"source_type": _nomad_type(kind, data), "range": linkml, "display": display}
    for name, kind, data, linkml, display in (
        ("bool", "python", "bool", "boolean", "m_bool(bool)"),
        ("str", "python", "str", "string", "m_str(str)"),
        ("datetime", "custom", "nomad.metainfo.data_type.Datetime", "datetime", "Datetime"),
        ("int", "python", "int", "integer", "m_int32(int)"),
        ("float", "python", "float", "float", "m_float64(float)"),
        ("int32", "numpy", "int32", "integer", "m_int32(int32)"),
        ("int64", "numpy", "int64", "integer", "m_int64(int64)"),
        ("float32", "numpy", "float32", "float", "m_float32(float32)"),
        ("float64", "numpy", "float64", "double", "m_float64(float64)"),
    )
}

# openBIS data types and their LinkML ranges, as the bam-masterdata converter maps them.
BAM_DATA_TYPES: dict[str, str | None] = {
    "BOOLEAN": "boolean",
    "CONTROLLEDVOCABULARY": None,
    "DATE": "date",
    "HYPERLINK": "uri",
    "INTEGER": "integer",
    "MULTILINE_VARCHAR": "string",
    "OBJECT": None,
    "REAL": "double",
    "SAMPLE": None,
    "TIMESTAMP": "datetime",
    "VARCHAR": "string",
    "XML": None,
}

RULE_SETS = ("nomad", "bam-masterdata")


def rules_summary(rules: str) -> dict[str, Any]:
    """What a client needs to offer edits for a rule set: the type choices and which fields are asked for."""
    if rules == "nomad":
        return {
            "name": rules,
            "attribute_kinds": ["quantity", "subsection"],
            "dtypes": [{"name": name, "display": spec["display"]} for name, spec in NOMAD_DTYPES.items()],
            "codes": False,
        }
    if rules == "bam-masterdata":
        return {
            "name": rules,
            "attribute_kinds": ["property"],
            "dtypes": [{"name": name, "display": name, "needs_range": name in ("OBJECT", "CONTROLLEDVOCABULARY")}
                       for name in BAM_DATA_TYPES],
            "codes": True,
            "term_code_limit": BAM_TERM_CODE_LIMIT,
        }
    raise EditError("invalid", f"unknown edit rules {rules!r}")


def bam_class_name(code: str) -> str:
    """The class name bam-masterdata derives from an object type code (`code_to_class_name`)."""
    return "".join(part.capitalize() for part in code.lstrip("$").rsplit(".")[-1].split("_"))


def bam_attribute_name(code: str) -> str:
    """The Python name bam-masterdata gives a property or term in nearly every case: the code in lower case."""
    return code.lstrip("$").lower().replace(".", "_")


# -------- plain-data helpers --------

def annotation(element: Mapping[str, Any], tag: str) -> str | None:
    value = (element.get("annotations") or {}).get(tag)
    if isinstance(value, Mapping):
        value = value.get("value")
    return None if value is None else str(value)


def _json_annotation(element: Mapping[str, Any], tag: str) -> Any:
    text = annotation(element, tag)
    return None if text is None else json.loads(text)


def _set_annotation(element: dict[str, Any], tag: str, value: Any) -> None:
    annotations = element.setdefault("annotations", {})
    if value is None:
        annotations.pop(tag, None)
        if not annotations:
            element.pop("annotations")
    else:
        annotations[tag] = value


def _json_text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _segment(segment: str) -> str:
    return segment.replace("%", "%25").replace(".", "%2E")


def _element_id(schema: Mapping[str, Any], *segments: str) -> str | None:
    """`<prefix>:<segment>.<segment>`, as the converters build `class_uri` and `slot_uri`."""
    prefix = schema.get("default_prefix")
    return f"{prefix}:" + ".".join(_segment(segment) for segment in segments) if prefix else None


def _text(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise EditError("invalid", f"{key} must be text")
    return value.strip() or None


def _required_text(payload: Mapping[str, Any], key: str) -> str:
    value = _text(payload, key)
    if not value:
        raise EditError("invalid", f"{key} is required")
    return value


def _identifier(value: str, what: str) -> str:
    if not _IDENTIFIER.match(value):
        raise EditError("invalid", f"{what} {value!r} is not a valid name (letters, digits and _, not starting with a digit)")
    return value


def _bam_code(value: str, what: str) -> str:
    if not _BAM_CODE.match(value):
        raise EditError(
            "invalid",
            f"{what} {value!r} must be upper case letters, digits and _, in segments separated by dots"
            " (codes starting with $ are reserved for openBIS)",
        )
    return value


def _title(name: str, cls: Mapping[str, Any]) -> str:
    return cls.get("title") or name.rpartition(".")[2]


def _module(name: str, cls: Mapping[str, Any]) -> str:
    title = cls.get("title")
    if title and name.endswith(f".{title}"):
        return name[: -len(title) - 1]
    return name.rpartition(".")[0]


def _classes(schema: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return schema.setdefault("classes", {})


def _class(schema: Mapping[str, Any], name: str) -> dict[str, Any]:
    cls = (schema.get("classes") or {}).get(name)
    if cls is None:
        raise EditError("not_found", f"class {name!r} is not in the schema")
    return cls


def _ancestors(classes: Mapping[str, Mapping[str, Any]], name: str) -> list[str]:
    """Every base of a class (through `is_a` and `mixins`), nearest first, the class itself excluded."""
    found: list[str] = []
    pending = [name]
    while pending:
        current = classes.get(pending.pop(0)) or {}
        for base in [current.get("is_a"), *(current.get("mixins") or [])]:
            if base and base in classes and base not in found and base != name:
                found.append(base)
                pending.append(base)
    return found


def _inherited_from(classes: Mapping[str, Mapping[str, Any]], name: str, attribute: str) -> str | None:
    for ancestor in _ancestors(classes, name):
        if attribute in (classes[ancestor].get("attributes") or {}):
            return ancestor
    return None


def _declared(schema: Mapping[str, Any], name: str, attribute: str) -> dict[str, Any]:
    """An attribute the class declares itself; an inherited one is edited on its declaring class."""
    classes = schema.get("classes") or {}
    cls = _class(schema, name)
    slot = (cls.get("attributes") or {}).get(attribute)
    if slot is not None:
        return slot
    owner = _inherited_from(classes, name, attribute)
    if owner is not None:
        raise EditError("inherited", f"{attribute!r} is inherited from {_title(owner, classes[owner])}; edit it there")
    raise EditError("not_found", f"{_title(name, cls)} has no attribute {attribute!r}")


class Reference(NamedTuple):
    """A use of a class or enum: as a base of `owner`, as the range of `owner.attribute`, or as an enum's base."""

    owner: str
    kind: str  # "base", "range" or "enum_base"
    attribute: str | None = None

    def describe(self, schema: Mapping[str, Any]) -> str:
        if self.kind == "enum_base":
            return f"enum {self.owner} inherits from it"
        cls = (schema.get("classes") or {}).get(self.owner) or {}
        title = _title(self.owner, cls)
        return f"{title} inherits from it" if self.kind == "base" else f"{title}.{self.attribute} refers to it"


def _references(schema: Mapping[str, Any], target: str) -> list[Reference]:
    """Where a class or enum is used: bases and attribute ranges of every class, and enum bases."""
    found = []
    for name, cls in (schema.get("classes") or {}).items():
        if cls.get("is_a") == target or target in (cls.get("mixins") or []):
            found.append(Reference(name, "base"))
        for attribute, slot in (cls.get("attributes") or {}).items():
            if slot.get("range") == target:
                found.append(Reference(name, "range", attribute))
    for name, enum in (schema.get("enums") or {}).items():
        if target in (enum.get("inherits") or []):
            found.append(Reference(name, "enum_base"))
    return found


def _vocabulary_enum(schema: Mapping[str, Any], target: str) -> str:
    """The enum an enum edit targets: the enum itself, or a bam-masterdata vocabulary class's enum."""
    enums = schema.get("enums") or {}
    if target in enums:
        return target
    cls = (schema.get("classes") or {}).get(target)
    enum_name = annotation(cls, "source_vocabulary_enum") if cls else None
    if enum_name in enums:
        return enum_name
    if cls is not None:
        raise EditError("invalid", f"{_title(target, cls)} is not a vocabulary")
    raise EditError("not_found", f"enum {target!r} is not in the schema")


def _is_vocabulary(cls: Mapping[str, Any]) -> bool:
    if annotation(cls, "source_vocabulary_enum"):
        return True
    source = _json_annotation(cls, "source_annotations") or {}
    return source.get("entity_kind") == "VocabularyTypeDef"


# -------- attribute types --------

def _nomad_type_fields(schema: Mapping[str, Any], kind: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Range, annotations and multivalued of a NOMAD quantity or subsection."""
    if kind == "quantity":
        dtype = _required_text(payload, "dtype")
        spec = NOMAD_DTYPES.get(dtype)
        if spec is None:
            raise EditError("invalid", f"unsupported dtype {dtype!r}; supported: {', '.join(NOMAD_DTYPES)}")
        return {
            "range": spec["range"],
            "annotations": {
                "source_range": _json_text({"kind": "datatype", "name": spec["source_type"]}),
                "source_type": spec["source_type"],
                "display_dtype": spec["display"],
            },
        }
    if kind == "subsection":
        target = _required_text(payload, "range")
        if target not in (schema.get("classes") or {}):
            raise EditError("not_found", f"subsection target {target!r} is not a class of the schema")
        multivalued = bool(payload.get("multivalued"))
        return {
            "range": target,
            "multivalued": multivalued,
            "annotations": {
                "source_range": _json_text({"kind": "class", "name": target}),
                "display_card": "0..*" if multivalued else "0..1",
            },
        }
    raise EditError("invalid", f"unsupported attribute kind {kind!r}; supported: quantity, subsection")


def _bam_type_fields(schema: Mapping[str, Any], payload: Mapping[str, Any]) -> dict[str, Any]:
    """Range, annotations and openBIS facts of a bam-masterdata property."""
    data_type = _required_text(payload, "data_type")
    if data_type not in BAM_DATA_TYPES:
        raise EditError("invalid", f"unsupported data type {data_type!r}; supported: {', '.join(BAM_DATA_TYPES)}")
    classes = schema.get("classes") or {}
    facts: dict[str, Any] = {"data_type": data_type}
    fields: dict[str, Any] = {"annotations": {}}
    if data_type in ("OBJECT", "CONTROLLEDVOCABULARY"):
        target = _required_text(payload, "range")
        if target not in classes:
            raise EditError("not_found", f"{data_type} target {target!r} is not a class of the schema")
        target_class = classes[target]
        code = annotation(target_class, "source_entity_code")
        if data_type == "CONTROLLEDVOCABULARY":
            enum_name = annotation(target_class, "source_vocabulary_enum")
            if not enum_name or enum_name not in (schema.get("enums") or {}):
                raise EditError("invalid", f"{_title(target, target_class)} is not a vocabulary")
            fields["range"] = enum_name
            source_range = {"kind": "enum", "name": enum_name}
            facts["vocabulary_code"] = code
        else:
            if _is_vocabulary(target_class):
                raise EditError("invalid", f"{_title(target, target_class)} is a vocabulary, not an object type")
            fields["range"] = target
            source_range = {"kind": "class", "name": target}
            facts["object_code"] = code
        if not code:
            raise EditError("invalid", f"{_title(target, target_class)} has no openBIS code")
        fields["annotations"]["display_dtype"] = f"{data_type}[{code}]"
    else:
        source_range = {"kind": "datatype", "name": data_type}
        if BAM_DATA_TYPES[data_type]:
            fields["range"] = BAM_DATA_TYPES[data_type]
        fields["annotations"]["source_type"] = data_type
        fields["annotations"]["display_dtype"] = data_type
    fields["annotations"]["source_range"] = _json_text(source_range)
    fields["facts"] = facts
    return fields


def _apply_type_fields(slot: dict[str, Any], fields: Mapping[str, Any]) -> None:
    """Replace a slot's type: range, multivalued and the annotations that describe the type."""
    for key in ("range", "multivalued"):
        slot.pop(key, None)
        if key in fields:
            slot[key] = fields[key]
    for tag in ("source_range", "source_type", "display_dtype"):
        _set_annotation(slot, tag, fields["annotations"].get(tag))
    if "display_card" in fields["annotations"]:
        _set_annotation(slot, "display_card", fields["annotations"]["display_card"])
    if "facts" in fields:
        source = _json_annotation(slot, "source_annotations") or {}
        for key in ("data_type", "vocabulary_code", "object_code"):
            source.pop(key, None)
        source.update({key: value for key, value in fields["facts"].items() if value is not None})
        _set_annotation(slot, "source_annotations", _json_text(source))


def _property_codes(schema: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Every bam-masterdata property code in use, with the openBIS facts of its first use."""
    found: dict[str, dict[str, Any]] = {}
    for cls in (schema.get("classes") or {}).values():
        for slot in (cls.get("attributes") or {}).values():
            code = annotation(slot, "source_property_code")
            if code and code not in found:
                found[code] = _json_annotation(slot, "source_annotations") or {}
    return found


def _check_property_code(schema: Mapping[str, Any], code: str, facts: Mapping[str, Any]) -> None:
    """A property code names one openBIS property type: reusing it must keep its type and target."""
    used = _property_codes(schema).get(code)
    if used is None:
        return
    for key in ("data_type", "vocabulary_code", "object_code"):
        if used.get(key) != facts.get(key):
            stated = used.get(key) or "none"
            raise EditError("invalid", f"property code {code} is already used with {key} {stated}")


# -------- preparing an edit --------

def _current_value(schema: Mapping[str, Any], op: str, target: str, payload: Mapping[str, Any]) -> Any:
    """What a `set_*` edit replaces, recorded so a replay can tell when the source changed it."""
    if op == "set_description":
        element = _description_element(schema, target, payload)
        return {"description": element.get("description"), "description_de": annotation(element, "description_de")}
    slot = _declared(schema, target, payload.get("attribute") or "")
    if op == "set_required":
        return bool(slot.get("required"))
    return {"range": slot.get("range"), "display_dtype": annotation(slot, "display_dtype")}


def prepare_edit(
    schema: Mapping[str, Any],
    op: str,
    target: str,
    payload: Mapping[str, Any] | None,
    *,
    rules: str,
    package: str,
    profile: str | None = None,
    commit: str | None = None,
) -> dict[str, Any]:
    """A complete edit, checked against the current (edited) schema; raises `EditError` if it cannot apply.

    Derived values are filled in here, so a stored edit replays the same way
    later: the full name of a new class (`<package>.<Name>`, for
    bam-masterdata derived from its code), an attribute or term name derived
    from its code, and for `set_*` edits the value they replace (`before`).
    """
    if op not in OPS:
        raise EditError("invalid", f"unknown edit {op!r}; known: {', '.join(OPS)}")
    if rules not in RULE_SETS:
        raise EditError("invalid", f"unknown edit rules {rules!r}")
    payload = dict(payload or {})
    target = (target or "").strip()
    if op == "add_class":
        if rules == "bam-masterdata":
            code = _bam_code(_required_text(payload, "code"), "object type code")
            payload["code"] = code
            payload.setdefault("name", bam_class_name(code))
        name = _identifier(_required_text(payload, "name"), "class name")
        payload["name"] = name
        target = f"{package}.{name}"
    elif op in ("add_attribute",) and rules == "bam-masterdata":
        code = _bam_code(_required_text(payload, "code"), "property code")
        payload["code"] = code
        if not _text(payload, "name"):
            payload["name"] = bam_attribute_name(code)
    elif op == "add_enum_value" and rules == "bam-masterdata" and _text(payload, "value") and not _text(payload, "name"):
        payload["name"] = bam_attribute_name(_required_text(payload, "value"))
    if not target:
        raise EditError("invalid", "target is required")
    if op in SET_OPS:
        payload.pop("before", None)
        payload["before"] = _current_value(schema, op, target, payload)
    edit = {"op": op, "target": target, "payload": payload, "profile": profile, "commit": commit}
    # Applying it to a copy is the check: an edit that is stored always applied once.
    apply_edit(copy.deepcopy(schema), edit, rules=rules)
    return edit


# -------- applying edits --------

def apply_edit(schema: dict[str, Any], edit: Mapping[str, Any], *, rules: str) -> None:
    """Apply one edit to the schema in place; raises `EditError` (and changes nothing) if it cannot apply."""
    op = edit.get("op")
    handler = _HANDLERS.get(op or "")
    if handler is None:
        raise EditError("invalid", f"unknown edit {op!r}")
    target = edit.get("target")
    if not isinstance(target, str) or not target:
        raise EditError("invalid", "target is required")
    payload = edit.get("payload") or {}
    if not isinstance(payload, Mapping):
        raise EditError("invalid", "payload must be an object")
    handler(schema, target, payload, rules)


def apply_edits(
    schema: Mapping[str, Any],
    edits: Iterable[Mapping[str, Any]],
    *,
    rules: str,
    commit: str | None = None,
) -> tuple[dict[str, Any], list[Mapping[str, Any]], list[dict[str, Any]]]:
    """Replay edits in order onto a copy of the schema: (edited schema, applied edits, conflicts).

    An edit that cannot apply is skipped and reported (`applied: false`).
    A `set_*` edit made on another commit, whose target the source has
    changed since (its `before` value differs), is applied and reported as
    `changed_upstream` (`applied: true`).
    """
    edited = copy.deepcopy(dict(schema))
    applied: list[Mapping[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for edit in edits:
        payload = edit.get("payload") or {}
        stale = None
        if edit.get("op") in SET_OPS and "before" in payload and commit and edit.get("commit") not in (None, commit):
            try:
                if _current_value(edited, edit["op"], edit["target"], payload) != payload["before"]:
                    stale = "the source changed this since the edit was made"
            except EditError:
                pass  # apply_edit below reports it
        trial = copy.deepcopy(edited)
        try:
            apply_edit(trial, edit, rules=rules)
        except EditError as error:
            conflicts.append({"edit": edit, "reason": error.reason, "detail": error.detail, "applied": False})
            continue
        edited = trial
        applied.append(edit)
        if stale:
            conflicts.append({"edit": edit, "reason": "changed_upstream", "detail": stale, "applied": True})
    return edited, applied, conflicts


def _add_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    name = _identifier(_required_text(payload, "name"), "class name")
    if not target.endswith(f".{name}"):
        raise EditError("invalid", f"class {target!r} must end with its name {name!r}")
    module = target[: -len(name) - 1]
    if target in classes:
        raise EditError("exists", f"class {name} already exists in {module}")
    if any(_module(other, cls) == module and _title(other, cls) == name for other, cls in classes.items()):
        raise EditError("exists", f"a class named {name} already exists in {module}")
    is_a = _text(payload, "is_a")
    if is_a is not None and is_a not in classes:
        raise EditError("not_found", f"base class {is_a!r} is not in the schema")
    cls: dict[str, Any] = {"name": target, "title": name}
    description = _text(payload, "description")
    if description:
        cls["description"] = description
    class_uri = _element_id(schema, target)
    if class_uri:
        cls["class_uri"] = class_uri
    if is_a:
        cls["is_a"] = is_a
    annotations: dict[str, str] = {"source_bases": _json_text([is_a] if is_a else [])}
    if rules == "bam-masterdata":
        code = _bam_code(_required_text(payload, "code"), "object type code")
        if is_a:
            base = classes[is_a]
            if _is_vocabulary(base):
                raise EditError("invalid", f"{_title(is_a, base)} is a vocabulary; an object type cannot inherit from it")
            base_code = annotation(base, "source_entity_code")
            if base_code and not (code.startswith(f"{base_code}.") and "." not in code[len(base_code) + 1:]):
                raise EditError("invalid", f"an object type based on {base_code} needs the code {base_code}.<NAME>")
        for other, cls_other in classes.items():
            if annotation(cls_other, "source_entity_code") == code:
                raise EditError("exists", f"code {code} is already used by {_title(other, cls_other)}")
        annotations["source_entity_code"] = code
        german = _text(payload, "description_de")
        if german:
            annotations["description_de"] = german
        source = {"code": code, "entity_kind": "ObjectTypeDef"}
        if description:
            source["description"] = f"{description}//{german}" if german else description
        annotations["source_annotations"] = _json_text(source)
    annotations[ADDED] = "true"
    cls["annotations"] = annotations
    classes[target] = cls


def _rename_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    new_title = _identifier(_required_text(payload, "new_name"), "class name")
    module = _module(target, cls)
    new_name = f"{module}.{new_title}" if module else new_title
    if new_name == target:
        raise EditError("invalid", f"{_title(target, cls)} already has that name")
    if new_name in classes or any(
        _module(other, other_cls) == module and _title(other, other_cls) == new_title
        for other, other_cls in classes.items() if other != target
    ):
        raise EditError("exists", f"a class named {new_title} already exists in {module}")
    renamed = dict(cls, name=new_name, title=new_title)
    class_uri = _element_id(schema, new_name)
    if class_uri and "class_uri" in cls:
        renamed["class_uri"] = class_uri
    if not annotation(cls, "source_class") and annotation(cls, ADDED) != "true":
        renamed["annotations"] = dict(cls.get("annotations") or {}, source_class=target)
    schema["classes"] = {(new_name if name == target else name): (renamed if name == target else other)
                         for name, other in classes.items()}
    for other in schema["classes"].values():
        if other.get("is_a") == target:
            other["is_a"] = new_name
        if target in (other.get("mixins") or []):
            other["mixins"] = [new_name if base == target else base for base in other["mixins"]]
        hint = _json_annotation(other, "source_effective_attributes")
        if hint and any(ref.get("declaring_class_id") == target for ref in hint):
            for ref in hint:
                if ref.get("declaring_class_id") == target:
                    ref["declaring_class_id"] = new_name
            _set_annotation(other, "source_effective_attributes", _json_text(hint))
        for attribute, slot in (other.get("attributes") or {}).items():
            if slot.get("range") == target:
                slot["range"] = new_name
            if annotation(slot, "source_declaring_class") == target:
                _set_annotation(slot, "source_declaring_class", new_name)
    for slot_name, slot in (renamed.get("attributes") or {}).items():
        if "slot_uri" in slot:
            slot["slot_uri"] = _element_id(schema, new_name, slot_name) or slot["slot_uri"]
    for enum in (schema.get("enums") or {}).values():
        if annotation(enum, "source_vocabulary_class") == target:
            _set_annotation(enum, "source_vocabulary_class", new_name)


def _remove_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    cls = _class(schema, target)
    # The class's own attributes going with it do not count; uses by other classes do.
    used = [reference for reference in _references(schema, target) if reference.owner != target]
    enum_name = annotation(cls, "source_vocabulary_enum")
    if enum_name:
        used += [reference for reference in _references(schema, enum_name) if reference.owner != target]
    if used:
        details = "; ".join(reference.describe(schema) for reference in used[:5])
        raise EditError("in_use", f"{_title(target, cls)} is still used: {details}")
    del schema["classes"][target]
    if enum_name:
        (schema.get("enums") or {}).pop(enum_name, None)


def _add_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    name = _identifier(_required_text(payload, "name"), "attribute name")
    if name in (cls.get("attributes") or {}):
        raise EditError("exists", f"{_title(target, cls)} already has {name!r}")
    owner = _inherited_from(classes, target, name)
    if owner is not None:
        raise EditError("inherited", f"{name!r} is inherited from {_title(owner, classes[owner])} and cannot be redefined")
    slot: dict[str, Any] = {"name": name}
    if rules == "bam-masterdata":
        if _is_vocabulary(cls):
            raise EditError("invalid", f"{_title(target, cls)} is a vocabulary; add terms instead")
        code = _bam_code(_required_text(payload, "code"), "property code")
        fields = _bam_type_fields(schema, payload)
        _check_property_code(schema, code, fields["facts"])
        mandatory = bool(payload.get("mandatory"))
        label = _text(payload, "label")
        if label:
            slot["title"] = label
        kind = "property"
    else:
        kind = _required_text(payload, "kind")
        fields = _nomad_type_fields(schema, kind, payload)
    description = _text(payload, "description")
    if description:
        slot["description"] = description
    slot_uri = _element_id(schema, target, name)
    if slot_uri:
        slot["slot_uri"] = slot_uri
    slot["annotations"] = {"source_declaring_class": target, "source_kind": kind}
    _apply_type_fields(slot, fields)
    if rules == "bam-masterdata":
        if mandatory:
            slot["required"] = True
        source = _json_annotation(slot, "source_annotations") or {}
        source.update({"mandatory": mandatory, "property_code": code})
        if label:
            source["property_label"] = label
        section = _text(payload, "section")
        if section:
            source["section"] = section
        german = _text(payload, "description_de")
        if description:
            source["description"] = f"{description}//{german}" if german else description
        _set_annotation(slot, "source_annotations", _json_text(source))
        _set_annotation(slot, "source_property_code", code)
        _set_annotation(slot, "display_card", "1..1" if mandatory else "0..1")
        if german:
            _set_annotation(slot, "description_de", german)
    elif kind == "quantity":
        _set_annotation(slot, "display_shape", "[]")
    _set_annotation(slot, ADDED, "true")
    cls.setdefault("attributes", {})[name] = slot


def _rename_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    old = _required_text(payload, "attribute")
    slot = _declared(schema, target, old)
    new = _identifier(_required_text(payload, "new_name"), "attribute name")
    if new == old:
        raise EditError("invalid", f"{old!r} already has that name")
    if new in (cls.get("attributes") or {}):
        raise EditError("exists", f"{_title(target, cls)} already has {new!r}")
    owner = _inherited_from(classes, target, new)
    if owner is not None:
        raise EditError("inherited", f"{new!r} is inherited from {_title(owner, classes[owner])}")
    renamed = dict(slot, name=new)
    if "slot_uri" in slot:
        renamed["slot_uri"] = _element_id(schema, target, new) or slot["slot_uri"]
    cls["attributes"] = {(new if key == old else key): (renamed if key == old else value)
                         for key, value in cls["attributes"].items()}
    # Keep the attribute's place in the order the source gave.
    for other in classes.values():
        hint = _json_annotation(other, "source_effective_attributes")
        if hint and any(ref.get("name") == old and ref.get("declaring_class_id") == target for ref in hint):
            for ref in hint:
                if ref.get("name") == old and ref.get("declaring_class_id") == target:
                    ref["name"] = new
            _set_annotation(other, "source_effective_attributes", _json_text(hint))


def _remove_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    cls = _class(schema, target)
    name = _required_text(payload, "attribute")
    _declared(schema, target, name)
    del cls["attributes"][name]
    if not cls["attributes"]:
        del cls["attributes"]


def _set_range(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    slot = _declared(schema, target, _required_text(payload, "attribute"))
    kind = annotation(slot, "source_kind")
    if rules == "bam-masterdata":
        fields = _bam_type_fields(schema, payload)
        code = annotation(slot, "source_property_code")
        if code:
            others = {**schema, "classes": {
                name: {**cls, "attributes": {key: value for key, value in (cls.get("attributes") or {}).items()
                                             if value is not slot}}
                for name, cls in schema["classes"].items()
            }}
            _check_property_code(others, code, fields["facts"])
    else:
        fields = _nomad_type_fields(schema, kind or "quantity", payload)
        if kind == "subsection":
            # The card follows multivalued unless the payload leaves it out.
            if "multivalued" not in payload:
                fields["multivalued"] = bool(slot.get("multivalued"))
                fields["annotations"]["display_card"] = annotation(slot, "display_card")
    _apply_type_fields(slot, fields)


def _description_element(schema: Any, target: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("value") is not None:
        values = schema["enums"][_vocabulary_enum(schema, target)].setdefault("permissible_values", {})
        value = str(payload["value"])
        if value not in values:
            raise EditError("not_found", f"{value!r} is not a value of {target}")
        if values[value] is None:
            values[value] = {}
        return values[value]
    if payload.get("attribute"):
        return _declared(schema, target, str(payload["attribute"]))
    return _class(schema, target)


def _set_description(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    element = _description_element(schema, target, payload)
    description = _text(payload, "description")
    if description:
        element["description"] = description
    else:
        element.pop("description", None)
    if rules == "bam-masterdata" and "description_de" in payload:
        _set_annotation(element, "description_de", _text(payload, "description_de"))


def _set_required(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    slot = _declared(schema, target, _required_text(payload, "attribute"))
    required = payload.get("required")
    if not isinstance(required, bool):
        raise EditError("invalid", "required must be true or false")
    if required:
        slot["required"] = True
    else:
        slot.pop("required", None)
    if annotation(slot, "source_kind") == "property":
        _set_annotation(slot, "display_card", "1..1" if required else "0..1")
        source = _json_annotation(slot, "source_annotations") or {}
        source["mandatory"] = required
        _set_annotation(slot, "source_annotations", _json_text(source))


def _add_enum_value(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    enum_name = _vocabulary_enum(schema, target)
    values = schema["enums"][enum_name].setdefault("permissible_values", {})
    value = _required_text(payload, "value")
    vocabulary = annotation(schema["enums"][enum_name], "source_vocabulary_class") is not None
    if rules == "bam-masterdata" and vocabulary:
        _bam_code(value, "term code")
        if len(value) > BAM_TERM_CODE_LIMIT:
            raise EditError("invalid", f"term code {value} is longer than {BAM_TERM_CODE_LIMIT} characters")
    if value in values:
        raise EditError("exists", f"{value!r} is already a value of {target}")
    for base in schema["enums"][enum_name].get("inherits") or ():
        if value in ((schema["enums"].get(base) or {}).get("permissible_values") or {}):
            raise EditError("inherited", f"{value!r} is inherited from {base}")
    entry: dict[str, Any] = {}
    label = _text(payload, "label")
    if label:
        entry["title"] = label
    description = _text(payload, "description")
    if description:
        entry["description"] = description
    annotations: dict[str, str] = {}
    if rules == "bam-masterdata" and vocabulary:
        python_name = _identifier(_text(payload, "name") or bam_attribute_name(value), "term name")
        taken = {annotation(other or {}, "source_python_name") or code for code, other in values.items()}
        if python_name in taken:
            raise EditError("exists", f"a term named {python_name!r} already exists in {target}")
        annotations["source_python_name"] = python_name
        german = _text(payload, "description_de")
        if german:
            annotations["description_de"] = german
    annotations[ADDED] = "true"
    entry["annotations"] = annotations
    values[value] = entry


def _remove_enum_value(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    enum_name = _vocabulary_enum(schema, target)
    values = schema["enums"][enum_name].get("permissible_values") or {}
    value = _required_text(payload, "value")
    if value not in values:
        for base in schema["enums"][enum_name].get("inherits") or ():
            if value in ((schema["enums"].get(base) or {}).get("permissible_values") or {}):
                raise EditError("inherited", f"{value!r} is inherited from {base}; remove it there")
        raise EditError("not_found", f"{value!r} is not a value of {target}")
    del values[value]


_HANDLERS = {
    "add_class": _add_class,
    "rename_class": _rename_class,
    "remove_class": _remove_class,
    "add_attribute": _add_attribute,
    "rename_attribute": _rename_attribute,
    "remove_attribute": _remove_attribute,
    "set_range": _set_range,
    "set_description": _set_description,
    "set_required": _set_required,
    "add_enum_value": _add_enum_value,
    "remove_enum_value": _remove_enum_value,
}


def term_value(schema: Mapping[str, Any], target: str, python_name: str) -> str | None:
    """The term code behind a vocabulary term node (named after the term's Python name), or None."""
    try:
        enum_name = _vocabulary_enum(schema, target)
    except EditError:
        return None
    for code, value in ((schema.get("enums") or {})[enum_name].get("permissible_values") or {}).items():
        if (annotation(value or {}, "source_python_name") or code) == python_name:
            return code
    return None


__all__: Sequence[str] = (
    "ADDED", "BAM_DATA_TYPES", "EditError", "NOMAD_DTYPES", "OPS", "RULE_SETS",
    "apply_edit", "apply_edits", "bam_attribute_name", "bam_class_name", "prepare_edit", "rules_summary",
    "term_value",
)

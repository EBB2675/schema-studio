"""Conversion of NOMAD extraction documents into LinkML, on small hand-written documents."""
from __future__ import annotations

import json
from typing import Any

import pytest
import yaml
from linkml_runtime.utils.schemaview import SchemaView

from api.sources.linkml_yaml import dump_yaml
from api.sources.to_linkml import ConversionError, convert_nomad
from api.sources.to_linkml.common import element_id

M = "pkg.mod"
STR = '{"type_data": "str", "type_kind": "python"}'
FLOAT64 = '{"type_data": "float64", "type_kind": "numpy"}'


def quantity(name: str, type_: str = STR, **extra: Any) -> dict[str, Any]:
    return {"name": name, "kind": "quantity", "range": {"kind": "datatype", "name": type_}, **extra}


def subsection(name: str, target: str, repeats: bool) -> dict[str, Any]:
    return {"name": name, "kind": "subsection", "range": {"kind": "class", "name": target}, "repeats": repeats}


def cls(name: str, attributes: list[dict], bases: list[str] = (), inherited: list[tuple[str, str]] = (), **extra) -> dict:
    """A class whose effective attributes are its own plus `inherited` (name, declaring class)."""
    class_id = f"{M}.{name}"
    effective = [{"name": a["name"], "kind": a["kind"], "declaring_class_id": class_id} for a in attributes]
    effective += [{"name": attr, "kind": "quantity", "declaring_class_id": f"{M}.{owner}"} for attr, owner in inherited]
    return {"id": class_id, "name": name, "bases": [f"{M}.{b}" for b in bases], "attributes": attributes,
            "effective_attributes": effective, **extra}


def document(classes: list[dict], enums: list[dict] = (), report: list[dict] = (), name: str = "nomad-simulations") -> dict:
    return {
        "contract_version": "1.0",
        "source": {"name": name, "version": "1.0", "module": M, "commit": "abc123",
                   "dependencies": {"nomad-lab": "1.4.3"}},
        "classes": list(classes), "enums": list(enums), "report": list(report),
    }


def view(schema: dict) -> SchemaView:
    return SchemaView(dump_yaml(schema, profile="nomad-simulations", source={}, tools={}))


def partial_reasons(report: list[dict]) -> dict[str, str]:
    return {row["path"]: row["reason"] for row in report if row["status"] == "partial"}


def test_multiple_inheritance_becomes_is_a_and_mixins():
    doc = document([
        cls("Base", [quantity("a")]),
        cls("Mixin", [quantity("b")]),
        cls("Child", [quantity("c")], bases=["Base", "Mixin"], inherited=[("a", "Base"), ("b", "Mixin")]),
    ])
    result = convert_nomad(doc)
    child = result.schema["classes"][f"{M}.Child"]
    assert child["is_a"] == f"{M}.Base"
    assert child["mixins"] == [f"{M}.Mixin"]
    assert child["title"] == "Child"
    assert json.loads(child["annotations"]["source_bases"]) == [f"{M}.Base", f"{M}.Mixin"]
    assert {str(slot.name) for slot in view(result.schema).class_induced_slots(f"{M}.Child")} == {"a", "b", "c"}
    assert partial_reasons(result.report) == {}


def test_repeating_subsections_are_multivalued():
    doc = document([
        cls("Item", []),
        cls("Holder", [subsection("items", f"{M}.Item", True), subsection("first", f"{M}.Item", False)]),
    ])
    attributes = convert_nomad(doc).schema["classes"][f"{M}.Holder"]["attributes"]
    assert attributes["items"]["multivalued"] is True
    assert attributes["first"]["multivalued"] is False
    assert attributes["items"]["range"] == f"{M}.Item"
    assert attributes["items"]["annotations"]["source_kind"] == "subsection"


def test_units_known_unmapped_and_refused():
    doc = document([cls("C", [
        quantity("energy", FLOAT64, unit="joule"),
        quantity("pressure", FLOAT64, unit="joule / meter ** 3"),
        quantity("hartree_energy", FLOAT64, unit="hartree"),
        quantity("speed", FLOAT64, unit="rpm"),
    ])])
    result = convert_nomad(doc)
    attributes = result.schema["classes"][f"{M}.C"]["attributes"]
    assert attributes["energy"]["unit"] == {"ucum_code": "J"}
    assert attributes["pressure"]["unit"] == {"ucum_code": "J/m3"}
    assert "unit" not in attributes["hartree_energy"]
    assert attributes["hartree_energy"]["annotations"]["source_unit"] == "hartree"
    assert "unit" not in attributes["speed"]
    reasons = partial_reasons(result.report)
    assert reasons[f"{M}.C.hartree_energy"] == "unmapped source unit: hartree"
    assert reasons[f"{M}.C.speed"].startswith("refused source unit: rpm")
    assert f"{M}.C.energy" not in reasons


def test_shapes_become_array_expressions():
    doc = document([cls("C", [
        quantity("scalar", FLOAT64, shape=[]),
        quantity("matrix", FLOAT64, shape=[3, 3]),
        quantity("vector", FLOAT64, shape=["*"]),
        quantity("ranged", FLOAT64, shape=["1..*"]),
        quantity("positions", FLOAT64, shape=["n_atoms", 3]),
    ])])
    result = convert_nomad(doc)
    attributes = result.schema["classes"][f"{M}.C"]["attributes"]
    assert "array" not in attributes["scalar"]
    assert attributes["scalar"]["annotations"]["source_shape"] == "[]"
    assert attributes["matrix"]["array"] == {"exact_number_dimensions": 2, "dimensions": [
        {"alias": "axis_0", "exact_cardinality": 3}, {"alias": "axis_1", "exact_cardinality": 3}]}
    assert attributes["vector"]["array"] == {"exact_number_dimensions": 1, "dimensions": [{"alias": "axis_0"}]}
    assert attributes["ranged"]["array"]["dimensions"] == [{"alias": "axis_0", "minimum_cardinality": 1}]
    assert attributes["positions"]["array"]["dimensions"][0] == {"alias": "n_atoms"}
    assert json.loads(attributes["positions"]["annotations"]["source_shape"]) == ["n_atoms", 3]
    reasons = partial_reasons(result.report)
    assert set(reasons) == {f"{M}.C.positions"}
    assert "n_atoms" in reasons[f"{M}.C.positions"]


def test_enums_keep_order_and_metadata():
    enum_id = f"{M}.C.kind"
    doc = document(
        [cls("C", [{"name": "kind", "kind": "quantity", "range": {"kind": "enum", "name": enum_id},
                    "annotations": {"display_dtype": "Enum", "source_type": '{"type_kind": "enum"}'}}])],
        enums=[{"id": enum_id, "values": ["z", {"value": "a", "title": "A", "description": "first",
                                                 "annotations": {"rank": 1}}]}],
    )
    schema = convert_nomad(doc).schema
    values = schema["enums"][enum_id]["permissible_values"]
    assert list(values) == ["z", "a"]
    assert values["a"] == {"title": "A", "description": "first", "annotations": {"rank": "1"}}
    slot = schema["classes"][f"{M}.C"]["attributes"]["kind"]
    assert slot["range"] == enum_id
    assert slot["annotations"]["source_type"] == '{"type_kind": "enum"}'
    assert "source_annotations" not in slot["annotations"]
    assert [str(v) for v in view(schema).get_enum(enum_id).permissible_values] == ["z", "a"]


def test_datatypes_and_bounds():
    def bounded(bound: str, **settings) -> str:
        data = {"type_bound": bound, "type_bound_clamp": False, "type_bound_on_violation": "raise",
                "type_bound_slack": 0.0, "type_data": "pkg.data_types.m_float_bounded", "type_dtype": "float",
                "type_kind": "custom"}
        return json.dumps(data | settings, sort_keys=True)

    doc = document([cls("C", [
        quantity("text"),
        quantity("value", FLOAT64),
        quantity("when", '{"type_data": "nomad.metainfo.data_type.Datetime", "type_kind": "custom"}'),
        quantity("amplitude", '{"type_data": "complex128", "type_kind": "numpy"}'),
        quantity("fraction", bounded("[0,1]")),
        quantity("positive", bounded("(0,)")),
        quantity("occupation", bounded("[0,2]", type_bound_clamp=True)),
        quantity("lattice", '{"disable_shape_check": true, "type_data": "float64", "type_kind": "numpy"}'),
    ])])
    result = convert_nomad(doc)
    attributes = result.schema["classes"][f"{M}.C"]["attributes"]
    assert attributes["text"]["range"] == "string"
    assert attributes["value"]["range"] == "double"
    assert attributes["when"]["range"] == "datetime"
    assert "range" not in attributes["amplitude"]
    assert attributes["amplitude"]["annotations"]["source_type"] == '{"type_data": "complex128", "type_kind": "numpy"}'
    assert (attributes["fraction"]["range"], attributes["fraction"]["minimum_value"], attributes["fraction"]["maximum_value"]) == ("float", 0, 1)
    assert attributes["positive"]["range"] == "float" and "minimum_value" not in attributes["positive"]
    assert "minimum_value" not in attributes["occupation"] and "maximum_value" not in attributes["occupation"]
    assert attributes["lattice"]["range"] == "double"
    reasons = partial_reasons(result.report)
    assert set(reasons) == {f"{M}.C.{name}" for name in ("amplitude", "positive", "occupation", "lattice")}
    assert reasons[f"{M}.C.amplitude"] == "unmapped source type: numpy complex128"
    assert "type_bound_clamp=True" in reasons[f"{M}.C.occupation"]


def test_display_annotations_and_descriptions_are_carried_through():
    doc = document([cls("C", [
        quantity("documented", description="Has a description.",
                 annotations={"display_dtype": "str", "display_shape": "[]", "other": 3}),
        quantity("bare"),
    ], description="A class.")])
    schema = convert_nomad(doc).schema
    c = schema["classes"][f"{M}.C"]
    assert c["description"] == "A class."
    documented, bare = c["attributes"]["documented"], c["attributes"]["bare"]
    assert documented["description"] == "Has a description."
    assert documented["annotations"]["display_dtype"] == "str"
    assert documented["annotations"]["display_shape"] == "[]"
    assert "display_card" not in documented["annotations"]
    assert json.loads(documented["annotations"]["source_annotations"]) == {"other": 3}
    # No description in the source means none in LinkML; nothing generic is filled in.
    assert "description" not in bare
    assert not any(key.startswith("display_") for key in bare["annotations"])


def test_ids_prefixes_and_no_reference_application_terms():
    result = convert_nomad(document([cls("C", [quantity("x")])], name="nomad-measurements"))
    schema = result.schema
    assert schema["default_prefix"] == "nomadmeas"
    assert set(schema["prefixes"]) == {"linkml", "nomadmeas"}
    c = schema["classes"][f"{M}.C"]
    assert c["class_uri"] == "nomadmeas:pkg%2Emod%2EC"
    assert c["attributes"]["x"]["slot_uri"] == "nomadmeas:pkg%2Emod%2EC.x"
    assert schema["annotations"]["source_commit"] == "abc123"
    text = json.dumps(schema)
    assert "smat" not in text and "schematerial" not in text
    assert element_id("nomadsim", ("a%b.c", "d")) == "nomadsim:a%25b%2Ec.d"
    with pytest.raises(ConversionError):
        element_id("other", ("a",))


def test_extraction_report_rows_are_kept():
    row = {"path": f"{M}.Gone", "status": "skipped", "reason": "not a section"}
    result = convert_nomad(document([cls("C", [])], report=[row]))
    assert result.report[0] == row


def test_inheritance_mismatch_is_partial_and_the_schema_is_kept():
    doc = document([
        cls("Base", [quantity("a"), quantity("b")]),
        cls("Unrelated", [quantity("z")]),
        # The source says `Child` has `z` from a class LinkML does not see as an ancestor.
        cls("Child", [], bases=["Base"], inherited=[("a", "Base"), ("b", "Base"), ("z", "Unrelated")]),
        # The source says `Other` does not have `b`, but LinkML inherits it.
        cls("Other", [], bases=["Base"], inherited=[("a", "Base")]),
    ])
    result = convert_nomad(doc)
    reasons = partial_reasons(result.report)
    assert set(reasons) == {f"{M}.Child.z", f"{M}.Other.b"}
    assert "LinkML does not inherit it" in reasons[f"{M}.Child.z"]
    assert "LinkML inherits this attribute" in reasons[f"{M}.Other.b"]
    assert set(result.schema["classes"]) == {f"{M}.{name}" for name in ("Base", "Unrelated", "Child", "Other")}


def test_redeclared_attribute_keeps_its_own_definition():
    """LinkML takes a redeclared attribute as it is; nothing is filled in from the base."""
    doc = document([
        cls("Base", [quantity("a", FLOAT64, description="From the base.", unit="joule")]),
        cls("Child", [quantity("a")], bases=["Base"]),
    ])
    result = convert_nomad(doc)
    assert partial_reasons(result.report) == {}
    induced = view(result.schema).induced_slot("a", f"{M}.Child")
    assert (induced.range, induced.description, induced.unit) == ("string", None, None)


def test_cycle_and_unknown_source_are_errors():
    looped = document([cls("A", [], bases=["B"]), cls("B", [], bases=["A"])])
    with pytest.raises(ConversionError, match="cycle"):
        convert_nomad(looped)
    with pytest.raises(ConversionError, match="no LinkML prefix"):
        convert_nomad(document([cls("C", [])], name="something-else"))
    assert convert_nomad(document([cls("C", [])], name="something-else"), prefix="bammd").schema["default_prefix"] == "bammd"


def test_exported_yaml_reads_back_as_the_same_data():
    doc = document([cls("C", [quantity("x", description="line one\nline two")])])
    schema = convert_nomad(doc).schema
    text = dump_yaml(schema, profile="nomad-simulations", source=doc["source"], tools={"linkml-runtime": "1.11.1"})
    assert yaml.safe_load(text) == schema
    assert "description: |-\n" in text
    assert text.splitlines()[:4] == [
        "# LinkML schema exported by schema-studio",
        "# profile: nomad-simulations",
        "# source: nomad-simulations 1.0, commit abc123",
        "# tools: linkml-runtime 1.11.1",
    ]
    keys = list(yaml.safe_load(text))
    assert keys == ["id", "name", "title", "version", "prefixes", "default_prefix", "imports", "annotations", "enums", "classes"]


def test_header_summarises_the_report():
    from api.sources.linkml_yaml import report_summary

    rows = [{"path": "a", "status": "partial", "reason": "x"}, {"path": "b", "status": "partial", "reason": "y"},
            {"path": "c", "status": "skipped", "reason": "z"}]
    text = dump_yaml({"id": "x", "name": "x"}, profile="p", source={}, tools={}, report=rows)
    assert text.splitlines()[4].startswith("# conversion report: 2 partial, 1 skipped (partial: ")
    assert report_summary([]) == "conversion report: everything converted"


def test_namespace_is_the_pages_site():
    schema = convert_nomad(document([cls("C", [])])).schema
    assert schema["prefixes"]["nomadsim"] == "https://ebb2675.github.io/schema-studio/linkml/nomadsim/"
    assert schema["id"] == f"https://ebb2675.github.io/schema-studio/linkml/nomad-simulations/{M}"

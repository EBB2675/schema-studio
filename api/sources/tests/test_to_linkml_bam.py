"""Conversion of bam-masterdata extraction documents into LinkML, on small hand-written documents."""
from __future__ import annotations

import json
from typing import Any

import pytest
import yaml
from linkml_runtime.utils.schemaview import SchemaView

from api.sources.linkml_yaml import dump_yaml
from api.sources.to_linkml import ConversionError, convert, convert_bam
from api.sources.to_linkml.bam import split_bilingual
from api.sources.to_linkml.common import Report

from .conftest import load_fixture

M = "bam_masterdata.datamodel.object_types"
V = "bam_masterdata.datamodel.vocabulary_types"


def prop(name: str, data_type: str = "VARCHAR", *, range_: dict | None = None, **extra: Any) -> dict[str, Any]:
    annotations = {"data_type": data_type, "property_code": name.upper(), "property_label": name.title(),
                   "mandatory": False, "display_dtype": data_type, "display_card": "0..1"}
    annotations.update(extra.pop("annotations", {}))
    return {"name": name, "kind": "property", "range": range_ or {"kind": "datatype", "name": data_type},
            "annotations": annotations, **extra}


def entity(class_id: str, attributes: list[dict] = (), bases: list[str] = (), inherited: list[tuple[str, str]] = (),
           **annotations: Any) -> dict:
    effective = [{"name": item, "kind": "property", "declaring_class_id": owner} for item, owner in inherited]
    effective += [{"name": a["name"], "kind": "property", "declaring_class_id": class_id} for a in attributes]
    record = {"id": class_id, "name": class_id.rpartition(".")[2], "bases": list(bases),
              "attributes": list(attributes), "effective_attributes": effective}
    if annotations:
        record["annotations"] = annotations
    return record


def document(classes: list[dict], enums: list[dict] = (), report: list[dict] = ()) -> dict:
    return {
        "contract_version": "1.0",
        "source": {"name": "bam-masterdata", "version": "0.14.0", "module": M, "commit": "9e2b29a",
                   "dependencies": {"pint": "0.26", "pydantic": "2.13"}},
        "classes": list(classes), "enums": list(enums), "report": list(report),
    }


def view(schema: dict) -> SchemaView:
    return SchemaView(dump_yaml(schema, profile="bam-masterdata", source={}, tools={}))


def partial_reasons(report: list[dict]) -> dict[str, str]:
    return {row["path"]: row["reason"] for row in report if row["status"] == "partial"}


STATUS = f"{V}.DeviceStatus"
STATUS_ENUM = f"{STATUS}.terms"


def example() -> dict:
    """An object type with properties, a vocabulary, an OBJECT link and an inheriting child."""
    return document(
        [
            entity(f"{M}.Instrument", [
                prop("name", annotations={"mandatory": True, "display_card": "1..1", "section": "General",
                                          "property_label": "Name//Bezeichnung"},
                     description="Name of the instrument//Name des Instruments"),
                prop("status", "CONTROLLEDVOCABULARY", range_={"kind": "enum", "name": STATUS_ENUM},
                     annotations={"vocabulary_code": "DEVICE_STATUS",
                                  "display_dtype": "CONTROLLEDVOCABULARY[DEVICE_STATUS]"}),
                prop("length", "REAL", unit="mm"),
                prop("notes", "XML"),
            ], entity_kind="ObjectTypeDef", code="INSTRUMENT", iri="http://purl.obolibrary.org/bam-masterdata/Instrument:1.0.0"),
            entity(f"{M}.Microscope", [
                prop("operator", "OBJECT", range_={"kind": "class", "name": f"{M}.Instrument"},
                     annotations={"object_code": "INSTRUMENT", "display_dtype": "OBJECT[INSTRUMENT]"}),
            ], bases=[f"{M}.Instrument"],
               inherited=[("name", f"{M}.Instrument"), ("status", f"{M}.Instrument"),
                          ("length", f"{M}.Instrument"), ("notes", f"{M}.Instrument")],
               entity_kind="ObjectTypeDef", code="INSTRUMENT.MICROSCOPE"),
            entity(STATUS, entity_kind="VocabularyTypeDef", code="DEVICE_STATUS", vocabulary_enum=STATUS_ENUM),
        ],
        enums=[{"id": STATUS_ENUM, "values": [
            {"value": "ACTIVE", "title": "Active", "description": "In use//In Betrieb",
             "annotations": {"python_name": "active", "official": True}},
            {"value": "NONE", "title": "None", "annotations": {"python_name": "term_none"}},
        ]}],
    )


def test_properties_become_attributes_with_openbis_facts():
    schema = convert_bam(example()).schema
    assert schema["default_prefix"] == "bammd"
    assert schema["prefixes"]["bammd"] == "https://ebb2675.github.io/schema-studio/linkml/bammd/"
    instrument = schema["classes"][f"{M}.Instrument"]
    assert instrument["class_uri"] == f"bammd:{M.replace('.', '%2E')}%2EInstrument"
    assert instrument["annotations"]["source_entity_code"] == "INSTRUMENT"
    name = instrument["attributes"]["name"]
    assert name["required"] is True
    assert name["title"] == "Name"
    assert name["description"] == "Name of the instrument"
    assert name["range"] == "string"
    annotations = name["annotations"]
    assert annotations["title_de"] == "Bezeichnung"
    assert annotations["description_de"] == "Name des Instruments"
    assert annotations["source_property_code"] == "NAME"
    assert annotations["display_card"] == "1..1"
    assert annotations["source_kind"] == "property"
    raw = json.loads(annotations["source_annotations"])
    assert raw["description"] == "Name of the instrument//Name des Instruments"
    assert raw["section"] == "General"
    assert "display_card" not in raw
    assert instrument["attributes"]["status"]["range"] == STATUS_ENUM
    assert "required" not in instrument["attributes"]["status"]
    assert instrument["attributes"]["length"]["unit"] == {"ucum_code": "mm"}
    assert instrument["attributes"]["length"]["annotations"]["source_unit"] == "mm"
    microscope = schema["classes"][f"{M}.Microscope"]
    assert microscope["is_a"] == f"{M}.Instrument"
    assert microscope["attributes"]["operator"]["range"] == f"{M}.Instrument"


def test_vocabularies_become_enums_and_keep_term_names():
    schema = convert_bam(example()).schema
    vocabulary = schema["classes"][STATUS]
    assert vocabulary["annotations"]["source_vocabulary_enum"] == STATUS_ENUM
    enum = schema["enums"][STATUS_ENUM]
    assert enum["annotations"] == {"source_vocabulary_class": STATUS}
    assert list(enum["permissible_values"]) == ["ACTIVE", "NONE"]
    active = enum["permissible_values"]["ACTIVE"]
    assert active["title"] == "Active"
    assert active["description"] == "In use"
    assert active["annotations"]["source_python_name"] == "active"
    assert active["annotations"]["description_de"] == "In Betrieb"
    assert json.loads(active["annotations"]["source_annotations"])["official"] is True
    assert [str(value) for value in view(schema).get_enum(STATUS_ENUM).permissible_values] == ["ACTIVE", "NONE"]


def test_partial_cases_are_reported():
    result = convert_bam(example())
    reasons = partial_reasons(result.report)
    assert reasons == {f"{M}.Instrument.notes": "unsupported source type: XML"}
    assert "range" not in result.schema["classes"][f"{M}.Instrument"]["attributes"]["notes"]

    unknown = document([entity(f"{M}.C", [prop("pixels", "REAL", unit="pixels"), prop("odd", "MATRIX"),
                                          prop("rate", "REAL", unit="rpm")])])
    reasons = partial_reasons(convert_bam(unknown).report)
    assert reasons == {
        f"{M}.C.pixels": "unmapped source unit: pixels",
        f"{M}.C.odd": "unmapped source type: MATRIX",
        f"{M}.C.rate": "refused source unit: rpm; source registries disagree about this spelling",
    }


def test_bilingual_split():
    report = Report()
    assert split_bilingual("Sample//Probe", "p", "description", report) == ("Sample", "Probe")
    assert split_bilingual("Material // Werkstoff", "p", "description", report) == ("Material", "Werkstoff")
    assert split_bilingual("See https://example.org//x", "p", "description", report) == ("See https://example.org", "x")
    assert split_bilingual("English only", "p", "description", report) == ("English only", None)
    assert split_bilingual("", "p", "description", report) == (None, None)
    assert report.rows == []
    assert split_bilingual("A//B//C", "p", "description", report) == ("A//B//C", None)
    assert split_bilingual("A///B", "q", "description", report) == ("A///B", None)
    assert split_bilingual("A//", "r", "description", report) == ("A//", None)
    assert [row["path"] for row in report.rows] == ["p", "q", "r"]


def test_inherited_properties_load_in_schemaview():
    result = convert_bam(example())
    assert not [row for row in result.report if row["reason"].startswith("inheritance mismatch")]
    induced = {str(slot.name) for slot in view(result.schema).class_induced_slots(f"{M}.Microscope")}
    assert induced == {"name", "status", "length", "notes", "operator"}


def test_vocabulary_based_on_another_inherits_its_enum():
    child, child_enum = f"{V}.ExtendedStatus", f"{V}.ExtendedStatus.terms"
    doc = example()
    doc["classes"].append(entity(child, bases=[STATUS], entity_kind="VocabularyTypeDef", vocabulary_enum=child_enum))
    doc["enums"].append({"id": child_enum, "values": [{"value": "RETIRED", "annotations": {"python_name": "retired"}}]})
    schema = convert_bam(doc).schema
    assert schema["enums"][child_enum]["inherits"] == [STATUS_ENUM]
    assert schema["classes"][child]["is_a"] == STATUS
    view(schema)  # loads


def test_conversion_is_deterministic_and_dispatched_by_source():
    doc = example()
    first = dump_yaml(convert_bam(doc).schema, profile="bam-masterdata", source=doc["source"], tools={})
    second = dump_yaml(convert(example()).schema, profile="bam-masterdata", source=doc["source"], tools={})
    assert first == second
    assert yaml.safe_load(first)["default_prefix"] == "bammd"


def test_wrong_prefix_and_cycles_are_errors():
    with pytest.raises(ConversionError, match="bammd"):
        convert_bam(example(), prefix="nomadsim")
    looped = document([entity(f"{M}.A", bases=[f"{M}.B"]), entity(f"{M}.B", bases=[f"{M}.A"])])
    with pytest.raises(ConversionError, match="cycle"):
        convert_bam(looped)


def test_stored_fixture_converts_without_inheritance_mismatch():
    document = load_fixture("bam-masterdata")
    result = convert_bam(document)
    assert not [row for row in result.report if row["reason"].startswith("inheritance mismatch")]
    schema_view = view(result.schema)
    for row in document["classes"]:
        induced = {str(slot.name) for slot in schema_view.class_induced_slots(row["id"])}
        assert induced == {ref["name"] for ref in row["effective_attributes"]}, row["id"]

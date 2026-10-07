"""`extractor/scripts/bam.py` on a small bam-masterdata-like package, started through the runner.

The package (with stand-ins for the openBIS framework in `bam_masterdata.metadata`)
is written to a temporary folder and imported through `--source-root`, so no
schema package is needed. The cases of `test_graph_builder_bam.py` hold for the
new path too: the same package gives the same graph through `bam.py`, the BAM
LinkML converter and the graph adapter as through `extractor/graph_builder.py`,
apart from the openBIS facts the new path adds to the nodes. Checks against the
real datamodel are in `api/sources/tests/test_graph_regression_bam.py` (slow).
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

from extractor.contract import validate_document
from extractor.runner import ExtractorError, run_script

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
NS = "bam_masterdata.datamodel"
OBJECTS = f"{NS}.object_types"
VOCABULARIES = f"{NS}.vocabulary_types"
ENTITIES = "bam_masterdata.metadata.entities"
# What the new path adds to nodes; the legacy graph has none of it.
ADDED_FIELDS = ("unit", "code", "title", "title_de", "doc_de", "mandatory", "section", "iri")

FILES = {
    "bam_masterdata-0.1.dist-info/METADATA": "Metadata-Version: 2.1\nName: bam-masterdata\nVersion: 0.1\n",
    "bam_masterdata/__init__.py": "",
    "bam_masterdata/metadata/__init__.py": "",
    "bam_masterdata/datamodel/__init__.py": "",
    "bam_masterdata/datamodel/lab/__init__.py": "",
    "bam_masterdata/metadata/entities.py": '''
from bam_masterdata.metadata.definitions import DataType, PropertyTypeAssignment


class BaseEntity:
    """Root of the entity types."""


class ObjectType(BaseEntity):
    """Base class used to define object types."""


class CollectionType(ObjectType):
    # The real one has no properties; this one checks that a framework type's own ones are read.
    default_view = PropertyTypeAssignment(
        code="DEFAULT_VIEW", data_type=DataType.VARCHAR, property_label="Default view",
        description="Default view", mandatory=False,
    )


class DatasetType(ObjectType):
    pass


class VocabularyType(BaseEntity):
    """Base class used to define vocabulary types."""
''',
    "bam_masterdata/metadata/definitions.py": '''
from dataclasses import dataclass
from enum import Enum


class DataType(str, Enum):
    BOOLEAN = "BOOLEAN"
    CONTROLLEDVOCABULARY = "CONTROLLEDVOCABULARY"
    INTEGER = "INTEGER"
    OBJECT = "OBJECT"
    REAL = "REAL"
    VARCHAR = "VARCHAR"
    XML = "XML"


@dataclass
class ObjectTypeDef:
    code: str
    description: str = ""
    iri: str | None = None


@dataclass
class CollectionTypeDef(ObjectTypeDef):
    pass


@dataclass
class VocabularyTypeDef:
    code: str
    description: str = ""


@dataclass
class PropertyTypeAssignment:
    code: str
    data_type: DataType
    property_label: str
    description: str
    mandatory: bool
    section: str = ""
    units: str | None = None
    vocabulary_code: str | None = None
    object_code: str | None = None


@dataclass
class VocabularyTerm:
    code: str
    label: str
    description: str = ""
''',
    "bam_masterdata/datamodel/object_types.py": '''
from bam_masterdata.metadata.definitions import DataType, ObjectTypeDef, PropertyTypeAssignment
from bam_masterdata.metadata.entities import ObjectType


class BaseEntity(ObjectType):
    defs = ObjectTypeDef(code="BASE_ENTITY", description="Base entity//Basisobjekt")

    base_value = PropertyTypeAssignment(
        code="BASE_VALUE",
        data_type=DataType.INTEGER,
        property_label="Base value",
        description="Base value",
        mandatory=False,
        section="General",
    )


class Device(BaseEntity):
    defs = ObjectTypeDef(
        code="DEVICE", description="A device", iri="http://purl.obolibrary.org/bam-masterdata/Device:1.0.0",
    )

    identifier = PropertyTypeAssignment(
        code="IDENTIFIER",
        data_type=DataType.VARCHAR,
        property_label="Identifier",
        description="Unique identifier//Eindeutige Kennung",
        mandatory=True,
    )

    status = PropertyTypeAssignment(
        code="STATUS",
        data_type=DataType.CONTROLLEDVOCABULARY,
        property_label="Status",
        description="Device status",
        mandatory=False,
        vocabulary_code="DEVICE_STATUS",
    )

    length = PropertyTypeAssignment(
        code="LENGTH",
        data_type=DataType.REAL,
        property_label="Length in [mm]",
        description="Length",
        mandatory=False,
        units="mm",
    )


class Sensor(Device):
    # No definition of its own: still an entity, as the graph builder sees it.
    owner = PropertyTypeAssignment(
        code="OWNER",
        data_type=DataType.OBJECT,
        property_label="Owner",
        description="",
        mandatory=False,
        object_code="DEVICE",
    )

    notes = PropertyTypeAssignment(
        code="NOTES", data_type=DataType.XML, property_label="Notes", description="Notes", mandatory=False,
    )


class Probe(BaseEntity):
    # No definition of its own either: its description comes from BaseEntity's.
    depth = PropertyTypeAssignment(
        code="DEPTH", data_type=DataType.REAL, property_label="Depth", description="Depth", mandatory=False,
    )


Instrument = Device
''',
    "bam_masterdata/datamodel/vocabulary_types.py": '''
from bam_masterdata.metadata.definitions import VocabularyTerm, VocabularyTypeDef
from bam_masterdata.metadata.entities import VocabularyType


class DeviceStatus(VocabularyType):
    defs = VocabularyTypeDef(code="DEVICE_STATUS", description="Device status//Gerätestatus")

    active = VocabularyTerm(code="ACTIVE", label="Active", description="Device is active//Gerät ist aktiv")
    term_none = VocabularyTerm(code="NONE", label="None")


class ExtendedStatus(DeviceStatus):
    defs = VocabularyTypeDef(code="EXTENDED_STATUS", description="More states")

    retired = VocabularyTerm(code="RETIRED", label="Retired", description="Out of service")


class Colour(VocabularyType):
    defs = VocabularyTypeDef(code="COLOUR", description="Colours")

    red = VocabularyTerm(code="RED", label="Red")
''',
    "bam_masterdata/datamodel/collection_types.py": '''
from bam_masterdata.metadata.definitions import CollectionTypeDef
from bam_masterdata.metadata.entities import CollectionType


class Campaign(CollectionType):
    defs = CollectionTypeDef(code="CAMPAIGN", description="Campaign")
''',
    # A second vocabulary with the code COLOUR; `lab` classes use their own.
    "bam_masterdata/datamodel/lab/vocabularies.py": '''
from bam_masterdata.metadata.definitions import VocabularyTerm, VocabularyTypeDef
from bam_masterdata.metadata.entities import VocabularyType


class Colour(VocabularyType):
    defs = VocabularyTypeDef(code="COLOUR", description="Lab colours")

    blue = VocabularyTerm(code="BLUE", label="Blue")
''',
    "bam_masterdata/datamodel/lab/object_types.py": '''
from bam_masterdata.metadata.definitions import DataType, ObjectTypeDef, PropertyTypeAssignment
from bam_masterdata.metadata.entities import ObjectType


class Sample(ObjectType):
    defs = ObjectTypeDef(code="SAMPLE_X", description="Sample")

    colour = PropertyTypeAssignment(
        code="COLOUR", data_type="CONTROLLEDVOCABULARY", property_label="Colour", description="Colour",
        mandatory=False, vocabulary_code="COLOUR",
    )
''',
}


@pytest.fixture()
def package_root(tmp_path: Path) -> Path:
    root = tmp_path / "src"
    for relative, content in FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


@pytest.fixture()
def legacy_builder(package_root, monkeypatch):
    """The legacy graph builder, importing the fake package in this process."""
    from extractor import graph_builder

    def forget():
        for name in [name for name in sys.modules if name == "bam_masterdata" or name.startswith("bam_masterdata.")]:
            sys.modules.pop(name)

    forget()
    monkeypatch.syspath_prepend(str(package_root))
    importlib.invalidate_caches()
    yield graph_builder
    forget()


def extract(fake_environment, package_root, *arguments: str) -> dict:
    payload = run_script(
        fake_environment, SCRIPTS / "bam.py",
        arguments=("--dist", "bam-masterdata", "--source-root", str(package_root), *arguments),
    )
    return validate_document(payload["result"])


def linkml_graph(document: dict, package: str, **flags):
    from api.sources import graph
    from api.sources.to_linkml import convert_bam

    schema = convert_bam(document).schema
    return graph.build_graph(schema, document, package, base_namespace=NS, **flags)


def without_added_fields(result: dict) -> dict:
    nodes = [{key: value for key, value in node.items() if key not in ADDED_FIELDS} for node in result["nodes"]]
    return {**result, "nodes": nodes}


def english(doc: str | None) -> str | None:
    return doc.split("//")[0] if doc else doc


def test_document_follows_the_contract(fake_environment, package_root):
    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    classes = {record["id"]: record for record in document["classes"]}
    device = classes[f"{OBJECTS}.Device"]
    assert device["description"] == "A device"
    assert device["annotations"]["code"] == "DEVICE"
    assert device["bases"] == [f"{OBJECTS}.BaseEntity"]
    assert [ref["name"] for ref in device["effective_attributes"]] == ["base_value", "identifier", "status", "length"]
    status = next(item for item in device["attributes"] if item["name"] == "status")
    assert status["range"] == {"kind": "enum", "name": f"{VOCABULARIES}.DeviceStatus.terms"}
    assert status["annotations"]["display_dtype"] == "CONTROLLEDVOCABULARY[DEVICE_STATUS]"
    assert status["annotations"]["display_card"] == "0..1"
    # A class without its own definition is still read, without openBIS annotations.
    sensor = classes[f"{OBJECTS}.Sensor"]
    assert "annotations" not in sensor
    owner = next(item for item in sensor["attributes"] if item["name"] == "owner")
    assert owner["range"] == {"kind": "class", "name": f"{OBJECTS}.Device"}
    assert "description" not in owner
    # Terms keep their Python name; only local terms are listed.
    enums = {item["id"]: item for item in document["enums"]}
    assert [value["value"] for value in enums[f"{VOCABULARIES}.ExtendedStatus.terms"]["values"]] == ["RETIRED"]
    none_term = enums[f"{VOCABULARIES}.DeviceStatus.terms"]["values"][1]
    assert none_term == {"value": "NONE", "title": "None", "annotations": {"python_name": "term_none"}}
    modules = {module["name"]: module for module in document["modules"]}
    # Every module-level name of an entity, its own name and other ones (`Instrument = Device`).
    assert modules[OBJECTS]["names"]["Instrument"] == modules[OBJECTS]["names"]["Device"] == f"{OBJECTS}.Device"
    assert f"{NS}.lab.object_types" in modules
    assert document["source"]["module"] == NS


def test_single_module_document_is_named_after_the_module(fake_environment, package_root):
    from api.sources.to_linkml import convert_bam

    document = extract(fake_environment, package_root, "--module", OBJECTS)
    assert document["source"]["module"] == OBJECTS
    schema = convert_bam(document).schema
    assert (schema["name"], schema["id"].rpartition("/")[2]) == (OBJECTS, OBJECTS)


def test_ambiguous_vocabulary_code_resolves_within_the_package(fake_environment, package_root):
    document = extract(fake_environment, package_root, "--module", f"{NS}.lab.object_types")
    sample = next(record for record in document["classes"] if record["id"].endswith(".Sample"))
    assert sample["attributes"][0]["range"] == {"kind": "enum", "name": f"{NS}.lab.vocabularies.Colour.terms"}
    rows = [row for row in document["report"] if row["path"].endswith("Sample.colour")]
    assert [row["status"] for row in rows] == ["warning"]
    assert "ambiguous vocabulary_code 'COLOUR'" in rows[0]["reason"]


def test_roots_limit_the_starting_points(fake_environment, package_root):
    document = extract(fake_environment, package_root, "--module", OBJECTS, "--root", "Device")
    assert document["modules"] == [{"name": OBJECTS, "classes": [f"{OBJECTS}.Device"]}]
    with pytest.raises(ExtractorError, match="Missing"):
        extract(fake_environment, package_root, "--module", OBJECTS, "--root", "Missing")


def test_entity_types_are_base_classes(fake_environment, package_root):
    """ObjectType and the other entity types are kept as bases, like NOMAD's ArchiveSection; BaseEntity is not."""
    from api.sources.to_linkml import convert_bam

    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    classes = {record["id"]: record for record in document["classes"]}
    framework = sorted(name for name in classes if name.startswith("bam_masterdata.metadata."))
    # DatasetType is not a base of any schema class here, so it is not reached.
    assert framework == [f"{ENTITIES}.CollectionType", f"{ENTITIES}.ObjectType", f"{ENTITIES}.VocabularyType"]
    assert classes[f"{ENTITIES}.ObjectType"]["bases"] == []
    assert classes[f"{ENTITIES}.ObjectType"]["description"] == "Base class used to define object types."
    assert "annotations" not in classes[f"{ENTITIES}.ObjectType"]
    assert classes[f"{OBJECTS}.BaseEntity"]["bases"] == [f"{ENTITIES}.ObjectType"]
    assert classes[f"{VOCABULARIES}.DeviceStatus"]["bases"] == [f"{ENTITIES}.VocabularyType"]
    # A framework type's own properties are read and inherited; VocabularyType has no terms of its own.
    collection = classes[f"{ENTITIES}.CollectionType"]
    assert [item["name"] for item in collection["attributes"]] == ["default_view"]
    assert classes[f"{NS}.collection_types.Campaign"]["effective_attributes"] == [
        {"kind": "property", "name": "default_view", "declaring_class_id": f"{ENTITIES}.CollectionType"},
    ]
    assert all(not item["id"].startswith("bam_masterdata.metadata.") for item in document["enums"])
    # No module offers them, though every module imports one.
    assert all(not cid.startswith("bam_masterdata.metadata.") for module in document["modules"] for cid in module["classes"])
    assert not [row for row in document["report"] if "metadata" in row["path"]]
    conversion = convert_bam(document)
    assert conversion.schema["classes"][f"{OBJECTS}.BaseEntity"]["is_a"] == f"{ENTITIES}.ObjectType"
    assert "inherits" not in conversion.schema["enums"][f"{VOCABULARIES}.DeviceStatus.terms"]
    assert not [row for row in conversion.report if row["status"] == "partial" and "metadata" in row["path"]]


def test_only_the_datamodel_is_read(fake_environment, package_root):
    with pytest.raises(ExtractorError, match="only modules within"):
        extract(fake_environment, package_root, "--module", "bam_masterdata.metadata.entities")


@pytest.mark.parametrize("package,root", [
    (OBJECTS, None), (OBJECTS, "Device"), (OBJECTS, "Sensor"), (OBJECTS, "Instrument"),
    (VOCABULARIES, None), (VOCABULARIES, "ExtendedStatus"), (f"{NS}.lab.object_types", None),
])
@pytest.mark.parametrize("flags", [{}, {"allow_cross_module": False}, {"include_quantities": False}])
def test_same_graph_as_the_graph_builder(fake_environment, package_root, legacy_builder, package, root, flags):
    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    expected = legacy_builder.build_graph(package, root=root, base_namespace=NS, **flags)
    result = without_added_fields(linkml_graph(document, package, root=root, **flags))
    for node in expected["nodes"]:
        # Explained differences: the German half of a description moves to
        # `doc_de`; a property or term without a description of its own gets
        # none (the graph builder shows the docstring of its definition class).
        generic = (node["doc"] or "").startswith(("PropertyTypeAssignment(", "VocabularyTerm("))
        node["doc"] = None if generic else english(node["doc"])
    assert result == expected


def test_roots_and_modules_match_the_graph_builder(fake_environment, package_root, legacy_builder):
    from api.sources import graph
    from api.sources.to_linkml import convert_bam

    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    schema = convert_bam(document).schema
    for module in document["modules"]:
        assert graph.section_names(schema, document, module["name"]) == legacy_builder.list_sections(module["name"])


def test_branch_expectations_hold_on_the_new_path(fake_environment, package_root):
    """The cases of test_graph_builder_bam.py, through bam.py, the converter and the graph adapter."""
    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    result = linkml_graph(document, OBJECTS, root="Device")
    nodes = {node["id"]: node for node in result["nodes"]}
    device = f"{OBJECTS}.Device"
    assert nodes[f"{device}.identifier"]["dtype"] == "VARCHAR"
    assert nodes[f"{device}.identifier"]["card"] == "1..1"
    assert nodes[f"{device}.status"]["dtype"] == "CONTROLLEDVOCABULARY[DEVICE_STATUS]"
    assert nodes[f"{device}.status"]["card"] == "0..1"
    assert nodes[f"{device}.base_value"]["dtype"] == "INTEGER"
    edges = {(e["source"], e["target"], e["type"]) for e in result["edges"]}
    assert (device, f"{OBJECTS}.BaseEntity", "inherits") in edges
    # The framework's entity types are base sections; their root is left out.
    assert (device, f"{ENTITIES}.ObjectType", "inherits") in edges
    assert {node_id for node_id in nodes if node_id.startswith("bam_masterdata.metadata.")} == {f"{ENTITIES}.ObjectType"}

    terms = linkml_graph(document, VOCABULARIES, root="ExtendedStatus")
    nodes = {node["id"]: node for node in terms["nodes"]}
    extended = f"{VOCABULARIES}.ExtendedStatus"
    # Terms of the base vocabulary are shown on the child too, named by their Python name.
    assert [nodes[f"{extended}.{name}"]["dtype"] for name in ("active", "term_none", "retired")] == ["VOCAB_TERM"] * 3
    assert nodes[f"{extended}.active"]["doc"] == "Device is active"
    assert nodes[f"{extended}.active"]["doc_de"] == "Gerät ist aktiv"
    assert nodes[f"{extended}.term_none"]["code"] == "NONE"


def test_openbis_facts_reach_the_nodes(fake_environment, package_root):
    document = extract(fake_environment, package_root, "--base", NS, "--discovery", "walk")
    nodes = {node["id"]: node for node in linkml_graph(document, OBJECTS, root="Device")["nodes"]}
    device = f"{OBJECTS}.Device"
    assert nodes[device]["code"] == "DEVICE"
    assert nodes[device]["iri"] == "http://purl.obolibrary.org/bam-masterdata/Device:1.0.0"
    identifier = nodes[f"{device}.identifier"]
    assert {key: identifier.get(key) for key in ADDED_FIELDS} == {
        "unit": None, "code": "IDENTIFIER", "title": "Identifier", "title_de": None,
        "doc_de": "Eindeutige Kennung", "mandatory": True, "section": None, "iri": None,
    }
    assert nodes[f"{device}.length"]["unit"] == "mm"
    assert nodes[f"{device}.base_value"]["section"] == "General"
    assert nodes[f"{device}.base_value"]["mandatory"] is False

    # A class without its own definition: no code, but the German half of the inherited description.
    probe = {node["id"]: node for node in linkml_graph(document, OBJECTS, root="Probe")["nodes"]}[f"{OBJECTS}.Probe"]
    assert (probe["doc"], probe["doc_de"], probe.get("code")) == ("Base entity", "Basisobjekt", None)

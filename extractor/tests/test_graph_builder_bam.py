from __future__ import annotations

from pathlib import Path
import importlib
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from extractor.graph_builder import build_graph, list_sections


def _write_fake_bam_package(root: Path) -> None:
    files: dict[str, str] = {
        "bam_masterdata/__init__.py": "",
        "bam_masterdata/metadata/__init__.py": "",
        "bam_masterdata/datamodel/__init__.py": "",
        "bam_masterdata/metadata/entities.py": """
class ObjectType:
    pass


class CollectionType(ObjectType):
    pass


class DatasetType(ObjectType):
    pass


class VocabularyType:
    pass
""",
        "bam_masterdata/metadata/definitions.py": """
from dataclasses import dataclass


class DataType:
    def __init__(self, value: str):
        self.value = value

    def __str__(self) -> str:
        return f"DataType.{self.value}"


@dataclass
class PropertyTypeAssignment:
    code: str
    data_type: object
    property_label: str
    description: str
    mandatory: bool
    vocabulary_code: str | None = None
    object_code: str | None = None


@dataclass
class VocabularyTerm:
    code: str
    label: str
    description: str
""",
        "bam_masterdata/datamodel/object_types.py": """
from bam_masterdata.metadata.definitions import DataType, PropertyTypeAssignment
from bam_masterdata.metadata.entities import ObjectType


class BaseEntity(ObjectType):
    base_value = PropertyTypeAssignment(
        code="BASE_VALUE",
        data_type=DataType("INTEGER"),
        property_label="Base value",
        description="Base value",
        mandatory=False,
    )


class Device(BaseEntity):
    identifier = PropertyTypeAssignment(
        code="IDENTIFIER",
        data_type=DataType("VARCHAR"),
        property_label="Identifier",
        description="Unique identifier",
        mandatory=True,
    )

    status = PropertyTypeAssignment(
        code="STATUS",
        data_type=DataType("CONTROLLEDVOCABULARY"),
        property_label="Status",
        description="Device status",
        mandatory=False,
        vocabulary_code="DEVICE_STATUS",
    )
""",
        "bam_masterdata/datamodel/vocabulary_types.py": """
from bam_masterdata.metadata.definitions import VocabularyTerm
from bam_masterdata.metadata.entities import VocabularyType


class DeviceStatus(VocabularyType):
    active = VocabularyTerm(code="ACTIVE", label="Active", description="Device is active")
""",
    }

    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def test_build_graph_extracts_bam_object_types_and_controlled_vocab(monkeypatch, tmp_path: Path):
    _write_fake_bam_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    sections = list_sections("bam_masterdata.datamodel.object_types")
    assert sections == ["BaseEntity", "Device"]

    graph = build_graph(
        package="bam_masterdata.datamodel.object_types",
        root="Device",
        base_namespace="bam_masterdata.datamodel",
    )

    nodes_by_id = {node["id"]: node for node in graph["nodes"]}

    section_id = "bam_masterdata.datamodel.object_types.Device"
    assert section_id in nodes_by_id

    identifier = nodes_by_id[f"{section_id}.identifier"]
    assert identifier["dtype"] == "VARCHAR"
    assert identifier["card"] == "1..1"

    status = nodes_by_id[f"{section_id}.status"]
    assert status["dtype"] == "CONTROLLEDVOCABULARY[DEVICE_STATUS]"
    assert status["card"] == "0..1"

    inherited = nodes_by_id[f"{section_id}.base_value"]
    assert inherited["dtype"] == "INTEGER"

    edge_types = {(edge["source"], edge["target"], edge["type"]) for edge in graph["edges"]}
    assert (
        "bam_masterdata.datamodel.object_types.Device",
        "bam_masterdata.datamodel.object_types.BaseEntity",
        "inherits",
    ) in edge_types


def test_build_graph_extracts_bam_vocabulary_terms(monkeypatch, tmp_path: Path):
    _write_fake_bam_package(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    graph = build_graph(
        package="bam_masterdata.datamodel.vocabulary_types",
        root="DeviceStatus",
        base_namespace="bam_masterdata.datamodel",
    )

    nodes_by_id = {node["id"]: node for node in graph["nodes"]}
    term_id = "bam_masterdata.datamodel.vocabulary_types.DeviceStatus.active"
    assert term_id in nodes_by_id
    assert nodes_by_id[term_id]["dtype"] == "VOCAB_TERM"
    assert nodes_by_id[term_id]["doc"] == "Device is active"

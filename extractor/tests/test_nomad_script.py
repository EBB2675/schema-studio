"""`extractor/scripts/nomad.py` on a small NOMAD-like package, started through the runner.

The package and a stand-in for NOMAD's metainfo framework are written to a
temporary folder and imported through `--source-root`, so no schema package is
needed. Checks against the real schemas are in `test_nomad_real.py` (slow).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from extractor.contract import validate_document
from extractor.runner import ExtractorError, run_script
from extractor.tests.parity import differences

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

FRAMEWORK = '''
import inspect


class Section:
    def __init__(self, section_cls):
        self.section_cls = section_cls
        self.name = section_cls.__name__
        self.description = inspect.cleandoc(section_cls.__doc__) if section_cls.__doc__ else None
        self.quantities = []
        self.sub_sections = []
        self.extending_sections = []

    def _all(self, attr):
        found = {}
        for base in reversed(self.section_cls.__mro__):
            definition = vars(base).get("m_def")
            if isinstance(definition, Section):
                for item in getattr(definition, attr):
                    found[item.name] = item
        return found

    @property
    def all_quantities(self):
        return self._all("quantities")

    @property
    def all_sub_sections(self):
        return self._all("sub_sections")


class Quantity:
    """Generic text about quantities in general."""

    def __init__(self, type=None, shape=None, unit=None, description=None):
        self.type = type
        self.shape = [] if shape is None else shape
        self.unit = unit
        self.description = description

    def __set_name__(self, owner, name):
        self.name = name


class SubSection:
    """Generic text about subsections in general."""

    def __init__(self, sub_section, repeats=False, description=None):
        self.sub_section = sub_section
        self.repeats = repeats
        self.description = description

    def __set_name__(self, owner, name):
        self.name = name


class Datatype:
    def __init__(self, name):
        self.name = name

    def serialize_self(self):
        return {"type_kind": "numpy", "type_data": self.name}

    def __str__(self):
        return f"m_{self.name}({self.name})"


m_str = Datatype("str")
m_float64 = Datatype("float64")


class MEnum:
    def __init__(self, *values):
        self.values = list(values)

    def serialize_self(self):
        return {"type_kind": "enum", "type_data": self.values}

    def __str__(self):
        return f"MEnum({', '.join(self.values)})"


class Reference:
    def __init__(self, target):
        self.target_section_def = target

    def serialize_self(self):
        raise RuntimeError("needs a section context")

    def __str__(self):
        return "Reference"


class MSection:
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        definition = Section(cls)
        for value in vars(cls).values():
            if isinstance(value, Quantity):
                definition.quantities.append(value)
                value.m_parent = definition
            elif isinstance(value, SubSection):
                definition.sub_sections.append(value)
                value.m_parent = definition
        cls.m_def = definition


MSection.m_def = Section(MSection)


class CategoryDefinition:
    def __init__(self, cls):
        self.section_cls = cls
        self.description = None


class Category:
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        cls.m_def = CategoryDefinition(cls)


class SchemaPackage:
    def __init__(self, section_definitions):
        self.section_definitions = section_definitions
'''

FILES = {
    "nomad/__init__.py": "",
    # Defined in nomad.metainfo.metainfo and re-exported, as in NOMAD.
    "nomad/metainfo/__init__.py": "from nomad.metainfo.metainfo import *  # noqa: F403\n",
    "nomad/metainfo/metainfo.py": FRAMEWORK,
    "fakeschema/__init__.py": "",
    "fakeschema/base.py": '''
from nomad.metainfo import MSection, Quantity, m_str


def helper_function(section):
    """Help a section along."""
    return section


def normalize_entity_defaults(section):
    """Module-level normalizer for entities."""
    return section


class Entity(MSection):
    """
    Something with a name.
    """

    name = Quantity(type=m_str, description="  Name of the entity.  ")
    comment = Quantity(type=m_str)

    def normalize(self, archive, logger):
        """Fill in defaults. Called by the framework."""
        self.check_name()
        helper_function(self)

    def check_name(self):
        """Check the name."""

    def _private(self):
        pass
''',
    "fakeschema/measurement.py": '''
print("schema imports may print to stdout")

from nomad.metainfo import (
    Category, MEnum, MSection, Quantity, Reference, SchemaPackage, SubSection, m_float64, m_str,
)
from fakeschema.base import Entity


class MeasurementCategory(Category):
    pass


class Sample(Entity):
    mass = Quantity(type=m_float64, unit="kg", description="Mass.")


class Plot(MSection):
    """Plot mixin."""

    figures = Quantity(type=m_str, shape=["*"], description="Figures.")

    def plot(self):
        """Make a plot."""


class Result(MSection):
    intensity = Quantity(type=m_float64, shape=["n_points"], unit="1/s", description="Counts.")
    mode = Quantity(type=MEnum("fast", "slow"), description="Mode.")


class Measurement(Entity, Plot):
    """A measurement."""

    sample = Quantity(type=Reference(Sample.m_def), description="The sample.")
    framework_ref = Quantity(type=Reference(MSection.m_def), description="Points at the framework.")
    results = SubSection(sub_section=Result.m_def, repeats=True)
    best_result = SubSection(sub_section=Result.m_def, description="Best one.")


m_package = SchemaPackage([Sample.m_def, Measurement.m_def])
''',
    "fakeschema/helpers.py": "from fakeschema.base import Entity\n\nVALUE = 1\n",
    "fakeschema/broken.py": "import missing_dependency\n",
    "fakeschema/plugin.py": '''
import importlib


class SchemaPackageEntryPoint:
    def __init__(self, module):
        self.module = module

    def load(self):
        return importlib.import_module(self.module).m_package


class ParserEntryPoint:
    def load(self):
        raise AssertionError("parser entry points must not be loaded")


measurement_schema = SchemaPackageEntryPoint("fakeschema.measurement")
measurement_parser = ParserEntryPoint()
''',
    "fake_schema-0.1.dist-info/METADATA": "Metadata-Version: 2.1\nName: fake-schema\nVersion: 0.1\n",
    "fake_schema-0.1.dist-info/entry_points.txt": (
        "[nomad.plugin]\n"
        "measurement_schema = fakeschema.plugin:measurement_schema\n"
        "measurement_parser = fakeschema.plugin:measurement_parser\n"
    ),
}

MEASUREMENT = "fakeschema.measurement"


@pytest.fixture()
def source_root(tmp_path: Path) -> Path:
    root = tmp_path / "worktree" / "src"
    for name, content in FILES.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.lstrip("\n"))
    return root


def _nomad(environment, source_root: Path, *arguments: str) -> dict:
    payload = run_script(
        environment,
        SCRIPTS / "nomad.py",
        arguments=("--dist", "fake-schema", "--source-root", str(source_root), *arguments),
    )
    assert payload["ok"] is True
    return validate_document(payload["result"])


def _legacy(environment, source_root: Path, command: str, **arguments):
    payload = run_script(
        environment,
        SCRIPTS / "legacy.py",
        arguments=("--source-root", str(source_root), command, json.dumps(arguments)),
    )
    return payload["result"]


def _classes(document: dict) -> dict[str, dict]:
    return {item["id"]: item for item in document["classes"]}


def _attribute(document: dict, class_id: str, name: str) -> dict:
    return next(item for item in _classes(document)[class_id]["attributes"] if item["name"] == name)


def test_a_module_becomes_a_valid_document(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)

    assert document["source"] == {
        "name": "fake-schema", "version": "0.1", "module": MEASUREMENT, "dependencies": {},
    }
    assert sorted(_classes(document)) == [
        "fakeschema.base.Entity",
        "fakeschema.measurement.Measurement",
        "fakeschema.measurement.Plot",
        "fakeschema.measurement.Result",
        "fakeschema.measurement.Sample",
    ]
    assert document["modules"] == [{"name": MEASUREMENT, "classes": sorted(_classes(document))}]
    measurement = _classes(document)["fakeschema.measurement.Measurement"]
    assert measurement["bases"] == ["fakeschema.base.Entity", "fakeschema.measurement.Plot"]
    assert [(ref["name"], ref["declaring_class_id"].rsplit(".", 1)[-1]) for ref in measurement["effective_attributes"]] == [
        ("best_result", "Measurement"), ("comment", "Entity"), ("figures", "Plot"),
        ("framework_ref", "Measurement"), ("name", "Entity"), ("results", "Measurement"),
        ("sample", "Measurement"),
    ]
    assert measurement["methods"] == [
        {"name": "check_name", "module": "fakeschema.base"},
        {"name": "normalize", "module": "fakeschema.base"},
        {"name": "plot", "module": MEASUREMENT},
    ]
    assert _attribute(document, "fakeschema.measurement.Result", "mode")["range"] == {
        "kind": "enum", "name": "fakeschema.measurement.Result.mode",
    }
    assert document["enums"] == [{"id": "fakeschema.measurement.Result.mode", "values": ["fast", "slow"]}]
    assert _attribute(document, "fakeschema.measurement.Result", "intensity") == {
        "name": "intensity", "kind": "quantity", "description": "Counts.",
        "range": {"kind": "datatype", "name": '{"type_data": "float64", "type_kind": "numpy"}'},
        "unit": "1/s", "shape": ["n_points"],
        "annotations": {"display_dtype": "m_float64(float64)", "display_shape": "['n_points']"},
    }
    assert _attribute(document, "fakeschema.measurement.Measurement", "results") == {
        "name": "results", "kind": "subsection", "repeats": True,
        "range": {"kind": "class", "name": "fakeschema.measurement.Result"},
        "annotations": {"display_card": "0..*"},
    }


def test_problems_are_reported_and_nothing_disappears_silently(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)

    assert document["report"] == [
        {"path": "fakeschema.measurement.Measurement.framework_ref", "status": "partial",
         "reason": "reference target unreadable, kept as datatype: metainfo framework class excluded from source model"},
        {"path": "fakeschema.measurement.MeasurementCategory", "status": "skipped",
         "reason": "not a section: its definition is a CategoryDefinition"},
    ]
    assert _attribute(document, "fakeschema.measurement.Measurement", "framework_ref")["range"] == {
        "kind": "datatype", "name": "Reference[metainfo.MSection]",
    }


def test_display_values_match_the_legacy_graph(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)
    graph = _legacy(fake_environment, source_root, "graph", package=MEASUREMENT, base_namespace="fakeschema")

    assert len([node for node in graph["nodes"] if node["kind"] == "quantity"]) > 10
    assert differences(document, graph, "fakeschema") == []
    sample = _attribute(document, "fakeschema.measurement.Measurement", "sample")
    assert sample["annotations"]["display_dtype"] == "Reference[measurement.Sample]"
    assert sample["range"] == {"kind": "class", "name": "fakeschema.measurement.Sample"}
    best = _attribute(document, "fakeschema.measurement.Measurement", "best_result")
    assert best["annotations"] == {"display_card": "0..1"}


def test_descriptions_fall_back_to_the_class_docstring_only(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)
    graph = _legacy(fake_environment, source_root, "graph", package=MEASUREMENT, base_namespace="fakeschema")
    shown = {node["id"]: node["doc"] for node in graph["nodes"]}

    assert _classes(document)["fakeschema.base.Entity"]["description"] == "Something with a name."
    assert _attribute(document, "fakeschema.base.Entity", "name")["description"] == "Name of the entity."
    # The graph shows the framework's text for an undocumented quantity; the document does not.
    assert shown["fakeschema.base.Entity.comment"] == "Generic text about quantities in general."
    assert "description" not in _attribute(document, "fakeschema.base.Entity", "comment")


def test_source_file_and_line_are_annotations(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)
    annotations = _classes(document)["fakeschema.measurement.Measurement"]["annotations"]

    assert annotations["source_file"] == "fakeschema/measurement.py"
    lines = (source_root / "fakeschema" / "measurement.py").read_text().splitlines()
    assert lines[annotations["source_line"] - 1] == "class Measurement(Entity, Plot):"


def _key(entry: dict) -> str:
    return json.dumps(entry, sort_keys=True)


def test_usage_matches_the_legacy_usage_index(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT)

    for class_id in ("fakeschema.base.Entity", "fakeschema.measurement.Measurement"):
        expected = _legacy(fake_environment, source_root, "usage", section_id=class_id)
        expected = [{k: v for k, v in entry.items() if v is not None} for entry in expected]
        assert sorted(document["usage"][class_id], key=_key) == sorted(expected, key=_key)
    assert {entry["short_name"] for entry in document["usage"]["fakeschema.base.Entity"]} == {
        "normalize", "normalize_entity_defaults", "check_name", "helper_function",
    }
    assert "fakeschema.measurement.Result" not in document["usage"]

    assert "usage" not in _nomad(fake_environment, source_root, "--module", MEASUREMENT, "--no-usage")


def test_modules_are_found_through_schema_entry_points(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--base", "fakeschema", "--discovery", "entry-points")

    assert [module["name"] for module in document["modules"]] == [MEASUREMENT]
    assert document["source"]["module"] == "fakeschema"
    catalog = _legacy(fake_environment, source_root, "catalog", base="fakeschema", dist="fake-schema", discovery=["entry-points"])
    assert [module["package"] for module in catalog["modules"]] == [MEASUREMENT]


def test_walking_reports_modules_that_fail_or_define_no_sections(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--base", "fakeschema", "--discovery", "walk")

    assert [module["name"] for module in document["modules"]] == ["fakeschema.base", MEASUREMENT]
    report = {row["path"]: (row["status"], row["reason"]) for row in document["report"]}
    assert report["fakeschema.broken"] == ("skipped", "ModuleNotFoundError: No module named 'missing_dependency'")
    for module in ("fakeschema", "fakeschema.helpers", "fakeschema.plugin"):
        assert report[module] == ("warning", "module defines no sections")


def test_a_root_limits_where_reading_starts(fake_environment, source_root):
    document = _nomad(fake_environment, source_root, "--module", MEASUREMENT, "--root", "Result")

    assert [item["id"] for item in document["classes"]] == ["fakeschema.measurement.Result"]
    assert document["modules"] == [{"name": MEASUREMENT, "classes": ["fakeschema.measurement.Result"]}]


def test_output_is_deterministic(fake_environment, source_root):
    arguments = ("--base", "fakeschema", "--discovery", "walk")

    assert _nomad(fake_environment, source_root, *arguments) == _nomad(fake_environment, source_root, *arguments)


@pytest.mark.parametrize(
    ("arguments", "error_type", "message"),
    [
        (("--module", "fakeschema.missing"), "ModuleNotFoundError", "fakeschema.missing"),
        (("--module", MEASUREMENT, "--root", "Nothing"), "ValueError", "Root section 'Nothing' not found"),
        (("--base", "fakeschema", "--root", "Result"), "ValueError", "--root needs exactly one --module"),
        ((), "ValueError", "give --module or --base"),
    ],
)
def test_errors_are_one_json_document(fake_environment, source_root, arguments, error_type, message):
    with pytest.raises(ExtractorError) as exc:
        run_script(
            fake_environment,
            SCRIPTS / "nomad.py",
            arguments=("--dist", "fake-schema", "--source-root", str(source_root), *arguments),
        )

    payload = json.loads(exc.value.stdout)
    assert payload["ok"] is False
    assert payload["error"]["type"] == error_type
    assert message in payload["error"]["message"]

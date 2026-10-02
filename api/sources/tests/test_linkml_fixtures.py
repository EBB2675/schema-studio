"""The converter on the stored NOMAD extraction documents."""
from __future__ import annotations

import subprocess
import sys

import pytest
from linkml_runtime.utils.schemaview import SchemaView

from api.sources.linkml_yaml import dump_yaml
from api.sources.to_linkml import convert_nomad

from .conftest import PROJECT_ROOT, load_fixture

PROFILES = ["nomad-simulations", "nomad-measurements"]
# Every gap the stored documents are expected to show; anything else is a surprise to look at.
KNOWN_PARTIAL = ("symbolic shape dimensions kept as names only", "unmapped source type", "unmapped source unit")


def export(profile: str) -> str:
    document = load_fixture(profile)
    conversion = convert_nomad(document)
    return dump_yaml(conversion.schema, profile=profile, source=document["source"], tools={"linkml-runtime": "1.11.1"})


@pytest.mark.parametrize("profile", PROFILES)
def test_same_input_gives_same_bytes(profile):
    assert export(profile) == export(profile)


@pytest.mark.parametrize("profile", PROFILES)
def test_fixture_loads_in_schemaview_with_inherited_slots(profile):
    document = load_fixture(profile)
    view = SchemaView(export(profile))
    assert len(view.all_classes()) == len(document["classes"])
    assert len(view.all_enums()) == len(document["enums"])
    for row in document["classes"]:
        induced = {str(slot.name) for slot in view.class_induced_slots(row["id"])}
        assert induced == {ref["name"] for ref in row["effective_attributes"]}, row["id"]


@pytest.mark.parametrize("profile", PROFILES)
def test_fixture_report_has_only_known_gaps(profile):
    document = load_fixture(profile)
    report = convert_nomad(document).report
    assert report[: len(document["report"])] == document["report"]
    added = report[len(document["report"]):]
    assert all(row["status"] == "partial" for row in added)
    assert [row for row in added if not row["reason"].startswith(KNOWN_PARTIAL)] == []


@pytest.mark.parametrize("profile", PROFILES)
def test_display_annotations_survive_on_every_attribute(profile):
    document = load_fixture(profile)
    schema = convert_nomad(document).schema
    for row in document["classes"]:
        for attribute in row["attributes"]:
            expected = {k: v for k, v in (attribute.get("annotations") or {}).items() if k.startswith("display_")}
            converted = schema["classes"][row["id"]]["attributes"][attribute["name"]]["annotations"]
            assert {k: v for k, v in converted.items() if k.startswith("display_")} == expected


def test_yaml_export_does_not_need_linkml_runtime():
    """The export runs in the browser later, so it may only use the standard library and PyYAML."""
    code = (
        "import sys, api.sources.linkml_yaml as m; "
        "print(m.dump_yaml({'id': 'x', 'name': 'x'}, profile='p', source={}, tools={})[:1]); "
        "print(any(n.split('.')[0] in {'linkml_runtime', 'fastapi', 'pydantic'} for n in sys.modules))"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=PROJECT_ROOT, capture_output=True, text=True, check=True)
    assert out.stdout.split() == ["#", "False"]

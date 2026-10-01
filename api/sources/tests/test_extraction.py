"""SCHEMA_STUDIO_EXTRACTION: graphs and usage info through the legacy path or through LinkML."""
from __future__ import annotations

import pytest

from .conftest import load_fixture

MODEL_METHOD = "nomad_simulations.schema_packages.model_method"


@pytest.fixture()
def extraction(monkeypatch):
    from api.sources import extraction as module
    from api.sources.snapshots import make_snapshot

    calls: list[tuple] = []

    def legacy_graph(package, **kwargs):
        calls.append(("legacy-graph", package, kwargs))
        return {"package": package, "from": "legacy"}

    def legacy_sections(package):
        calls.append(("legacy-sections", package))
        return ["Legacy"]

    def legacy_modules(base):
        calls.append(("legacy-modules", base))
        return []

    def legacy_usage(section_id):
        calls.append(("legacy-usage", section_id))
        return ()

    def snapshot(profile, scope=None, **kwargs):
        calls.append(("snapshot", profile.key, scope, kwargs))
        return make_snapshot(profile, scope, load_fixture(profile.key))

    monkeypatch.setattr(module.legacy, "build_graph", legacy_graph)
    monkeypatch.setattr(module.legacy, "get_usage_for_section", legacy_usage)
    monkeypatch.setattr(module.legacy, "list_sections", legacy_sections)
    monkeypatch.setattr(module.legacy, "list_schema_modules", legacy_modules)
    monkeypatch.setattr(module, "get_snapshot", snapshot)
    monkeypatch.delenv(module.EXTRACTION_SETTING, raising=False)
    module.calls = calls
    return module


def profile(key):
    from api.light_mode.schema_source import SCHEMA_PROFILES

    return SCHEMA_PROFILES[key]


@pytest.mark.parametrize("setting,expected", [
    ("", {"nomad-simulations": "linkml", "nomad-measurements": "linkml", "bam-masterdata": "legacy"}),
    ("legacy", {"nomad-simulations": "legacy", "nomad-measurements": "legacy", "bam-masterdata": "legacy"}),
    ("linkml", {"nomad-simulations": "linkml", "nomad-measurements": "linkml", "bam-masterdata": "linkml"}),
    ("nomad-measurements=legacy", {"nomad-simulations": "linkml", "nomad-measurements": "legacy", "bam-masterdata": "legacy"}),
    ("bam-masterdata=linkml", {"nomad-simulations": "linkml", "nomad-measurements": "linkml", "bam-masterdata": "linkml"}),
    ("linkml, nomad-simulations=legacy", {"nomad-simulations": "legacy", "nomad-measurements": "linkml", "bam-masterdata": "linkml"}),
    ("LINKML", {"nomad-simulations": "linkml", "nomad-measurements": "linkml", "bam-masterdata": "linkml"}),
    ("fast", {"nomad-simulations": "linkml", "nomad-measurements": "linkml", "bam-masterdata": "legacy"}),
])
def test_setting_chooses_the_path_per_profile(extraction, monkeypatch, setting, expected):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, setting)
    assert {key: extraction.extraction_mode(profile(key)) for key in expected} == expected


def test_linkml_is_the_default_and_legacy_can_be_chosen(extraction, monkeypatch):
    extraction.build_graph(MODEL_METHOD, root="ModelMethod")
    assert extraction.calls[0][0] == "snapshot"
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "legacy")
    assert extraction.build_graph(MODEL_METHOD, root="ModelMethod")["from"] == "legacy"
    # bam-masterdata stays on the legacy path unless the setting names it.
    monkeypatch.delenv(extraction.EXTRACTION_SETTING)
    extraction.build_graph("bam_masterdata.datamodel.object_types")
    assert extraction.calls[-1][0] == "legacy-graph"


def test_linkml_path_builds_the_graph_from_the_snapshot(extraction, monkeypatch):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "linkml")
    result = extraction.build_graph(MODEL_METHOD, root="ModelMethod", base_namespace="nomad_simulations.schema_packages")
    assert extraction.calls == [("snapshot", "nomad-simulations", MODEL_METHOD, {"source_root": None, "source_version": None})]
    assert result["root"] == "ModelMethod"
    assert "nomad_simulations.schema_packages.model_method.ModelMethod" in {node["id"] for node in result["nodes"]}


def test_linkml_path_reports_an_unknown_root_like_the_legacy_path(extraction, monkeypatch):
    from api.sources.legacy import ExtractionFailed

    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "linkml")
    with pytest.raises(ExtractionFailed, match="ValueError: Root section 'Nope' not found"):
        extraction.build_graph(MODEL_METHOD, root="Nope")


def test_a_custom_extractor_stays_on_the_legacy_path(extraction, monkeypatch):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "linkml")
    extraction.build_graph(MODEL_METHOD, extractor="mypackage.graphs:build")
    assert extraction.calls[0][0] == "legacy-graph"
    extraction.calls.clear()
    extraction.build_graph(MODEL_METHOD, extractor=extraction.DEFAULT_EXTRACTOR, source_root="/tmp/wt", source_version="abc")
    assert extraction.calls[0][-1] == {"source_root": "/tmp/wt", "source_version": "abc"}


def test_usage_comes_from_the_snapshot_of_the_module_shown(extraction, monkeypatch):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "linkml")
    document = load_fixture("nomad-simulations")
    section_id, expected = next(iter(document["usage"].items()))
    entries = extraction.get_usage_for_section(section_id, MODEL_METHOD)
    assert [entry.qualname for entry in entries] == [entry["qualname"] for entry in expected]
    assert [call[2] for call in extraction.calls] == [MODEL_METHOD]

    # A nomad-lab base section names no profile: the module shown decides it.
    extraction.calls.clear()
    base = next(record["id"] for record in document["classes"] if record["id"].startswith("nomad."))
    entries = extraction.get_usage_for_section(base, MODEL_METHOD)
    assert [entry.qualname for entry in entries] == [entry["qualname"] for entry in document["usage"].get(base, [])]
    assert extraction.calls[0][1] == "nomad-simulations"

    # Not in the module's snapshot: the whole profile is looked up, then nothing.
    extraction.calls.clear()
    assert extraction.get_usage_for_section("nomad_simulations.schema_packages.unknown.Thing", MODEL_METHOD) == ()
    assert [call[2] for call in extraction.calls] == [MODEL_METHOD, "nomad_simulations.schema_packages"]


def test_usage_can_stay_legacy(extraction, monkeypatch):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "legacy")
    extraction.get_usage_for_section("nomad_simulations.schema_packages.model_method.ModelMethod", MODEL_METHOD)
    assert extraction.calls == [("legacy-usage", "nomad_simulations.schema_packages.model_method.ModelMethod")]


def test_roots_and_modules_follow_the_setting(extraction, monkeypatch):
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "legacy")
    assert extraction.list_sections(MODEL_METHOD) == ["Legacy"]
    monkeypatch.setenv(extraction.EXTRACTION_SETTING, "linkml")
    roots = extraction.list_sections(MODEL_METHOD)
    assert "ModelMethod" in roots and "ModelSystem" not in roots  # ModelSystem is imported from elsewhere

    modules = extraction.list_schema_modules("nomad_simulations.schema_packages")
    assert [module["package"] for module in modules] == [
        "nomad_simulations.schema_packages.model_method", "nomad_simulations.schema_packages.model_system",
    ]
    assert extraction.calls[-1][2] == "nomad_simulations.schema_packages"
    # Only whole profiles are read on the LinkML path.
    extraction.list_schema_modules("nomad_simulations.schema_packages.properties")
    assert extraction.calls[-1] == ("legacy-modules", "nomad_simulations.schema_packages.properties")

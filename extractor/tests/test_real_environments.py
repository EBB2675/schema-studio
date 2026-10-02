"""
Checks against the real schema packages in `environments/<profile>/`.

Slow and network-dependent to set up, so they are deselected by default:

    uv sync --project environments/<profile>
    pytest -m slow extractor/tests/test_real_environments.py
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.slow

PROFILE_KEYS = ["nomad-simulations", "nomad-measurements", "bam-masterdata"]


@pytest.fixture()
def profile(request, tmp_path, monkeypatch):
    monkeypatch.setenv("SCHEMA_STUDIO_HOME", str(tmp_path / "home"))
    from api.light_mode import schema_source

    selected = schema_source.SCHEMA_PROFILES[request.param]
    if not schema_source.schema_available(selected):
        pytest.skip(f"environment for {selected.key} is not set up")
    return selected


@pytest.mark.parametrize("profile", PROFILE_KEYS, indirect=True)
def test_environment_reports_the_commit_of_its_tracked_branch(profile):
    from api.light_mode import schema_source

    info = schema_source.current_schema_info(profile)

    assert info.source == f"remote-{profile.default_branch}"
    assert info.commit and len(info.commit) == 40


@pytest.mark.parametrize("profile", PROFILE_KEYS, indirect=True)
def test_default_package_and_root_build_a_graph(profile):
    from api.sources import legacy

    modules = {m["package"]: m["sections"] for m in legacy.list_schema_modules(profile.default_base_namespace)}
    assert profile.default_root in modules[profile.default_package]

    graph = legacy.build_graph(profile.default_package, root=profile.default_root, base_namespace=profile.default_base_namespace)
    root_id = f"{profile.default_package}.{profile.default_root}"
    assert any(node["id"] == root_id and node["kind"] == "section" for node in graph["nodes"])


@pytest.mark.parametrize("profile", PROFILE_KEYS, indirect=True)
def test_every_listed_module_builds_a_graph(profile):
    from api.sources import legacy

    modules = legacy.list_schema_modules(profile.default_base_namespace)
    assert modules
    for module in modules:
        graph = legacy.build_graph(module["package"], base_namespace=profile.default_base_namespace)
        assert graph["nodes"], module["package"]


@pytest.mark.parametrize("profile", ["nomad-measurements"], indirect=True)
def test_measurements_modules_come_from_schema_entry_points(profile):
    from api.sources import legacy

    packages = [m["package"] for m in legacy.list_schema_modules(profile.default_base_namespace)]

    assert packages == [
        "nomad_measurements.general",
        "nomad_measurements.mapping.schema",
        "nomad_measurements.quantumdesign.schema",
        "nomad_measurements.transmission.schema",
        "nomad_measurements.xrd.schema",
    ]


@pytest.mark.parametrize("profile", ["nomad-simulations"], indirect=True)
def test_simulations_modules_beyond_the_entry_point_are_found(profile):
    from api.sources import legacy

    packages = {m["package"] for m in legacy.list_schema_modules(profile.default_base_namespace)}

    assert {"general", "model_method", "model_system", "outputs"} <= {p.rsplit(".", 1)[-1] for p in packages}


@pytest.mark.parametrize("profile", ["bam-masterdata"], indirect=True)
def test_bam_datamodel_modules_and_subpackages_are_found(profile):
    from api.sources import legacy

    packages = {m["package"].removeprefix("bam_masterdata.datamodel.") for m in legacy.list_schema_modules(profile.default_base_namespace)}

    assert {"object_types", "vocabulary_types", "collection_types", "dataset_types", "instruments", "activities"} <= packages
    assert any("." in package for package in packages), "subpackages such as welding.object_types are missing"


@pytest.mark.parametrize("profile", ["nomad-simulations", "nomad-measurements"], indirect=True)
def test_usage_is_read_inside_the_environment(profile):
    from api.sources import legacy

    entries = legacy.get_usage_for_section(f"{profile.default_package}.{profile.default_root}")

    assert all(entry.kind in {"normalize_method", "normalize_function", "utility_function"} for entry in entries)

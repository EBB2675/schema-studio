"""
`extractor/scripts/nomad.py` against the real NOMAD profile environments.

Slow, and the environments must be set up first, so these are deselected by default:

    uv sync --project environments/<profile>
    pytest -m slow extractor/tests/test_nomad_real.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from extractor.contract import validate_document
from extractor.runner import run_script
from extractor.tests.parity import differences

pytestmark = pytest.mark.slow

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

# Modules whose display values are compared with the legacy graph.
COMPARED_MODULES = {
    "nomad-simulations": ["model_method", "model_system", "general"],
    "nomad-measurements": ["xrd.schema", "transmission.schema", "general"],
}


@pytest.fixture()
def profile(request, tmp_path, monkeypatch):
    monkeypatch.setenv("SCHEMA_STUDIO_HOME", str(tmp_path / "home"))
    from api.light_mode import schema_source

    selected = schema_source.SCHEMA_PROFILES[request.param]
    if not schema_source.schema_available(selected):
        pytest.skip(f"environment for {selected.key} is not set up")
    return selected


def _extract(profile, *arguments: str) -> dict:
    payload = run_script(profile.environment, SCRIPTS / "nomad.py", arguments=("--dist", profile.package_dist, *arguments))
    assert payload["ok"] is True
    return validate_document(payload["result"])


def _legacy(profile, command: str, **arguments):
    payload = run_script(profile.environment, SCRIPTS / "legacy.py", arguments=(command, json.dumps(arguments)))
    return payload["result"]


@pytest.mark.parametrize("profile", ["nomad-simulations", "nomad-measurements"], indirect=True)
def test_the_whole_profile_is_read_into_a_valid_document(profile):
    from api.light_mode import schema_source

    arguments = ["--base", profile.default_base_namespace]
    for method in profile.discovery:
        arguments += ["--discovery", method]
    document = _extract(profile, *arguments)

    commit = document["source"]["commit"]
    assert re.fullmatch(r"[0-9a-f]{40}", commit)
    assert commit == schema_source.current_schema_info(profile).commit
    assert "nomad-lab" in document["source"]["dependencies"]
    catalog = _legacy(profile, "catalog", base=profile.default_base_namespace, dist=profile.package_dist, discovery=list(profile.discovery))
    assert [module["name"] for module in document["modules"]] == [module["package"] for module in catalog["modules"]]
    assert f"{profile.default_package}.{profile.default_root}" in {item["id"] for item in document["classes"]}
    assert document["usage"]
    # Only metainfo framework references and categories may be left out.
    for row in document["report"]:
        assert row["status"] in {"skipped", "partial", "warning"}
        assert any(text in row["reason"] for text in ("framework", "Category", "declaration was not read", "defines no sections")), row


@pytest.mark.parametrize("profile", ["nomad-simulations", "nomad-measurements"], indirect=True)
def test_display_values_match_the_legacy_graph(profile):
    for name in COMPARED_MODULES[profile.key]:
        package = f"{profile.default_base_namespace}.{name}"
        document = _extract(profile, "--module", package, "--no-usage")
        graph = _legacy(profile, "graph", package=package, base_namespace=profile.default_base_namespace)

        assert any(node["kind"] == "quantity" for node in graph["nodes"]), package
        assert differences(document, graph, profile.default_base_namespace) == [], package


@pytest.mark.parametrize("profile", ["nomad-simulations", "nomad-measurements"], indirect=True)
def test_usage_matches_the_legacy_usage_index(profile):
    document = _extract(profile, "--module", profile.default_package, "--root", profile.default_root)
    class_id = f"{profile.default_package}.{profile.default_root}"

    expected = [{k: v for k, v in entry.items() if v is not None} for entry in _legacy(profile, "usage", section_id=class_id)]
    key = lambda entry: json.dumps(entry, sort_keys=True)  # noqa: E731
    assert sorted(document["usage"].get(class_id, []), key=key) == sorted(expected, key=key)

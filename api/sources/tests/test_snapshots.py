"""Snapshot cache and the LinkML download endpoints, with stored extraction documents."""
from __future__ import annotations

import importlib
import json
import sys
from types import SimpleNamespace

import httpx
import pytest
import yaml

from .conftest import load_fixture


@pytest.fixture()
def snapshots(studio_home, monkeypatch):
    from api.sources import snapshots as module

    module._MEMORY.clear()
    calls: list[tuple[str, str]] = []

    def fake_extract(profile, scope):
        calls.append((profile.key, scope))
        return load_fixture(profile.key)

    info = SimpleNamespace(version="0588fda", source="remote-develop", package_version="1.0", commit="0588fda")
    monkeypatch.setattr(module, "_extract", fake_extract)
    monkeypatch.setattr(module, "current_schema_info", lambda profile: info)
    module.calls = calls
    yield module
    module._MEMORY.clear()


def profile(key: str):
    from api.light_mode.schema_source import SCHEMA_PROFILES

    return SCHEMA_PROFILES[key]


def test_snapshot_holds_extraction_linkml_and_report(snapshots):
    snapshot = snapshots.get_snapshot(profile("nomad-simulations"), "nomad_simulations.schema_packages.model_method")
    document = load_fixture("nomad-simulations")
    assert snapshot["profile"] == "nomad-simulations"
    assert snapshot["scope"] == "nomad_simulations.schema_packages.model_method"
    assert snapshot["source"]["commit"] == document["source"]["commit"]
    # Methods and usage describe code: they stay in the extraction document, next to the schema.
    assert snapshot["extraction"]["usage"] == document["usage"]
    assert snapshot["linkml"]["default_prefix"] == "nomadsim"
    assert snapshot["report"][: len(document["report"])] == document["report"]
    assert set(snapshot["tools"]) == {"extraction-contract", "schema-studio", "linkml-runtime"}
    json.dumps(snapshot)  # plain JSON throughout


def test_snapshot_is_cached_on_disk_and_reconverted_without_extracting(snapshots, studio_home, monkeypatch):
    nomad = profile("nomad-measurements")
    first = snapshots.get_snapshot(nomad, "nomad_measurements.general")
    assert snapshots.calls == [("nomad-measurements", "nomad_measurements.general")]
    files = list((studio_home / "cache" / "snapshots" / "nomad-measurements" / "0588fda").glob("*.json"))
    assert len(files) == 1

    snapshots._MEMORY.clear()
    assert snapshots.get_snapshot(nomad, "nomad_measurements.general") == first
    assert len(snapshots.calls) == 1

    # Changed converter code: the stored extraction document is converted again.
    snapshots._MEMORY.clear()
    monkeypatch.setattr(snapshots, "converter_fingerprint", lambda: "changed")
    again = snapshots.get_snapshot(nomad, "nomad_measurements.general")
    assert again["converter"] == "changed"
    assert len(snapshots.calls) == 1


def test_whole_profile_scope_is_the_base_namespace(snapshots):
    snapshots.get_snapshot(profile("nomad-simulations"))
    assert snapshots.calls == [("nomad-simulations", "nomad_simulations.schema_packages")]


def test_profile_without_converter_is_refused(snapshots):
    with pytest.raises(snapshots.LinkMLUnavailable):
        snapshots.get_snapshot(profile("bam-masterdata"))
    assert snapshots.calls == []


@pytest.fixture()
async def client(snapshots, monkeypatch):
    for name in list(sys.modules):
        if name == "api.light_mode.app":
            sys.modules.pop(name)
    import api.light_mode.app as app_mod
    import api.sources.linkml_routes as routes

    app_mod = importlib.reload(app_mod)
    monkeypatch.setattr(routes, "get_snapshot", snapshots.get_snapshot)
    monkeypatch.setattr(app_mod, "current_schema_info", lambda *a, **k: SimpleNamespace(
        version="0588fda", source="remote-develop", package_version="1.0"))
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client


@pytest.mark.anyio
async def test_linkml_download_endpoint(client):
    response = await client.get("/schema/linkml", params={"package": "nomad_measurements.general"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/yaml")
    assert 'filename="nomad_measurements.general.linkml.yaml"' in response.headers["content-disposition"]
    assert response.text.startswith("# LinkML schema exported by schema-studio\n# profile: nomad-measurements\n")
    assert yaml.safe_load(response.text)["default_prefix"] == "nomadmeas"
    assert "# conversion report: 1 partial, 2 skipped (" in response.text

    report = (await client.get("/schema/linkml/report", params={"package": "nomad_measurements.general"})).json()
    assert report["profile"] == "nomad-measurements"
    assert {row["status"] for row in report["report"]} <= {"skipped", "warning", "partial"}


@pytest.mark.anyio
async def test_linkml_download_for_profile_without_converter(client):
    response = await client.get("/schema/linkml", params={"package": "bam_masterdata.datamodel.object_types"})
    assert response.status_code == 400
    assert "not available for bam-masterdata" in response.json()["detail"]


@pytest.mark.anyio
async def test_profiles_say_which_ones_export_linkml(client):
    profiles = (await client.get("/schema/profiles")).json()["profiles"]
    assert {entry["key"]: entry["linkml_export"] for entry in profiles} == {
        "nomad-simulations": True, "nomad-measurements": True, "bam-masterdata": False,
    }

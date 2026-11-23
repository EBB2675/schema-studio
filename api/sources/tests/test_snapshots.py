"""Snapshot cache and the LinkML download endpoints, with stored extraction documents."""
from __future__ import annotations

import dataclasses
import json
from types import SimpleNamespace

import pytest

from .conftest import load_fixture


@pytest.fixture()
def snapshots(studio_home, monkeypatch):
    from api.sources import snapshots as module

    module._MEMORY.clear()
    calls: list[tuple[str, str]] = []

    def fake_extract(profile, scope, source_root=None):
        calls.append((profile.key, scope))
        return load_fixture(profile.key)

    info = SimpleNamespace(version="0588fda", source="remote-develop", package_version="1.0", commit="0588fda")
    monkeypatch.setattr(module, "_extract", fake_extract)
    monkeypatch.setattr(module, "current_schema_info", lambda profile: info)
    module.calls = calls
    yield module
    module._MEMORY.clear()


def profile(key: str):
    from api.sources.schema_source import SCHEMA_PROFILES

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

    # Changed extractor scripts: the module is extracted again.
    snapshots._MEMORY.clear()
    monkeypatch.setattr(snapshots, "extractor_fingerprint", lambda: "changed")
    assert snapshots.get_snapshot(nomad, "nomad_measurements.general")["extractor"] == "changed"
    assert len(snapshots.calls) == 2


def test_whole_profile_scope_is_the_base_namespace(snapshots):
    snapshots.get_snapshot(profile("nomad-simulations"))
    assert snapshots.calls == [("nomad-simulations", "nomad_simulations.schema_packages")]


def test_profile_without_converter_is_refused(snapshots):
    without = dataclasses.replace(profile("bam-masterdata-v0"), contract_script=None)
    with pytest.raises(snapshots.LinkMLUnavailable):
        snapshots.get_snapshot(without)
    assert snapshots.calls == []


def test_bam_snapshot_uses_the_bam_converter(snapshots):
    snapshot = snapshots.get_snapshot(profile("bam-masterdata-v0"), "bam_masterdata.datamodel.v0.object_types")
    assert snapshot["linkml"]["default_prefix"] == "bammd"
    assert snapshot["source"]["commit"] == load_fixture("bam-masterdata-v0")["source"]["commit"]
    # The schema is named after the module it holds, not after the whole datamodel.
    schema = snapshot["linkml"]
    assert schema["name"] == "bam_masterdata.datamodel.v0.object_types"
    assert schema["id"].endswith("/bam-masterdata/bam_masterdata.datamodel.v0.object_types")
    assert schema["annotations"]["source_module"] == "bam_masterdata.datamodel.v0.object_types"


def test_parallel_requests_extract_a_snapshot_once(studio_home, monkeypatch):
    import threading
    import time

    from api.sources import snapshots

    calls = []

    def slow_extract(profile, scope, source_root=None):
        calls.append(scope)
        time.sleep(0.2)
        return load_fixture("bam-masterdata-v0")

    monkeypatch.setattr(snapshots, "_extract", slow_extract)
    monkeypatch.setattr(snapshots, "current_schema_info", lambda _profile: type("Info", (), {"version": "v1"})())
    results, errors = [], []

    def fetch():
        try:
            results.append(snapshots.get_snapshot(profile("bam-masterdata-v0"), "bam_masterdata.datamodel.v0.object_types"))
        except Exception as error:  # pragma: no cover - reported below
            errors.append(error)

    threads = [threading.Thread(target=fetch) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and len(results) == 5
    assert calls == ["bam_masterdata.datamodel.v0.object_types"]
    assert len(list((studio_home / "cache" / "snapshots").rglob("*.json"))) == 1
    assert list((studio_home / "cache" / "snapshots").rglob("*.tmp")) == []

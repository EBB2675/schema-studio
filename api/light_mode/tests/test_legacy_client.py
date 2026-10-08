"""The app-side client for extraction that runs inside profile environments."""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def legacy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("SCHEMA_STUDIO_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", raising=False)
    monkeypatch.delenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", raising=False)
    import api.light_mode.schema_source as schema_source
    import api.sources.legacy as module

    importlib.reload(schema_source)
    module = importlib.reload(module)
    module.version = {"value": "commit-a"}
    monkeypatch.setattr(
        module,
        "current_schema_info",
        lambda profile: SimpleNamespace(version=module.version["value"], source="remote-main"),
    )
    return module


def _record_calls(legacy, monkeypatch, result):
    calls = []

    def fake_run_script(environment, script, *, arguments, timeout):
        calls.append((environment.name, arguments))
        return {"ok": True, "result": result}

    monkeypatch.setattr(legacy, "run_script", fake_run_script)
    return calls


def test_calls_run_in_the_environment_of_the_owning_profile(legacy, monkeypatch):
    calls = _record_calls(legacy, monkeypatch, ["SearchQuery"])

    assert legacy.list_sections("bam_masterdata.datamodel.object_types") == ["SearchQuery"]
    assert legacy.list_sections("nomad_measurements.xrd.schema") == ["SearchQuery"]

    assert [name for name, _ in calls] == ["bam-masterdata", "nomad-measurements"]
    assert calls[0][1] == ("sections", '{"package": "bam_masterdata.datamodel.object_types"}')


def test_results_are_cached_per_commit_command_and_arguments(legacy, monkeypatch):
    calls = _record_calls(legacy, monkeypatch, {"package": "p", "root": None, "nodes": [], "edges": []})
    package = "bam_masterdata.datamodel.object_types"

    legacy.build_graph(package, root="SearchQuery")
    legacy.build_graph(package, root="SearchQuery")
    assert len(calls) == 1

    legacy.build_graph(package, root="Camera")
    assert len(calls) == 2

    legacy.version["value"] = "commit-b"
    legacy.build_graph(package, root="SearchQuery")
    assert len(calls) == 3
    assert sorted(p.name for p in (legacy.cache_root() / "bam-masterdata").iterdir()) == ["commit-a", "commit-b"]


def test_catalog_uses_the_discovery_method_of_the_profile(legacy, monkeypatch):
    calls = _record_calls(
        legacy,
        monkeypatch,
        {"modules": [{"package": "nomad_measurements.general", "sections": ["A"]}], "skipped": [{"module": "x", "error": "boom"}]},
    )

    modules = legacy.list_schema_modules("nomad_measurements")

    assert modules == [{"package": "nomad_measurements.general", "sections": ["A"]}]
    command, arguments = calls[0][1]
    assert command == "catalog"
    assert json.loads(arguments) == {"base": "nomad_measurements", "dist": "nomad-measurements", "discovery": ["entry-points"]}


def test_worktree_sources_are_passed_to_the_script_and_cached_by_commit(legacy, monkeypatch, tmp_path):
    calls = _record_calls(legacy, monkeypatch, {"package": "p", "root": None, "nodes": [], "edges": []})
    source = tmp_path / "worktree" / "src"

    legacy.build_graph("nomad_simulations.schema_packages.general", source_root=source, source_version="abc")
    legacy.build_graph("nomad_simulations.schema_packages.general", source_root=source, source_version="abc")
    assert len(calls) == 1
    assert calls[0][1][:2] == ("--source-root", str(source))

    # Without a commit there is nothing safe to key the cache on.
    legacy.build_graph("nomad_simulations.schema_packages.general", source_root=source)
    legacy.build_graph("nomad_simulations.schema_packages.general", source_root=source)
    assert len(calls) == 3


def test_usage_entries_keep_their_fields(legacy, monkeypatch):
    _record_calls(
        legacy,
        monkeypatch,
        [{"kind": "normalize_method", "qualname": "a.B.normalize", "module": "a", "short_name": "normalize", "doc": None}],
    )

    (entry,) = legacy.get_usage_for_section("nomad_simulations.schema_packages.general.Program")

    assert (entry.kind, entry.qualname, entry.module, entry.short_name, entry.doc) == (
        "normalize_method", "a.B.normalize", "a", "normalize", None,
    )


@pytest.mark.parametrize(
    "error, expected",
    [
        ({"type": "ModuleNotFoundError", "message": "No module named 'pkg.x'", "name": "pkg.x"}, ModuleNotFoundError),
        ({"type": "ImportError", "message": "cannot import name", "name": None}, ImportError),
        ({"type": "ValueError", "message": "bad root", "name": None}, RuntimeError),
    ],
)
def test_script_errors_come_back_as_exceptions_and_are_not_cached(legacy, monkeypatch, error, expected):
    from extractor.runner import ExtractorError

    def failing(environment, script, *, arguments, timeout):
        raise ExtractorError("exit 1", stdout=json.dumps({"ok": False, "error": error}), stderr="trace", returncode=1)

    monkeypatch.setattr(legacy, "run_script", failing)

    with pytest.raises(expected) as exc:
        legacy.list_sections("bam_masterdata.datamodel.object_types")

    assert error["message"] in str(exc.value)
    if expected is ModuleNotFoundError:
        assert exc.value.name == "pkg.x"
    assert not legacy.cache_root().exists()


def test_missing_environment_becomes_schema_unavailable(legacy, monkeypatch):
    from extractor.runner import EnvironmentMissing

    def missing(environment, script, *, arguments, timeout):
        raise EnvironmentMissing("no interpreter")

    monkeypatch.setattr(legacy, "run_script", missing)

    with pytest.raises(legacy.SchemaUnavailable) as exc:
        legacy.list_sections("bam_masterdata.datamodel.object_types")

    assert "uv sync --project" in str(exc.value)

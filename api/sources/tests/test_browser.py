"""Snapshot builds and the browser Python core, including Pyodide parity."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from api.sources import browser, graph

from .conftest import PROJECT_ROOT, load_fixture

WEB = PROJECT_ROOT / "web"
INFO = SimpleNamespace(version="0588fda", source="remote-develop", package_version="1.0", commit="0588fda")
PROFILES = ("nomad-measurements", "bam-masterdata-v0")


@pytest.fixture()
def snapshots(studio_home, monkeypatch):
    from api.sources import snapshots as module

    module._MEMORY.clear()
    # Every module's snapshot is the whole profile's stored document; enough to compare answers.
    monkeypatch.setattr(module, "_extract", lambda profile, scope, source_root=None: load_fixture(profile.key))
    monkeypatch.setattr(module, "current_schema_info", lambda profile: INFO)
    yield module
    module._MEMORY.clear()


@pytest.fixture()
def site(tmp_path, snapshots, monkeypatch):
    """The data folder of a static site for two profiles, as the build writes it."""
    sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
    try:
        import build_snapshots
    finally:
        sys.path.remove(str(PROJECT_ROOT / "scripts"))
    monkeypatch.setattr(build_snapshots, "current_schema_info", lambda profile: INFO)
    out = tmp_path / "site" / "data"
    assert build_snapshots.main(["--out", str(out), "--graphs", *[f"--profile={key}" for key in PROFILES]]) == 0
    return out


def _index(site: Path) -> dict:
    return json.loads((site / "index.json").read_text(encoding="utf-8"))


def _ask(site: Path, request: dict) -> dict:
    for path in request["snapshots"]:
        if not browser.has_snapshot(path):
            browser.add_snapshot(path, (site / path).read_text(encoding="utf-8"))
    return json.loads(browser.handle(json.dumps(request)))


def _profile(site: Path, key: str) -> dict:
    return next(profile for profile in _index(site)["profiles"] if profile["key"] == key)


def _request(site: Path, key: str, op: str, package: str, **fields) -> dict:
    profile = _profile(site, key)
    module = next(m for m in profile["modules"] if m["package"] == package)
    request = {"op": op, "profile": {k: profile[k] for k in ("key", "default_base_namespace", "edit_rule_set")},
               "package": package, "snapshot": module["snapshot"], "snapshots": [module["snapshot"]], **fields}
    return request


def test_index_lists_profiles_modules_and_ready_graphs(site):
    index = _index(site)
    assert index["format"] == 1 and index["static"] is True
    profiles = {profile["key"]: profile for profile in index["profiles"]}
    assert set(profiles) == set(PROFILES)
    bam = profiles["bam-masterdata-v0"]
    assert bam["edit_rule_set"] == "bam-masterdata" and bam["commit"] == load_fixture("bam-masterdata-v0")["source"]["commit"]
    # The stored documents hold only some modules; each has the graph of its first root ready.
    assert all(list(module["graphs"]) == module["sections"][:1] for module in bam["modules"])
    for profile in profiles.values():
        assert (site / profile["snapshot"]).is_file()
        for module in profile["modules"]:
            assert (site / module["snapshot"]).is_file()
            assert all((site / path).is_file() for path in module["graphs"].values())



def test_ready_graphs_match_browser_core(site):
    for profile in _index(site)["profiles"]:
        for module in profile["modules"]:
            for root, path in module["graphs"].items():
                request = _request(site, profile["key"], "graph", module["package"], stored=[], flags={"root": root, "base_namespace": profile["default_base_namespace"]})
                assert _ask(site, request) == {"ok": json.loads((site / path).read_text())}


def test_browser_edits_and_errors(site):
    key, package = "nomad-measurements", "nomad_measurements.general"
    roots = _ask(site, _request(site, key, "sections", package, stored=[]))["ok"]
    whole = json.loads((site / _profile(site, key)["snapshot"]).read_text())
    target = graph.entry_points(whole["linkml"], whole["extraction"], package)[1][roots[0]]
    new = [{"op": "rename_class", "target": target, "payload": {"new_name": "Renamed"}}]
    answer = _ask(site, _request(site, key, "add_edits", package, stored=[], edits=new, flags={"root": roots[0]}, ids=["1"], created_at="2026-01-01"))
    stored = answer["ok"]["persisted_edits"]
    sections = _ask(site, _request(site, key, "sections", package, stored=stored))["ok"]
    assert "Renamed" in sections and roots[0] not in sections
    yaml_text = _ask(site, _request(site, key, "linkml_yaml", package, stored=stored))["ok"]
    assert "Renamed" in yaml_text
    error = _ask(site, _request(site, key, "graph", package, stored=[], flags={"root": "NoSuchRoot"}))
    assert error["status"] == 400 and error["error"]


def test_python_core_in_pyodide(site, tmp_path):
    if not shutil.which("node") or not (WEB / "node_modules" / "pyodide").is_dir():
        pytest.skip("requires npm ci in web/")
    requests = []
    for profile in _index(site)["profiles"]:
        module = profile["modules"][0]
        for op in ("sections", "graph", "linkml_yaml"):
            requests.append(_request(site, profile["key"], op, module["package"], stored=[], flags={"root": module["sections"][0]}))
    (tmp_path / "expected.json").write_text(json.dumps({"requests": requests, "answers": [_ask(site, request) for request in requests]}))
    pyodide = tmp_path / "pyodide-site"
    subprocess.run(["node", "scripts/copy-pyodide.mjs", str(pyodide)], cwd=WEB, check=True, capture_output=True)
    env = {**os.environ, "STATIC_PARITY_DIR": str(tmp_path), "STATIC_PARITY_SITE": str(site), "STATIC_PARITY_PYODIDE": str(pyodide / "pyodide")}
    run = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", "tests/static-parity.test.ts"], cwd=WEB, env=env, capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stdout[-6000:] + run.stderr[-3000:]

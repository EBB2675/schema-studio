"""The static site gives the answers of the Light Mode server, for the same snapshots and edits.

A small site is built with `scripts/build_snapshots.py` from the stored
extraction documents. The core requests of the site (`browser.py`) are
compared with the server here; the whole static backend of the web app
(`web/src/static/backend.ts`, with this Python in Pyodide) is compared with
the server by `web/tests/static-parity.test.ts`, which this test runs.
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from api.sources import browser, graph

from .conftest import PROJECT_ROOT, load_fixture

WEB = PROJECT_ROOT / "web"
INFO = SimpleNamespace(version="0588fda", source="remote-develop", package_version="1.0", commit="0588fda")
PROFILES = ("nomad-measurements", "bam-masterdata")


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


@pytest.fixture()
async def light(snapshots, monkeypatch):
    for name in list(sys.modules):
        if name == "api.light_mode.app":
            sys.modules.pop(name)
    import api.light_mode.app as app_mod
    import api.sources.linkml_routes as routes

    app_mod = importlib.reload(app_mod)
    monkeypatch.setattr(routes, "get_snapshot", snapshots.get_snapshot)
    monkeypatch.setattr(app_mod, "current_schema_info", lambda *a, **k: INFO)
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


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
    bam = profiles["bam-masterdata"]
    assert bam["edit_rule_set"] == "bam-masterdata" and bam["commit"] == load_fixture("bam-masterdata")["source"]["commit"]
    # The stored documents hold only some modules; each has the graph of its first root ready.
    assert all(list(module["graphs"]) == module["sections"][:1] for module in bam["modules"])
    for profile in profiles.values():
        assert (site / profile["snapshot"]).is_file()
        for module in profile["modules"]:
            assert (site / module["snapshot"]).is_file()
            assert all((site / path).is_file() for path in module["graphs"].values())


@pytest.mark.anyio
async def test_ready_graph_is_the_servers(site, light):
    profile = _profile(site, "nomad-measurements")
    for module in profile["modules"]:
        for root, path in module["graphs"].items():
            served = (await light.get("/schema", params={
                "package": module["package"], "root": root, "base_namespace": profile["default_base_namespace"],
            })).json()
            served.pop("workspace")
            assert json.loads((site / path).read_text(encoding="utf-8")) == served


@pytest.mark.anyio
async def test_core_answers_match_the_server_with_edits(site, light):
    key, package = "nomad-measurements", "nomad_measurements.general"
    namespace = _profile(site, key)["default_base_namespace"]
    sections = (await light.get("/roots", params={"package": package})).json()["sections"]
    root = sections[1]
    whole = json.loads((site / _profile(site, key)["snapshot"]).read_text(encoding="utf-8"))
    target = graph.entry_points(whole["linkml"], whole["extraction"], package)[1][root]
    new = [
        {"op": "add_class", "target": "", "payload": {"name": "Added", "is_a": target}},
        {"op": "add_attribute", "target": f"{package}.Added", "payload": {"name": "extra", "kind": "quantity", "dtype": "float64"}},
        {"op": "rename_class", "target": target, "payload": {"new_name": "Renamed"}},
    ]
    flags = {"root": root, "include_quantities": True, "include_subsections": True, "include_inheritance": True,
             "allow_cross_module": True, "base_namespace": namespace}
    served = (await light.post("/schema/edits", params={"root": root, "base_namespace": namespace},
                               json={"package": package, "edits": new})).json()
    stored = served["persisted_edits"]
    answer = _ask(site, _request(site, key, "add_edits", package, stored=[], edits=new, flags=flags,
                                 ids=[edit["id"] for edit in stored], created_at=stored[0]["created_at"]))
    served.pop("workspace")
    assert answer == {"ok": served}

    shown = (await light.get("/schema", params={"package": package, "root": "Renamed", "base_namespace": namespace})).json()
    shown.pop("workspace")
    assert _ask(site, _request(site, key, "graph", package, stored=stored, flags={**flags, "root": "Renamed"})) == {"ok": shown}
    roots = (await light.get("/roots", params={"package": package})).json()["sections"]
    assert _ask(site, _request(site, key, "sections", package, stored=stored)) == {"ok": roots}
    yaml_text = (await light.get("/schema/linkml", params={"package": package})).text
    assert _ask(site, _request(site, key, "linkml_yaml", package, stored=stored)) == {"ok": yaml_text}


@pytest.mark.anyio
async def test_core_errors_match_the_server(site, light):
    key, package = "bam-masterdata", _profile(site, "bam-masterdata")["default_package"]
    flags = {"root": "NoSuchRoot", "include_quantities": True, "include_subsections": True, "include_inheritance": True,
             "allow_cross_module": True, "base_namespace": None}
    served = await light.get("/schema", params={"package": package, "root": "NoSuchRoot"})
    assert served.status_code == 400
    assert _ask(site, _request(site, key, "graph", package, stored=[], flags=flags)) == {
        "error": served.json()["detail"], "status": 400}
    bad = [{"op": "add_class", "target": "", "payload": {"code": "lower.case"}}]
    refused = await light.post("/schema/edits", json={"package": package, "edits": bad})
    assert refused.status_code == 400
    answer = _ask(site, _request(site, key, "add_edits", package, stored=[], edits=bad, flags=flags, ids=[1], created_at=None))
    assert answer == {"error": refused.json()["detail"], "status": 400}


def _node() -> str | None:
    node = shutil.which("node")
    if node is None or not (WEB / "node_modules" / "pyodide").is_dir() or not (WEB / "node_modules" / "vitest").is_dir():
        return None
    return node


@pytest.mark.anyio
async def test_static_backend_in_the_browser_matches_the_server(site, light, tmp_path):
    """Requests of the web app, answered by the server and by the static backend with Pyodide (in Node)."""
    if _node() is None:
        pytest.skip("needs Node with the web app's packages installed (npm ci in web/)")
    scenario = json.loads((WEB / "tests" / "fixtures" / "static-parity-scenario.json").read_text(encoding="utf-8"))
    answers = []
    for step in scenario:
        response = await light.request(step["method"], step["path"], params=step.get("params"), json=step.get("body"))
        is_yaml = response.headers.get("content-type", "").startswith("application/yaml")
        answers.append({"status": response.status_code, "data": response.text if is_yaml else response.json()})
    (tmp_path / "expected.json").write_text(json.dumps({"scenario": scenario, "answers": answers}), encoding="utf-8")
    pyodide = tmp_path / "pyodide-site"
    subprocess.run(["node", "scripts/copy-pyodide.mjs", str(pyodide)], cwd=WEB, check=True, capture_output=True)
    env = {**os.environ, "STATIC_PARITY_DIR": str(tmp_path), "STATIC_PARITY_SITE": str(site),
           "STATIC_PARITY_PYODIDE": str(pyodide / "pyodide")}
    run = subprocess.run(
        ["npx", "vitest", "run", "tests/static-parity.test.ts"], cwd=WEB, env=env, capture_output=True, text=True,
        timeout=600,
    )
    assert run.returncode == 0, run.stdout[-6000:] + run.stderr[-3000:]
    assert "1 passed" in run.stdout

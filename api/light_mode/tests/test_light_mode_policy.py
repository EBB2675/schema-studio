from __future__ import annotations

import importlib
from pathlib import Path
import sys
from types import SimpleNamespace

import httpx
import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from api.sources.tests.fake_snapshot import SOURCE, fake_snapshot, reset as reset_source  # noqa: E402


@pytest.fixture()
def light_mode_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Light Mode must ignore local repo indicators and use fixed remote-develop policy.
    monkeypatch.setenv("SCHEMA_UML_REPO", str(tmp_path / "local-repo-should-be-ignored"))
    monkeypatch.setenv("SCHEMA_STUDIO_HOME", str(tmp_path / "studio-home"))
    monkeypatch.setenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", "pkg.default")
    monkeypatch.setenv("SCHEMA_STUDIO_DEFAULT_NAMESPACE", "pkg")
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("NO_PROXY", "testserver,localhost,127.0.0.1")

    # Force local package imports even when a globally installed `api` package exists.
    for mod_name in list(sys.modules):
        if mod_name == "api" or mod_name.startswith("api."):
            sys.modules.pop(mod_name, None)

    import api.light_mode.app as app_mod

    app_mod = importlib.reload(app_mod)
    info = SimpleNamespace(version="deadbeef", source="remote-develop", package_version="1.0")

    monkeypatch.setattr(app_mod, "current_schema_info", lambda *args, **kwargs: info)
    monkeypatch.setattr(app_mod, "update_schema", lambda *args, **kwargs: info)
    # Graphs come from a small LinkML snapshot, so edits are really replayed onto LinkML data.
    reset_source()
    monkeypatch.setattr(app_mod.editing, "get_snapshot", fake_snapshot)
    monkeypatch.setattr(app_mod.editing, "extracted_sections", lambda _package: ["RootSection"])
    monkeypatch.setattr(
        app_mod,
        "list_schema_modules",
        lambda base: [
            {"package": f"{base}.alpha", "sections": ["RootSection"]},
            {"package": f"{base}.beta", "sections": ["RootSection"]},
        ],
    )
    return app_mod


@pytest.fixture()
async def client(light_mode_module):
    transport = httpx.ASGITransport(app=light_mode_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client


@pytest.mark.anyio
async def test_workspace_branch_is_fixed_and_cannot_switch(client: httpx.AsyncClient):
    initial = await client.get("/workspace")
    assert initial.status_code == 200
    assert initial.json()["workspace"]["branch"] == "develop"

    rejected = await client.put("/workspace", params={"branch": "feature-x"})
    assert rejected.status_code == 400
    assert "disabled in Light Mode" in rejected.json()["detail"]

    updated = await client.put("/workspace", params={"package": "pkg.updated"})
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["workspace"]["package"] == "pkg.updated"
    assert payload["workspace"]["branch"] == "develop"


@pytest.mark.anyio
async def test_workspace_update_accepts_json_body_and_switches_profile(client: httpx.AsyncClient):
    updated = await client.put(
        "/workspace",
        json={"package": "bam_masterdata.datamodel.object_types", "base_namespace": "bam_masterdata.datamodel"},
    )
    assert updated.status_code == 200
    assert updated.json()["workspace"] == {
        "profile": "bam-masterdata",
        "branch": "main",
        "package": "bam_masterdata.datamodel.object_types",
        "base_namespace": "bam_masterdata.datamodel",
    }

    stored = await client.get("/workspace")
    assert stored.json()["workspace"]["package"] == "bam_masterdata.datamodel.object_types"
    assert stored.json()["schema_profile"] == "bam-masterdata"

    # The branch sent along by the web app must match the profile of the new package.
    rejected = await client.put(
        "/workspace",
        json={"branch": "develop", "package": "nomad_measurements.xrd.schema", "base_namespace": "nomad_measurements"},
    )
    assert rejected.status_code == 400
    assert "only 'main'" in rejected.json()["detail"]


@pytest.mark.anyio
async def test_git_branches_is_hard_disabled(client: httpx.AsyncClient):
    resp = await client.get("/git/branches")
    assert resp.status_code == 410
    assert "disabled in Light Mode" in resp.json()["detail"]


@pytest.mark.anyio
async def test_git_packages_enforces_develop_only(client: httpx.AsyncClient):
    rejected = await client.get("/git/packages", params={"base_package": "pkg.base", "branch": "main"})
    assert rejected.status_code == 400
    assert "only 'develop'" in rejected.json()["detail"]

    resp = await client.get("/git/packages", params={"base_package": "pkg.base"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["branch"] == "develop"
    assert payload["packages"] == ["pkg.base.alpha", "pkg.base.beta"]


@pytest.mark.anyio
async def test_git_packages_falls_back_to_workspace_package_without_schema_modules(
    client: httpx.AsyncClient,
    light_mode_module,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(light_mode_module, "list_schema_modules", lambda base: [])

    resp = await client.get("/git/packages", params={"base_package": "pkg.base"})
    assert resp.status_code == 200
    assert resp.json()["packages"] == ["pkg.default"]


@pytest.mark.anyio
async def test_overview_enforces_develop_only(client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        light_mode_module,
        "list_schema_modules",
        lambda base: [{"package": f"{base}.alpha", "sections": ["ClassA"]}],
    )

    rejected = await client.get("/overview", params={"base": "pkg.base", "branch": "feature-y"})
    assert rejected.status_code == 400
    assert "only 'develop'" in rejected.json()["detail"]

    resp = await client.get("/overview", params={"base": "pkg.base"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["branch"] == "develop"
    assert payload["items"] == [{"package": "pkg.base.alpha", "classes": ["ClassA"]}]


@pytest.mark.anyio
async def test_overview_skips_namespaces_that_cannot_be_read(
    client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch
):
    def modules_for(base: str):
        if base == "pkg.missing":
            raise light_mode_module.SchemaUnavailable("environment is not set up")
        return [{"package": f"{base}.alpha", "sections": ["ClassA"]}]

    monkeypatch.setattr(light_mode_module, "list_schema_modules", modules_for)

    resp = await client.get("/overview", params={"base": "pkg.missing,pkg.base"})
    assert resp.status_code == 200
    assert resp.json()["items"] == [{"package": "pkg.base.alpha", "classes": ["ClassA"]}]


@pytest.mark.anyio
async def test_health_reports_light_mode_schema_metadata(client: httpx.AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["mode"] == "light"
    assert payload["schema_ready"] is True
    assert payload["schema_version"] == "deadbeef"
    assert payload["schema_source"] == "remote-develop"


@pytest.mark.anyio
async def test_schema_profiles_reports_all_three_profiles(client: httpx.AsyncClient):
    resp = await client.get("/schema/profiles")
    assert resp.status_code == 200
    payload = resp.json()
    keys = [entry["key"] for entry in payload["profiles"]]
    assert keys == ["nomad-simulations", "nomad-measurements", "bam-masterdata"]
    assert payload["current_profile"] == "nomad-simulations"
    assert all(entry["version"] == "deadbeef" for entry in payload["profiles"])
    rules = {entry["key"]: entry["edit_rules"] for entry in payload["profiles"]}
    assert [dtype["name"] for dtype in rules["nomad-simulations"]["dtypes"]][:3] == ["bool", "str", "datetime"]
    assert rules["bam-masterdata"]["codes"] is True
    assert all(entry["editable"] for entry in payload["profiles"])


@pytest.mark.anyio
async def test_usage_endpoint_returns_under_the_hood_entries(
    client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        light_mode_module.editing,
        "get_usage_for_section",
        lambda _section_id, _package=None: [
            SimpleNamespace(
                kind="normalize_method",
                qualname="pkg.section.Section.normalize",
                module="pkg.section",
                short_name="normalize",
                doc="Normalize docs",
            )
        ],
    )

    resp = await client.get("/usage", params={"section_id": "pkg.section.Section"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["workspace"]["branch"] == "develop"
    assert payload["usage"] == [
        {
            "kind": "normalize_method",
            "qualname": "pkg.section.Section.normalize",
            "module": "pkg.section",
            "short_name": "normalize",
            "doc": "Normalize docs",
        }
    ]


def _edits(*edits, package="pkg.default"):
    return {"package": package, "edits": [{"op": op, "target": target, "payload": payload} for op, target, payload in edits]}


def _sections(payload):
    return {node["id"]: node for node in payload["nodes"] if node["kind"] == "section"}


def _quantities(payload):
    return {node["id"]: node for node in payload["nodes"] if node["kind"] == "quantity"}


@pytest.mark.anyio
async def test_edit_endpoints_do_not_require_api_main(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    # Guard against accidental reintroduction of `from api.main import ...` in light mode paths.
    monkeypatch.setitem(sys.modules, "api.main", None)

    added = await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "LocalClass", "is_a": "pkg.default.RootSection"}),
        ("add_attribute", "pkg.default.LocalClass", {"name": "my_q", "kind": "quantity", "dtype": "float64"}),
    ))
    assert added.status_code == 200, added.text
    payload = added.json()
    assert [edit["op"] for edit in payload["persisted_edits"]] == ["add_class", "add_attribute"]
    assert payload["persisted_edits"][0]["target"] == "pkg.default.LocalClass"
    assert payload["persisted_edits"][0]["commit"] == "c0ffee"
    assert payload["persisted_edits"][0]["profile"] == "nomad-simulations"
    # Shown like an extracted quantity, with NOMAD's own dtype text; the inherited one too.
    assert _quantities(payload)["pkg.default.LocalClass.my_q"]["dtype"] == "m_float64(float64)"
    assert "pkg.default.LocalClass.label" in _quantities(payload)
    assert len(payload["applied_edits"]) == 2 and "edit_conflicts" not in payload

    listed = await client.get("/schema/edits", params={"package": "pkg.default"})
    assert [edit["op"] for edit in listed.json()["edits"]] == ["add_class", "add_attribute"]
    roots = await client.get("/roots", params={"package": "pkg.default"})
    assert roots.json()["sections"] == ["LocalClass", "RootSection"]


@pytest.mark.anyio
async def test_redefining_inherited_quantity_is_rejected(client: httpx.AsyncClient):
    redefined = await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "Child", "is_a": "pkg.default.RootSection"}),
        ("add_attribute", "pkg.default.Child", {"name": "label", "kind": "quantity", "dtype": "str"}),
    ))
    assert redefined.status_code == 400
    assert "inherited" in redefined.json()["detail"]
    # All or nothing: the class was not stored either.
    listed = await client.get("/schema/edits", params={"package": "pkg.default"})
    assert listed.json()["edits"] == []


@pytest.mark.anyio
async def test_new_class_inherits_from_child_to_parent(client: httpx.AsyncClient):
    added = await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "Child", "is_a": "pkg.default.RootSection"}),
    ))
    assert added.status_code == 200
    edges = [(edge["source"], edge["target"], edge["type"]) for edge in added.json()["edges"]]
    assert ("pkg.default.Child", "pkg.default.RootSection", "inherits") in edges


@pytest.mark.anyio
async def test_new_subsection_keeps_its_card_on_replay(client: httpx.AsyncClient):
    added = await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "Part"}),
        ("add_attribute", "pkg.default.RootSection", {"name": "parts", "kind": "subsection", "range": "pkg.default.Part",
                                                       "multivalued": True}),
    ))
    assert added.status_code == 200, added.text
    replayed = await client.get("/schema", params={"package": "pkg.default"})
    edges = {(edge["source"], edge["target"], edge["type"]): edge["card"] for edge in replayed.json()["edges"]}
    assert edges[("pkg.default.RootSection", "pkg.default.Part", "hasSubSection")] == "0..*"


@pytest.mark.anyio
async def test_empty_canvas_package_builds_on_the_whole_profile(client: httpx.AsyncClient):
    package = "pkg.custom_schema"
    roots = await client.get("/roots", params={"package": package})
    assert roots.status_code == 200 and roots.json()["sections"] == []

    added = await client.post("/schema/edits", params={"empty": "true"}, json=_edits(
        # The whole profile's classes are there to build on.
        ("add_class", "", {"name": "ScratchClass", "is_a": "nomad_simulations.schema_packages.RootSection"}),
        package=package,
    ))
    assert added.status_code == 200, added.text
    replayed = await client.get("/schema", params={"package": package, "empty": "true"})
    sections = _sections(replayed.json())
    assert "pkg.custom_schema.ScratchClass" in sections
    roots = await client.get("/roots", params={"package": package})
    assert roots.json()["sections"] == ["ScratchClass"]


@pytest.mark.anyio
async def test_description_edit_is_replayed(client: httpx.AsyncClient):
    edited = await client.post("/schema/edits", json=_edits(
        ("set_description", "pkg.default.RootSection", {"description": "new"}),
    ))
    assert edited.status_code == 200
    assert edited.json()["persisted_edits"][0]["payload"]["before"]["description"] == "The root."
    replayed = await client.get("/schema", params={"package": "pkg.default"})
    assert _sections(replayed.json())["pkg.default.RootSection"]["doc"] == "new"


@pytest.mark.anyio
async def test_edits_made_on_an_older_commit_report_upstream_changes(client: httpx.AsyncClient):
    await client.post("/schema/edits", json=_edits(
        ("set_description", "pkg.default.RootSection", {"description": "mine"}),
        ("add_attribute", "pkg.default.RootSection", {"name": "extra", "kind": "quantity", "dtype": "int"}),
    ))
    # Same source text on a new commit: nothing to report.
    SOURCE["commit"] = "newer"
    replayed = await client.get("/schema", params={"package": "pkg.default"})
    assert "edit_conflicts" not in replayed.json()
    assert _sections(replayed.json())["pkg.default.RootSection"]["doc"] == "mine"
    # The source changed the description since: still applied, and reported.
    SOURCE.update(commit="newest", description="Rewritten upstream.")
    replayed = (await client.get("/schema", params={"package": "pkg.default"})).json()
    assert _sections(replayed)["pkg.default.RootSection"]["doc"] == "mine"
    assert [(c["edit"]["op"], c["reason"], c["applied"]) for c in replayed["edit_conflicts"]] == [
        ("set_description", "changed_upstream", True),
    ]
    assert len(replayed["applied_edits"]) == 2


@pytest.mark.anyio
async def test_clear_edits_of_all_packages(client: httpx.AsyncClient):
    for package in ("pkg.alpha", "pkg.beta"):
        added = await client.post("/schema/edits", json=_edits(("add_class", "", {"name": "Added"}), package=package))
        assert added.status_code == 200
    cleared = await client.delete("/schema/edits", params={"all_packages": "true"})
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] == 2


@pytest.mark.anyio
async def test_delete_one_edit_turns_its_dependants_into_conflicts(client: httpx.AsyncClient):
    added = await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "OnlyThisOne"}),
        ("add_attribute", "pkg.default.OnlyThisOne", {"name": "to_drop", "kind": "quantity", "dtype": "str"}),
    ))
    class_edit, quantity_edit = added.json()["persisted_edits"]

    deleted = await client.delete(f"/schema/edits/{class_edit['id']}")
    assert deleted.json()["deleted"] == 1
    replayed = (await client.get("/schema", params={"package": "pkg.default"})).json()
    assert "pkg.default.OnlyThisOne" not in _sections(replayed)
    assert [(conflict["edit"]["id"], conflict["reason"]) for conflict in replayed["edit_conflicts"]] == [
        (quantity_edit["id"], "not_found"),
    ]
    deleted = await client.delete(f"/schema/edits/{quantity_edit['id']}")
    assert deleted.json()["deleted"] == 1
    assert "edit_conflicts" not in (await client.get("/schema", params={"package": "pkg.default"})).json()


@pytest.mark.anyio
async def test_renamed_class_keeps_its_usage_and_added_class_has_none(
    client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch
):
    asked = []
    monkeypatch.setattr(light_mode_module.editing, "get_usage_for_section",
                        lambda section_id, _package=None: asked.append(section_id) or [])
    await client.put("/workspace", json={"package": "pkg.default"})
    renamed = await client.post("/schema/edits", json=_edits(
        ("rename_class", "pkg.default.RootSection", {"new_name": "Renamed"}),
        ("add_class", "", {"name": "Fresh"}),
    ))
    assert "pkg.default.Renamed" in _sections(renamed.json())
    assert (await client.get("/roots", params={"package": "pkg.default"})).json()["sections"] == ["Fresh", "Renamed"]
    await client.get("/usage", params={"section_id": "pkg.default.Renamed"})
    await client.get("/usage", params={"section_id": "pkg.default.Fresh"})
    assert asked == ["pkg.default.RootSection"]


@pytest.mark.anyio
async def test_edits_need_the_linkml_path(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SCHEMA_STUDIO_EXTRACTION", "legacy")
    refused = await client.post("/schema/edits", json=_edits(("add_class", "", {"name": "Nope"})))
    assert refused.status_code == 400
    assert "LinkML extraction" in refused.json()["detail"]


@pytest.mark.anyio
async def test_unavailable_schema_returns_503_and_never_installs(
    client: httpx.AsyncClient,
    light_mode_module,
    monkeypatch: pytest.MonkeyPatch,
):
    calls = {"update": 0}

    def unavailable(*args, **kwargs):
        raise light_mode_module.SchemaUnavailable("schema environment is not set up")

    def count_update(*args, **kwargs):
        calls["update"] += 1
        return SimpleNamespace(version="feedbeef", source="remote-develop", package_version="1.0")

    monkeypatch.setattr(light_mode_module, "current_schema_info", unavailable)
    monkeypatch.setattr(light_mode_module, "update_schema", count_update)

    for path, params in (
        ("/git/packages", {"base_package": "pkg.base"}),
        ("/roots", {"package": "pkg.base.alpha"}),
        ("/schema", {"package": "pkg.base.alpha"}),
        ("/overview", {"base": "pkg.base"}),
        ("/schema/version", {}),
    ):
        resp = await client.get(path, params=params)
        assert resp.status_code == 503, path
        assert "not set up" in resp.json()["detail"]

    # Setting up an environment only happens when it is asked for explicitly.
    assert calls["update"] == 0
    profiles = await client.get("/schema/profiles")
    assert all(entry["error"] for entry in profiles.json()["profiles"])

    updated = await client.post("/schema/update", params={"profile": "bam-masterdata"})
    assert updated.status_code == 200
    assert updated.json() == {"version": "feedbeef", "source": "remote-develop", "schema_profile": "bam-masterdata"}
    assert calls["update"] == 1


@pytest.mark.anyio
async def test_usage_reports_unavailable_schema(
    client: httpx.AsyncClient,
    light_mode_module,
    monkeypatch: pytest.MonkeyPatch,
):
    def unavailable(_section_id, _package=None):
        raise light_mode_module.SchemaUnavailable("schema environment is not set up")

    monkeypatch.setattr(light_mode_module.editing, "get_usage_for_section", unavailable)

    resp = await client.get("/usage", params={"section_id": "pkg.section.Section"})
    assert resp.status_code == 503
    assert "not set up" in resp.json()["detail"]

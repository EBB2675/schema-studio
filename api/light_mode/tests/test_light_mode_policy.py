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
    info = SimpleNamespace(package_root=tmp_path, version="deadbeef", source="remote-develop")

    monkeypatch.setattr(app_mod, "current_schema_info", lambda: info)
    monkeypatch.setattr(app_mod, "update_schema", lambda: info)
    monkeypatch.setattr(app_mod, "build_graph", lambda **kwargs: {"package": kwargs["package"], "root": kwargs.get("root"), "nodes": [], "edges": []})
    monkeypatch.setattr(app_mod, "list_sections", lambda _package: ["RootSection"])
    monkeypatch.setattr(app_mod, "list_modules_for_base", lambda base: [f"{base}.alpha", f"{base}.beta"])
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
async def test_overview_enforces_develop_only(client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        light_mode_module,
        "list_sections",
        lambda module: ["ClassA"] if module.endswith(".alpha") else [],
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
async def test_delete_custom_edits_rejects_non_develop_branch(client: httpx.AsyncClient):
    rejected = await client.delete("/schema/custom-edits", params={"branch": "feature-z"})
    assert rejected.status_code == 400
    assert "only 'develop'" in rejected.json()["detail"]


@pytest.mark.anyio
async def test_health_reports_light_mode_schema_metadata(client: httpx.AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["mode"] == "light"
    assert payload["schema_version"] == "deadbeef"
    assert payload["schema_source"] == "remote-develop"


@pytest.mark.anyio
async def test_usage_endpoint_returns_under_the_hood_entries(
    client: httpx.AsyncClient, light_mode_module, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        light_mode_module,
        "get_usage_for_section",
        lambda _section_id: [
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


@pytest.mark.anyio
async def test_custom_edit_endpoints_do_not_require_api_main(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    # Guard against accidental reintroduction of `from api.main import ...` in light mode paths.
    monkeypatch.setitem(sys.modules, "api.main", None)

    add_class = await client.post(
        "/schema/custom-class",
        params={
            "package": "pkg.default",
            "name": "LocalClass",
            "relation": "inherits",
        },
    )
    assert add_class.status_code == 200
    assert add_class.json()["persisted_edit"]["edit_type"] == "class"

    add_quantity = await client.post(
        "/schema/custom-quantity",
        params={
            "package": "pkg.default",
            "class_name": "LocalClass",
            "quantity_name": "my_q",
            "dtype": "str",
        },
    )
    assert add_quantity.status_code == 200
    q_labels = [n.get("label") for n in add_quantity.json()["nodes"] if n.get("kind") == "quantity"]
    assert "my_q" in q_labels


@pytest.mark.anyio
async def test_custom_edit_endpoints_accept_json_body(client: httpx.AsyncClient):
    add_class = await client.post(
        "/schema/custom-class",
        json={
            "package": "pkg.default",
            "name": "BodyClass",
            "relation": "inherits",
        },
    )
    assert add_class.status_code == 200
    assert add_class.json()["persisted_edit"]["edit_type"] == "class"

    add_quantity = await client.post(
        "/schema/custom-quantity",
        json={
            "package": "pkg.default",
            "class_name": "BodyClass",
            "quantity_name": "body_q",
            "dtype": "str",
        },
    )
    assert add_quantity.status_code == 200
    q_labels = [n.get("label") for n in add_quantity.json()["nodes"] if n.get("kind") == "quantity"]
    assert "body_q" in q_labels


@pytest.mark.anyio
async def test_redefining_inherited_quantity_is_rejected(client: httpx.AsyncClient):
    parent_resp = await client.post(
        "/schema/custom-class",
        params={"empty": "true"},
        json={"package": "pkg.default", "name": "Parent", "relation": "inherits"},
    )
    assert parent_resp.status_code == 200

    parent_q = await client.post(
        "/schema/custom-quantity",
        params={"empty": "true"},
        json={
            "package": "pkg.default",
            "class_name": "Parent",
            "quantity_name": "shared_q",
            "dtype": "str",
        },
    )
    assert parent_q.status_code == 200

    child_resp = await client.post(
        "/schema/custom-class",
        params={"empty": "true"},
        json={
            "package": "pkg.default",
            "name": "Child",
            "parent": "pkg.default.Parent",
            "relation": "inherits",
        },
    )
    assert child_resp.status_code == 200

    redef = await client.post(
        "/schema/custom-quantity",
        params={"empty": "true"},
        json={
            "package": "pkg.default",
            "class_name": "Child",
            "parent_name": "Parent",
            "parent_relation": "inherits",
            "quantity_name": "shared_q",
            "dtype": "str",
        },
    )
    assert redef.status_code == 400
    assert "inherited" in redef.json()["detail"]


@pytest.mark.anyio
async def test_custom_inheritance_edge_direction_is_child_to_parent(client: httpx.AsyncClient):
    parent_resp = await client.post(
        "/schema/custom-class",
        params={"empty": "true"},
        json={"package": "pkg.default", "name": "Parent", "relation": "inherits"},
    )
    assert parent_resp.status_code == 200

    child_resp = await client.post(
        "/schema/custom-class",
        params={"empty": "true"},
        json={
            "package": "pkg.default",
            "name": "Child",
            "parent": "pkg.default.Parent",
            "relation": "inherits",
        },
    )
    assert child_resp.status_code == 200
    payload = child_resp.json()

    assert any(
        e
        for e in payload.get("edges", [])
        if e.get("type") == "inherits"
        and e.get("source") == "pkg.default.Child"
        and e.get("target") == "pkg.default.Parent"
    )


@pytest.mark.anyio
async def test_clear_custom_edits_all_packages_flag(client: httpx.AsyncClient):
    add_pkg_a = await client.post(
        "/schema/custom-class",
        json={"package": "pkg.alpha", "name": "ClassA", "relation": "inherits"},
    )
    assert add_pkg_a.status_code == 200

    add_pkg_b = await client.post(
        "/schema/custom-class",
        json={"package": "pkg.beta", "name": "ClassB", "relation": "inherits"},
    )
    assert add_pkg_b.status_code == 200

    cleared = await client.delete("/schema/custom-edits", params={"all_packages": "true"})
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] >= 2


@pytest.mark.anyio
async def test_delete_custom_edit_endpoint_removes_single_persisted_edit(client: httpx.AsyncClient):
    add_class = await client.post(
        "/schema/custom-class",
        json={"package": "pkg.alpha", "name": "OnlyThisOne", "relation": "inherits"},
    )
    assert add_class.status_code == 200

    add_quantity = await client.post(
        "/schema/custom-quantity",
        json={
            "package": "pkg.alpha",
            "class_name": "OnlyThisOne",
            "quantity_name": "to_drop",
            "dtype": "str",
        },
    )
    assert add_quantity.status_code == 200

    delete_quantity = await client.delete(
        "/schema/custom-edit",
        params={
            "package": "pkg.alpha",
            "class_name": "pkg.alpha.OnlyThisOne",
            "quantity_name": "to_drop",
        },
    )
    assert delete_quantity.status_code == 200
    assert delete_quantity.json()["deleted"] == 1

    delete_class = await client.delete(
        "/schema/custom-edit",
        params={"package": "pkg.alpha", "class_name": "OnlyThisOne"},
    )
    assert delete_class.status_code == 200
    assert delete_class.json()["deleted"] == 1

@pytest.mark.anyio
async def test_git_packages_auto_bootstraps_schema_when_unavailable_once(
    client: httpx.AsyncClient,
    light_mode_module,
    monkeypatch: pytest.MonkeyPatch,
):
    info = SimpleNamespace(package_root=Path("."), version="feedbeef", source="remote-develop")
    calls = {"current": 0, "update": 0}

    def flaky_current():
        calls["current"] += 1
        if calls["update"] == 0:
            raise light_mode_module.SchemaUnavailable("schema missing before bootstrap")
        return info

    def one_update():
        calls["update"] += 1
        return info

    monkeypatch.setattr(light_mode_module, "current_schema_info", flaky_current)
    monkeypatch.setattr(light_mode_module, "update_schema", one_update)
    monkeypatch.setattr(light_mode_module, "_bootstrap_attempted", False)

    first = await client.get("/git/packages", params={"base_package": "pkg.base"})
    assert first.status_code == 200
    assert first.json()["packages"] == ["pkg.base.alpha", "pkg.base.beta"]
    assert calls["update"] == 1

    second = await client.get("/git/packages", params={"base_package": "pkg.base"})
    assert second.status_code == 200
    assert calls["update"] == 1


@pytest.mark.anyio
async def test_git_packages_returns_503_when_schema_still_unavailable_after_bootstrap(
    client: httpx.AsyncClient,
    light_mode_module,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        light_mode_module,
        "current_schema_info",
        lambda: (_ for _ in ()).throw(light_mode_module.SchemaUnavailable("schema unavailable")),
    )
    monkeypatch.setattr(
        light_mode_module,
        "update_schema",
        lambda: (_ for _ in ()).throw(light_mode_module.SchemaUnavailable("bootstrap failed")),
    )
    monkeypatch.setattr(light_mode_module, "_bootstrap_attempted", False)

    resp = await client.get("/git/packages", params={"base_package": "pkg.base"})
    assert resp.status_code == 503
    assert "schema unavailable" in resp.json()["detail"]

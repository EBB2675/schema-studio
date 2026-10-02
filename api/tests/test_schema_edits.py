"""Dev Mode schema edits: stored in MongoDB, replayed onto the LinkML schema (needs MongoDB)."""
from uuid import uuid4

from api.sources.tests.fake_snapshot import SOURCE


def _pkg(prefix: str = "pkg.devmode") -> str:
    return f"{prefix}_{uuid4().hex}"


def _edits(package, *edits):
    return {"package": package, "edits": [{"op": op, "target": target, "payload": payload} for op, target, payload in edits]}


def _quantities(payload):
    return {node["id"]: node for node in payload["nodes"] if node["kind"] == "quantity"}


def test_added_quantity_is_stored_and_replayed(client):
    pkg = _pkg()
    added = client.post("/schema/edits", json=_edits(
        pkg, ("add_attribute", f"{pkg}.RootSection", {"name": "custom_q", "kind": "quantity", "dtype": "float64"}),
    ))
    assert added.status_code == 200, added.text
    stored = added.json()["persisted_edits"]
    assert [(edit["op"], edit["commit"], edit["profile"]) for edit in stored] == [
        ("add_attribute", "c0ffee", "nomad-simulations"),
    ]
    replayed = client.get("/schema", params={"package": pkg})
    assert _quantities(replayed.json())[f"{pkg}.RootSection.custom_q"]["dtype"] == "m_float64(float64)"
    assert [edit["id"] for edit in replayed.json()["applied_edits"]] == [stored[0]["id"]]
    listed = client.get("/schema/edits", params={"package": pkg}).json()
    assert [edit["id"] for edit in listed["edits"]] == [stored[0]["id"]]


def test_invalid_edits_are_refused_and_nothing_is_stored(client):
    pkg = _pkg()
    for payload, message in (
        ({"name": "label", "kind": "quantity", "dtype": "str"}, "already has"),
        ({"name": "x", "kind": "quantity", "dtype": "complex"}, "unsupported dtype"),
    ):
        refused = client.post("/schema/edits", json=_edits(pkg, ("add_attribute", f"{pkg}.RootSection", payload)))
        assert refused.status_code == 400
        assert message in refused.json()["detail"]
    missing = client.post("/schema/edits", json=_edits(
        pkg, ("add_attribute", f"{pkg}.Missing", {"name": "x", "kind": "quantity", "dtype": "str"}),
    ))
    assert missing.status_code == 400 and "not in the schema" in missing.json()["detail"]
    assert client.get("/schema/edits", params={"package": pkg}).json()["edits"] == []


def test_inherited_quantity_cannot_be_redefined(client):
    pkg = _pkg()
    refused = client.post("/schema/edits", json=_edits(
        pkg,
        ("add_class", "", {"name": "Child", "is_a": f"{pkg}.RootSection"}),
        ("add_attribute", f"{pkg}.Child", {"name": "label", "kind": "quantity", "dtype": "str"}),
    ))
    assert refused.status_code == 400
    assert "inherited" in refused.json()["detail"]


def test_upstream_changes_are_reported_on_replay(client):
    pkg = _pkg()
    client.post("/schema/edits", json=_edits(pkg, ("set_description", f"{pkg}.RootSection", {"description": "mine"})))
    SOURCE.update(commit="newer", description="Rewritten upstream.")
    replayed = client.get("/schema", params={"package": pkg}).json()
    assert [(c["reason"], c["applied"]) for c in replayed["edit_conflicts"]] == [("changed_upstream", True)]


def test_empty_canvas_persists_and_replays_edits(client):
    pkg = "nomad_simulations.schema_packages.custom_schema"
    blank = client.get("/schema", params={"package": pkg, "empty": True}).json()
    assert blank["nodes"] == [] and blank["edges"] == []
    added = client.post("/schema/edits", params={"empty": True}, json=_edits(
        pkg,
        ("add_class", "", {"name": "CanvasClass"}),
        ("add_attribute", f"{pkg}.CanvasClass", {"name": "canvas_q", "kind": "quantity", "dtype": "str"}),
    ))
    assert added.status_code == 200, added.text
    replayed = client.get("/schema", params={"package": pkg, "empty": True}).json()
    labels = {node["label"] for node in replayed["nodes"]}
    assert {"CanvasClass", "canvas_q"} <= labels


def test_deleting_edits(client):
    pkg = _pkg()
    added = client.post("/schema/edits", json=_edits(
        pkg,
        ("add_class", "", {"name": "One"}),
        ("add_class", "", {"name": "Two"}),
    )).json()["persisted_edits"]
    assert client.delete(f"/schema/edits/{added[0]['id']}").json()["deleted"] == 1
    assert [edit["id"] for edit in client.get("/schema/edits", params={"package": pkg}).json()["edits"]] == [
        added[1]["id"],
    ]
    assert client.delete("/schema/edits", params={"package": pkg}).json()["deleted"] == 1
    assert client.get("/schema/edits", params={"package": pkg}).json()["edits"] == []

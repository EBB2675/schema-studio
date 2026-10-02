"""Dev Mode edits without MongoDB: the routes with an in-memory edit store and a fake branch worktree."""
from __future__ import annotations

from typing import Any

import httpx
import pytest
from bson import ObjectId

from api.sources.tests import fake_snapshot

USER = {"id": "u1", "username": "tester"}
PACKAGE = "nomad_simulations.schema_packages.alpha"
NAMESPACE = "nomad_simulations.schema_packages"


# -------- a tiny in-memory stand-in for the Motor calls the edit store makes --------

def _matches(row: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, wanted in query.items():
        if key == "$or":
            if not any(_matches(row, option) for option in wanted):
                return False
        elif isinstance(wanted, dict) and "$in" in wanted:
            if row.get(key) not in wanted["$in"]:
                return False
        elif row.get(key) != wanted:
            return False
    return True


class _Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        self.rows.sort(key=lambda row: row[key], reverse=direction < 0)
        return self

    def __aiter__(self):
        async def rows():
            for row in self.rows:
                yield row
        return rows()


class _Result:
    def __init__(self, **values):
        self.__dict__.update(values)


class FakeCollection:
    def __init__(self):
        self.rows: list[dict[str, Any]] = []
        self.fail_writes = False

    def find(self, query):
        return _Cursor([dict(row) for row in self.rows if _matches(row, query)])

    async def insert_one(self, document):
        if self.fail_writes:
            raise RuntimeError("write failed")  # a single-document write either happens or not
        self.rows.append({**document, "_id": document.get("_id") or ObjectId()})
        return _Result(inserted_id=self.rows[-1]["_id"])

    async def update_one(self, query, update):
        for row in self.rows:
            if _matches(row, query):
                row.update(update["$set"])
                return _Result(modified_count=1)
        return _Result(modified_count=0)

    async def delete_one(self, query):
        for row in self.rows:
            if _matches(row, query):
                self.rows.remove(row)
                return _Result(deleted_count=1)
        return _Result(deleted_count=0)

    async def delete_many(self, query):
        before = len(self.rows)
        self.rows = [row for row in self.rows if not _matches(row, query)]
        return _Result(deleted_count=before - len(self.rows))

    async def create_index(self, *args, **kwargs):
        return None


class FakeDB(dict):
    def __missing__(self, name):
        self[name] = FakeCollection()
        return self[name]

    async def list_collection_names(self):
        return list(self)

    async def drop_collection(self, name):
        self.pop(name, None)


# -------- the app, with a fake user, store and worktree --------

@pytest.fixture()
def dev_mode(tmp_path, monkeypatch):
    import api.graph_runner as graph_runner
    import api.main as main
    import api.routes_git as routes_git
    import api.routes_tasks as routes_tasks
    import api.tasks as tasks
    from api.auth import db_dep, get_user_and_workspace
    from api.sources import editing

    db = FakeDB()
    workspace = {"branch": "feature", "package": PACKAGE, "base_namespace": NAMESPACE}

    async def update_workspace(_db, _user_id, **changes):
        workspace.update({key: value for key, value in changes.items() if value is not None})
        return workspace

    def materialize(branch, _repo):
        return tmp_path / branch, f"sha-of-{branch}"

    fake_snapshot.reset()
    monkeypatch.setattr(editing, "get_snapshot", fake_snapshot.fake_snapshot)
    monkeypatch.setattr(editing, "extracted_sections", lambda _package: ["RootSection"])
    for module in (main, routes_git, routes_tasks):
        monkeypatch.setattr(module, "update_workspace", update_workspace)
    for module in (routes_git, graph_runner, tasks):
        monkeypatch.setattr(module, "materialize_worktree", materialize)
        monkeypatch.setattr(module, "primary_repo", lambda *_args: "repo")
    main.app.dependency_overrides[get_user_and_workspace] = lambda: (USER, workspace)
    main.app.dependency_overrides[db_dep] = lambda: db
    yield main.app, db
    main.app.dependency_overrides.clear()


@pytest.fixture()
async def client(dev_mode):
    app, _db = dev_mode
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as test_client:
        yield test_client


def _edits(*edits, package=PACKAGE):
    return {"package": package, "edits": [{"op": op, "target": target, "payload": payload} for op, target, payload in edits]}


def _ids(graph):
    return {node["id"] for node in graph["nodes"]}


@pytest.mark.anyio
async def test_branch_graph_keeps_an_edit_made_on_the_branch(client: httpx.AsyncClient):
    first = await client.post("/graph", json={"branch": "feature", "package": PACKAGE})
    assert first.status_code == 200, first.text
    assert first.json()["sha"] == "sha-of-feature"
    assert f"{PACKAGE}.RootSection.extra" not in _ids(first.json()["graph"])

    edited = await client.post("/schema/edits", params={"branch": "feature"}, json=_edits(
        ("add_attribute", f"{PACKAGE}.RootSection", {"name": "extra", "kind": "quantity", "dtype": "str"}),
    ))
    assert edited.status_code == 200, edited.text
    assert edited.json()["sha"] == "sha-of-feature"
    assert edited.json()["persisted_edits"][0]["commit"] == "sha-of-feature"
    assert f"{PACKAGE}.RootSection.extra" in _ids(edited.json())

    again = await client.post("/graph", json={"branch": "feature", "package": PACKAGE})
    payload = again.json()
    assert payload["sha"] == "sha-of-feature"
    assert f"{PACKAGE}.RootSection.extra" in _ids(payload["graph"])
    assert [edit["op"] for edit in payload["graph"]["applied_edits"]] == ["add_attribute"]
    # Every one of these read the branch's worktree snapshot.
    assert {call.get("source_version") for call in fake_snapshot.CALLS} == {"sha-of-feature"}


@pytest.mark.anyio
async def test_roots_and_linkml_read_the_same_branch(client: httpx.AsyncClient):
    await client.post("/schema/edits", params={"branch": "feature"}, json=_edits(("add_class", "", {"name": "Added"})))
    fake_snapshot.CALLS.clear()
    roots = await client.get("/roots", params={"package": PACKAGE, "branch": "feature"})
    assert roots.json()["sections"] == ["Added", "RootSection"]
    exported = await client.get("/schema/linkml", params={"package": PACKAGE, "branch": "feature"})
    assert exported.status_code == 200 and f"{PACKAGE}.Added:" in exported.text
    assert {call.get("source_version") for call in fake_snapshot.CALLS} == {"sha-of-feature"}


@pytest.mark.anyio
async def test_branch_graph_task_gets_the_stored_edits(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    import api.routes_tasks as routes_tasks

    sent = {}

    class Task:
        id, status = "t1", "PENDING"

    def delay(**kwargs):
        sent.update(kwargs)
        return Task()

    monkeypatch.setattr(routes_tasks.build_graph_task, "delay", delay)
    await client.post("/schema/edits", json=_edits(("add_class", "", {"name": "Added"})))
    queued = await client.post("/tasks/graph", json={"branch": "feature", "package": PACKAGE})
    assert queued.status_code == 202, queued.text
    assert [edit["op"] for edit in sent["edits"]] == ["add_class"]

    from api.tasks import build_graph_task

    result = build_graph_task.run(branch="feature", package=PACKAGE, base_namespace=NAMESPACE, edits=sent["edits"])
    assert f"{PACKAGE}.Added" in _ids(result["graph"])


@pytest.mark.anyio
async def test_a_failed_batch_leaves_no_edits(client: httpx.AsyncClient, dev_mode):
    from api.edit_store import EDITS_COLLECTION

    _app, db = dev_mode
    db[EDITS_COLLECTION].fail_writes = True
    with pytest.raises(RuntimeError):
        await client.post("/schema/edits", json=_edits(
            ("add_class", "", {"name": "One"}), ("add_class", "", {"name": "Two"}),
        ))
    assert db[EDITS_COLLECTION].rows == []


@pytest.mark.anyio
async def test_batch_delete_and_module_clear(client: httpx.AsyncClient):
    other = "nomad_simulations.schema_packages.beta"
    added = (await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "One"}), ("add_class", "", {"name": "Two"}),
    ))).json()["persisted_edits"]
    await client.post("/schema/edits", json=_edits(("add_class", "", {"name": "Elsewhere"}), package=other))
    deleted = await client.request("DELETE", "/schema/edits", json={"ids": [added[0]["id"]]})
    assert deleted.json()["deleted"] == 1
    cleared = await client.request("DELETE", "/schema/edits", params={"package": PACKAGE}, json={"ids": []})
    assert cleared.json()["deleted"] == 1
    assert (await client.get("/schema/edits", params={"package": other})).json()["edits"][0]["op"] == "add_class"


@pytest.mark.anyio
async def test_one_request_is_one_batch_and_undo_removes_it_whole(client: httpx.AsyncClient, dev_mode):
    from api.edit_store import EDITS_COLLECTION

    _app, db = dev_mode
    first = (await client.post("/schema/edits", json=_edits(
        ("add_class", "", {"name": "One"}), ("add_class", "", {"name": "Two"}),
    ))).json()["persisted_edits"]
    await client.post("/schema/edits", json=_edits(("add_class", "", {"name": "Three"})))
    assert [len(row["edits"]) for row in db[EDITS_COLLECTION].rows] == [2, 1]
    # One of a batch's edits: the batch keeps the other.
    assert (await client.request("DELETE", "/schema/edits", json={"ids": [first[1]["id"]]})).json()["deleted"] == 1
    assert [len(row["edits"]) for row in db[EDITS_COLLECTION].rows] == [1, 1]
    listed = (await client.get("/schema/edits", params={"package": PACKAGE})).json()["edits"]
    assert [edit["payload"]["name"] for edit in listed] == ["One", "Three"]
    # All of it: the batch goes.
    assert (await client.request("DELETE", "/schema/edits", json={"ids": [first[0]["id"]]})).json()["deleted"] == 1
    assert [len(row["edits"]) for row in db[EDITS_COLLECTION].rows] == [1]


@pytest.mark.anyio
async def test_usage_reads_the_branch(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch):
    def branch_snapshot(profile, scope=None, **kwargs):
        snapshot = fake_snapshot.fake_snapshot(profile, scope, **kwargs)
        root = f"{scope}.RootSection"
        snapshot["extraction"]["usage"] = {root: [{
            "kind": "normalize_method", "qualname": f"{root}.normalize", "module": scope,
            "short_name": "normalize", "doc": f"On {kwargs.get('source_version')}."}]}
        return snapshot

    from api.sources import editing

    monkeypatch.setattr(editing, "get_snapshot", branch_snapshot)
    usage = await client.get("/usage", params={"section_id": f"{PACKAGE}.RootSection", "branch": "feature"})
    assert usage.status_code == 200, usage.text
    assert [entry["doc"] for entry in usage.json()["usage"]] == ["On sha-of-feature."]

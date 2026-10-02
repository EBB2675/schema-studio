"""What the static site asks Python for, answered with `core` (runs in the browser with Pyodide).

The static site has no server: its web worker loads the snapshot files of the
site into `add_snapshot` and sends each request to `handle` as JSON text,
getting JSON text back. Stored edits live in the browser and come with each
request. The answers are those of the Light Mode server for the same snapshot
and edits.

Standard library only, like `core`; YAML needs PyYAML.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from . import core, edits, graph

_SNAPSHOTS: dict[str, dict[str, Any]] = {}
_KEEP = 12


class Failure(Exception):
    """An answer with an HTTP status, as the server would give it."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def has_snapshot(path: str) -> bool:
    return path in _SNAPSHOTS


def add_snapshot(path: str, text: str) -> None:
    """Keep a snapshot file of the site by its path; the oldest go when there are too many."""
    _SNAPSHOTS.pop(path, None)
    _SNAPSHOTS[path] = json.loads(text)
    while len(_SNAPSHOTS) > _KEEP:
        _SNAPSHOTS.pop(next(iter(_SNAPSHOTS)))


def _snapshot(path: str) -> dict[str, Any]:
    try:
        return _SNAPSHOTS[path]
    except KeyError:
        raise Failure(500, f"Snapshot not loaded: {path}") from None


def _profile(request: Mapping[str, Any]) -> core.Profile:
    profile = request["profile"]
    return core.Profile(profile["key"], profile["default_base_namespace"], profile.get("edit_rule_set") or "nomad")


def _state(request: Mapping[str, Any], stored=None) -> core.Edited:
    return core.edited(
        _profile(request), _snapshot(request["snapshot"]), request["package"],
        request.get("stored") or () if stored is None else stored,
    )


def _graph(state: core.Edited, request: Mapping[str, Any], root: str | None) -> dict[str, Any]:
    flags = dict(request.get("flags") or {})
    flags["root"] = root
    try:
        return core.build_graph(state, request["package"], empty=bool(request.get("empty")), **flags)
    except graph.RootNotFound as exc:
        raise Failure(400, f"ValueError: {exc}") from exc


def graph_of(request: Mapping[str, Any]) -> dict[str, Any]:
    """`GET /schema`: the module's graph with the stored edits."""
    return _graph(_state(request), request, (request.get("flags") or {}).get("root"))


def sections(request: Mapping[str, Any]) -> list[str]:
    """`GET /roots`: the roots the module offers with the stored edits."""
    return sorted(core.section_names(_state(request), request["package"]))


def usage(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    """`GET /usage`: the code that acts on a section, from the module's snapshot or else the profile's."""
    section_id = request["section_id"]
    if request.get("stored"):
        section_id = core.usage_source(_state(request), section_id)
        if section_id is None:
            return []
    snapshots = [_snapshot(path) for path in request["usage_snapshots"]]
    return core.usage_entries(snapshots, section_id)


def add_edits(request: Mapping[str, Any]) -> dict[str, Any]:
    """`POST /schema/edits`: check the new edits, build the graph with them, and return them ready to store.

    `ids` and `created_at` come from the browser's edit store; nothing is
    stored here. All edits apply or none (a 400 names the reason).
    """
    package = request["package"]
    stored = request.get("stored") or []
    try:
        prepared = core.prepare(_state(request), package, request.get("edits") or [])
        root = core.root_after(_state(request), package, prepared, (request.get("flags") or {}).get("root"))
    except edits.EditError as exc:
        raise Failure(400, f"{exc.detail or exc} ({exc.reason})") from exc
    result = _graph(_state(request, [*stored, *prepared]), request, root)
    profile = request["profile"]["key"]
    saved = [
        {"id": edit_id, "profile": profile, "package": edit.get("package") or package, "commit": edit.get("commit"),
         "op": edit["op"], "target": edit["target"], "payload": edit.get("payload") or {},
         "created_at": request.get("created_at")}
        for edit_id, edit in zip(request["ids"], prepared)
    ]
    return core.with_stored(result, prepared, saved)


def linkml_yaml(request: Mapping[str, Any]) -> str:
    """`GET /schema/linkml`: the module's schema as LinkML YAML, with the stored edits."""
    if not request.get("stored"):
        return core.snapshot_yaml(_snapshot(request["snapshot"]))
    return core.edited_yaml(_state(request))


_HANDLERS = {
    "graph": graph_of,
    "sections": sections,
    "usage": usage,
    "add_edits": add_edits,
    "linkml_yaml": linkml_yaml,
}


def handle(text: str) -> str:
    """One request (`{"op": ..., ...}`) as JSON text; the answer as `{"ok": ...}` or `{"error": ..., "status": ...}`."""
    request = json.loads(text)
    try:
        return json.dumps({"ok": _HANDLERS[request["op"]](request)})
    except Failure as exc:
        return json.dumps({"error": exc.detail, "status": exc.status})
    except Exception as exc:  # an answer the page can show, not a dead worker
        return json.dumps({"error": f"{type(exc).__name__}: {exc}", "status": 500})

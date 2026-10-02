"""Edits replayed onto a snapshot, and what the app reads from the result: graph, roots, usage, YAML.

Plain data in and out, standard library only (PyYAML for the YAML, imported
only when YAML is asked for), so the server and the static site in the
browser run the same code. The caller hands
in the snapshot; loading it (from the cache, a git worktree or a file of the
site) is not done here.

`profile` is anything with the attributes `key`, `default_base_namespace` and
`edit_rules` (the server's `SchemaProfile`, or `Profile` below).

An edit is stored under the module that owns its target: the module of the
class it changes (a new class: the module it is added to). Every module's
graph replays all of the profile's edits in the order they were made, so a
class shows the same edits wherever it appears; an edit stored under another
module that does not apply to this module's snapshot (its target is not
there) is skipped silently, and only the module's own edits are reported as
conflicts.

The empty canvas uses a module that does not exist
(`<base namespace>.custom_schema`); it starts from the whole profile's schema,
so new classes can build on existing ones, and its graph shows only the
classes the edits added there.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

from . import edits as edit_ops
from . import graph

SCRATCH_SUFFIX = ".custom_schema"


class Profile(NamedTuple):
    """The profile facts the core needs (the static site has no `SchemaProfile`)."""

    key: str
    default_base_namespace: str
    edit_rules: str = "nomad"


class Edited:
    """A snapshot's schema with edits replayed onto it."""

    def __init__(
        self,
        profile: Any,
        snapshot: dict[str, Any],
        schema: dict[str, Any],
        applied: list[Mapping[str, Any]],
        conflicts: list[dict[str, Any]],
        commit: str | None,
    ) -> None:
        self.profile = profile
        self.snapshot = snapshot
        self.schema = schema
        self.applied = applied
        self.conflicts = conflicts
        self.commit = commit


def is_scratch(package: str) -> bool:
    return package.endswith(SCRATCH_SUFFIX)


def snapshot_scope(profile: Any, package: str) -> str:
    """The snapshot a module's graph is built from: its own, or the whole profile's for the empty canvas."""
    return profile.default_base_namespace if is_scratch(package) else package


def snapshot_commit(snapshot: Mapping[str, Any]) -> str | None:
    """The schema commit a snapshot was read from (its package version if not installed from git)."""
    source = snapshot.get("source") or {}
    return source.get("commit") or source.get("version")


def _own(edit: Mapping[str, Any], package: str) -> bool:
    return edit.get("package") in (None, package)


def edited(
    profile: Any,
    snapshot: dict[str, Any],
    package: str,
    stored: Sequence[Mapping[str, Any]] = (),
    *,
    commit: str | None = None,
) -> Edited:
    """The snapshot with the profile's edits replayed; conflicts are the module's own."""
    commit = commit or snapshot_commit(snapshot)
    schema, applied, conflicts = edit_ops.apply_edits(snapshot["linkml"], stored, rules=profile.edit_rules, commit=commit)
    conflicts = [conflict for conflict in conflicts if _own(conflict["edit"], package)]
    return Edited(profile, snapshot, schema, applied, conflicts, commit)


def module_view(state: Edited, package: str, empty: bool = False) -> dict[str, Any]:
    """The extraction document the graph reads; the empty canvas binds nothing of the source."""
    extraction = state.snapshot["extraction"]
    if empty or is_scratch(package):
        # Only what the edits added to this module; nothing the source module binds.
        extraction = {**extraction, "modules": []}
    return extraction


def build_graph(state: Edited, package: str, *, empty: bool = False, **flags: Any) -> dict[str, Any]:
    """The module's graph from the edited schema, with `applied_edits` and `edit_conflicts` when there are any.

    Raises `graph.RootNotFound` for a root the module does not offer.
    """
    root = flags.get("root") or None
    result = graph.build_graph(state.schema, module_view(state, package, empty), package, **{**flags, "root": root})
    result["root"] = flags.get("root")
    if state.applied:
        result["applied_edits"] = list(state.applied)
    if state.conflicts:
        result["edit_conflicts"] = state.conflicts
    return result


def section_names(state: Edited, package: str) -> list[str]:
    """The roots a module offers, edits included."""
    return graph.section_names(state.schema, module_view(state, package), package)


def usage_source(state: Edited, section_id: str) -> str | None:
    """The class whose usage a section shows: its source class when renamed; None for a class only the edits have."""
    cls = (state.schema.get("classes") or {}).get(section_id)
    if cls is None:
        return section_id
    if graph.annotation(cls, edit_ops.ADDED) == "true":
        return None  # no code acts on a class that only the edits have
    return graph.source_class_id(section_id, cls)


def usage_entries(snapshots: Sequence[Mapping[str, Any]], section_id: str) -> list[dict[str, Any]]:
    """Usage of a section from the first snapshot that holds it (the module's, then the profile's)."""
    for snapshot in snapshots:
        entries = graph.usage_entries(snapshot["extraction"], section_id)
        if entries is not None:
            return entries
    return []


def owner(state: Edited, edit: Mapping[str, Any], package: str) -> str:
    """The module an edit is stored under: the module of the class it changes, else the module shown.

    Classes outside the profile's namespace (NOMAD base sections from
    nomad-lab) belong to no module of the profile; their edits stay with the
    module they were made in.
    """
    if edit["op"] == "add_class":
        return package
    classes = state.schema.get("classes") or {}
    name = edit["target"]
    if name not in classes:
        enum = (state.schema.get("enums") or {}).get(name) or {}
        vocabulary = graph.annotation(enum, "source_vocabulary_class")
        # A NOMAD enum is named after its quantity: `<class>.<attribute>`.
        name = vocabulary if vocabulary in classes else name.rpartition(".")[0]
    cls = classes.get(name)
    if cls is None:
        return package
    module = graph.class_module(name, cls)
    namespace = state.profile.default_base_namespace
    return module if module == namespace or module.startswith(f"{namespace}.") else package


def prepare(state: Edited, package: str, requests: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """New edits (`op`, `target`, `payload`), checked in order on top of the replayed ones; raises `EditError`.

    All of them apply or none: an error in one leaves nothing to store. Each
    edit gets the module it is to be stored under (`package`). `state` is
    changed: its schema ends up with the new edits applied.
    """
    schema = state.schema
    prepared = []
    for request in requests:
        edit = edit_ops.prepare_edit(
            schema, str(request.get("op") or ""), str(request.get("target") or ""), request.get("payload") or {},
            rules=state.profile.edit_rules, package=package, profile=state.profile.key, commit=state.commit,
        )
        edit["package"] = owner(state, edit, package)
        edit_ops.apply_edit(schema, edit, rules=state.profile.edit_rules)
        prepared.append(edit)
    return prepared


def root_after(state: Edited, package: str, prepared: Sequence[Mapping[str, Any]], root: str | None) -> str | None:
    """The root a graph can use once new edits apply: renamed with its class, or none when the class is gone.

    `state` is the schema before the new edits.
    """
    if not root:
        return root
    view = module_view(state, package)
    _, before = graph.entry_points(state.schema, view, package)
    after_schema, _, _ = edit_ops.apply_edits(state.schema, prepared, rules=state.profile.edit_rules)
    _, after = graph.entry_points(after_schema, view, package)
    if root in after:
        return root
    target = before.get(root)
    for edit in prepared:
        if edit["op"] == "rename_class" and edit["target"] == target:
            target = f"{target.rpartition('.')[0]}.{edit['payload']['new_name']}"
    return next((name for name, cls in after.items() if cls == target), None)


def with_stored(
    result: dict[str, Any], prepared: Sequence[Mapping[str, Any]], saved: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """A graph built with edits before they were stored, showing them as stored (with their ids)."""
    stored_as = {id(edit): stored for edit, stored in zip(prepared, saved)}
    if "applied_edits" in result:
        result["applied_edits"] = [stored_as.get(id(edit), edit) for edit in result["applied_edits"]]
    for conflict in result.get("edit_conflicts") or ():
        conflict["edit"] = stored_as.get(id(conflict["edit"]), conflict["edit"])
    result["persisted_edits"] = list(saved)
    return result


def snapshot_yaml(snapshot: Mapping[str, Any]) -> str:
    """The snapshot's schema as converted, as LinkML YAML."""
    from .linkml_yaml import dump_yaml

    return dump_yaml(
        snapshot["linkml"], profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        report=snapshot["report"],
    )


def edited_yaml(state: Edited) -> str:
    """The edited schema as LinkML YAML; marked as edited when an edit applied."""
    from .linkml_yaml import dump_yaml

    snapshot = state.snapshot
    return dump_yaml(
        state.schema, profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        edited=bool(state.applied), report=snapshot["report"],
    )

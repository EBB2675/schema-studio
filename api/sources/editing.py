"""Edits on the server: stored edits replayed onto a snapshot's LinkML schema, then the graph adapter.

Shared by Light Mode and Dev Mode, which store edits differently (SQLite,
MongoDB); here an edit is the plain dict of `edits.py` plus the module it is
stored under (`package`). The edited LinkML schema is the truth: graphs, roots,
usage and the LinkML download all read it.

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

Dev Mode reads a branch from a git worktree (`Source`); the graph, roots, the
LinkML download and new edits then all use that branch's snapshot.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..light_mode.schema_source import SchemaProfile, schema_profile_for_package
from . import edits as edit_ops
from . import graph
from .extraction import DEFAULT_EXTRACTOR
from .extraction import build_graph as extracted_graph
from .extraction import extraction_mode, get_usage_for_section
from .extraction import list_sections as extracted_sections
from .legacy import ExtractionFailed, UsageEntry
from .linkml_yaml import dump_yaml
from .snapshots import get_snapshot, snapshot_yaml

SCRATCH_SUFFIX = ".custom_schema"

EditError = edit_ops.EditError


class EditsUnavailable(RuntimeError):
    """The profile is on the legacy extraction path, which has no LinkML schema to edit."""


@dataclass(frozen=True)
class Source:
    """A git worktree to read the schema from instead of the installed package (Dev Mode branches)."""

    root: Path
    sha: str | None = None


@dataclass
class Edited:
    """A snapshot's schema with edits replayed onto it."""

    profile: SchemaProfile
    snapshot: dict[str, Any]
    schema: dict[str, Any]
    applied: list[Mapping[str, Any]] = field(default_factory=list)
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    commit: str | None = None


def is_scratch(package: str) -> bool:
    return package.endswith(SCRATCH_SUFFIX)


def snapshot_commit(snapshot: Mapping[str, Any]) -> str | None:
    """The schema commit a snapshot was read from (its package version if not installed from git)."""
    source = snapshot.get("source") or {}
    return source.get("commit") or source.get("version")


def rules_summary(profile: SchemaProfile) -> dict[str, Any]:
    return edit_ops.rules_summary(profile.edit_rules)


def editable(profile: SchemaProfile) -> bool:
    return extraction_mode(profile) == "linkml"


def _require_editable(profile: SchemaProfile) -> None:
    if not editable(profile):
        raise EditsUnavailable(
            f"Editing {profile.label} needs the LinkML extraction; SCHEMA_STUDIO_EXTRACTION selects legacy for it."
        )


def _snapshot(profile: SchemaProfile, package: str, source: Source | None) -> dict[str, Any]:
    scope = profile.default_base_namespace if is_scratch(package) else package
    if source is None:
        return get_snapshot(profile, scope)
    return get_snapshot(profile, scope, source_root=source.root, source_version=source.sha)


def _own(edit: Mapping[str, Any], package: str) -> bool:
    return edit.get("package") in (None, package)


def edited(
    package: str,
    stored: Sequence[Mapping[str, Any]] = (),
    *,
    base_namespace: str | None = None,
    source: Source | None = None,
) -> Edited:
    """The module's snapshot (the whole profile's for the empty canvas) with the profile's edits replayed.

    Conflicts are the module's own; edits stored under other modules that do
    not apply here are left out without a report.
    """
    profile = schema_profile_for_package(package, base_namespace)
    _require_editable(profile)
    snapshot = _snapshot(profile, package, source)
    commit = source.sha if source is not None and source.sha else snapshot_commit(snapshot)
    schema, applied, conflicts = edit_ops.apply_edits(snapshot["linkml"], stored, rules=profile.edit_rules, commit=commit)
    conflicts = [conflict for conflict in conflicts if _own(conflict["edit"], package)]
    return Edited(profile=profile, snapshot=snapshot, schema=schema, applied=applied, conflicts=conflicts, commit=commit)


def _unsupported(stored: Sequence[Mapping[str, Any]], profile: SchemaProfile, package: str) -> list[dict[str, Any]]:
    detail = f"edits need the LinkML extraction, which SCHEMA_STUDIO_EXTRACTION turns off for {profile.label}"
    return [{"edit": edit, "reason": "unsupported", "detail": detail, "applied": False}
            for edit in stored if _own(edit, package)]


def _module_view(state: Edited, package: str, empty: bool) -> dict[str, Any]:
    extraction = state.snapshot["extraction"]
    if empty or is_scratch(package):
        # Only what the edits added to this module; nothing the source module binds.
        extraction = {**extraction, "modules": []}
    return extraction


def build_graph(
    package: str,
    stored: Sequence[Mapping[str, Any]] = (),
    *,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    base_namespace: str | None = None,
    empty: bool = False,
    source: Source | None = None,
    extractor: str | None = None,
) -> dict[str, Any]:
    """The module's graph from its edited schema, with `applied_edits` and `edit_conflicts` when there are any.

    `empty` starts the graph only from classes the edits added to the module.
    A custom `extractor` (Dev Mode) builds the graph on the legacy path, where
    edits do not apply.
    """
    profile = schema_profile_for_package(package, base_namespace)
    flags = {
        "root": root or None,
        "include_quantities": include_quantities,
        "include_subsections": include_subsections,
        "include_inheritance": include_inheritance,
        "allow_cross_module": allow_cross_module,
        "base_namespace": base_namespace,
    }
    custom = (extractor or DEFAULT_EXTRACTOR) != DEFAULT_EXTRACTOR
    if custom or not editable(profile):
        if empty:
            result: dict[str, Any] = {"package": package, "root": root, "nodes": [], "edges": []}
        else:
            located = {} if source is None else {"source_root": source.root, "source_version": source.sha}
            result = extracted_graph(package, **flags, extractor=extractor, **located)
        conflicts: list[dict[str, Any]] = _unsupported(stored, profile, package)
        applied: list[Mapping[str, Any]] = []
    else:
        state = edited(package, stored, base_namespace=base_namespace, source=source)
        try:
            result = graph.build_graph(state.schema, _module_view(state, package, empty), package, **flags)
        except graph.RootNotFound as exc:
            raise ExtractionFailed(f"ValueError: {exc}") from exc
        result["root"] = root
        applied, conflicts = state.applied, state.conflicts
    if applied:
        result["applied_edits"] = list(applied)
    if conflicts:
        result["edit_conflicts"] = conflicts
    return result


def list_sections(
    package: str, stored: Sequence[Mapping[str, Any]] = (), *, source: Source | None = None,
) -> list[str]:
    """The roots a module offers, edits included."""
    profile = schema_profile_for_package(package)
    if not editable(profile) or (not stored and not is_scratch(package) and source is None):
        return extracted_sections(package)
    state = edited(package, stored, source=source)
    return graph.section_names(state.schema, _module_view(state, package, False), package)


def usage_for_section(
    section_id: str, package: str | None, stored: Sequence[Mapping[str, Any]] = (), *, source: Source | None = None,
) -> tuple:
    """Usage info of a section; a class an edit renamed keeps the usage of its source class.

    With a `source` (Dev Mode branch) it comes from the branch's snapshots:
    the module's, or the whole profile's when the module does not hold the class.
    """
    state = None
    if package and (stored or source is not None):
        profile = schema_profile_for_package(package)
        if editable(profile):
            state = edited(package, stored, source=source)
            cls = (state.schema.get("classes") or {}).get(section_id)
            if cls is not None and graph.annotation(cls, edit_ops.ADDED) == "true":
                return ()  # no code acts on a class that only the edits have
            if cls is not None:
                section_id = graph.source_class_id(section_id, cls)
    if source is None or state is None:
        return get_usage_for_section(section_id, package)
    for snapshot in (state.snapshot, _snapshot(state.profile, state.profile.default_base_namespace, source)):
        entries = graph.usage_entries(snapshot["extraction"], section_id)
        if entries is not None:
            return tuple(UsageEntry(**entry) for entry in entries)
    return ()


def _owner(state: Edited, edit: Mapping[str, Any], package: str) -> str:
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


def prepare(
    package: str,
    stored: Sequence[Mapping[str, Any]],
    requests: Sequence[Mapping[str, Any]],
    *,
    base_namespace: str | None = None,
    source: Source | None = None,
) -> list[dict[str, Any]]:
    """New edits (`op`, `target`, `payload`), checked in order on top of the stored ones; raises `EditError`.

    All of them apply or none: an error in one leaves nothing to store. Each
    edit gets the module it is to be stored under (`package`).
    """
    state = edited(package, stored, base_namespace=base_namespace, source=source)
    schema = state.schema
    prepared = []
    for request in requests:
        edit = edit_ops.prepare_edit(
            schema, str(request.get("op") or ""), str(request.get("target") or ""), request.get("payload") or {},
            rules=state.profile.edit_rules, package=package, profile=state.profile.key, commit=state.commit,
        )
        edit["package"] = _owner(state, edit, package)
        edit_ops.apply_edit(schema, edit, rules=state.profile.edit_rules)
        prepared.append(edit)
    return prepared


def root_after(
    package: str,
    stored: Sequence[Mapping[str, Any]],
    prepared: Sequence[Mapping[str, Any]],
    root: str | None,
    *,
    base_namespace: str | None = None,
    source: Source | None = None,
) -> str | None:
    """The root a graph can use once new edits apply: renamed with its class, or none when the class is gone."""
    if not root:
        return root
    state = edited(package, stored, base_namespace=base_namespace, source=source)
    view = _module_view(state, package, False)
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


def linkml_yaml(package: str, stored: Sequence[Mapping[str, Any]] = (), *, source: Source | None = None) -> str:
    """The module's LinkML schema as YAML, with the stored edits replayed onto it.

    Without edits, or on the legacy extraction path (which has nothing to
    edit), it is the snapshot's schema as converted.
    """
    profile = schema_profile_for_package(package)
    if not stored or not editable(profile):
        return snapshot_yaml(_snapshot(profile, package, source))
    state = edited(package, stored, source=source)
    snapshot = state.snapshot
    return dump_yaml(
        state.schema, profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        edited=bool(state.applied), report=snapshot["report"],
    )


__all__ = [
    "Edited", "EditError", "EditsUnavailable", "SCRATCH_SUFFIX", "Source", "build_graph", "edited", "editable",
    "is_scratch", "linkml_yaml", "list_sections", "prepare", "root_after", "rules_summary", "snapshot_commit",
    "usage_for_section", "with_stored",
]

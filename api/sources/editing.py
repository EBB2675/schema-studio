"""Edits on the server: the snapshot of a module, with the stored edits replayed by `core`.

Shared by Light and Dev Mode, which store edits differently (SQLite,
MongoDB); here an edit is the plain dict of `edits.py` plus the module it is
stored under (`package`). The edited LinkML schema is the truth: graphs, roots,
usage and the LinkML download all read it. How edits replay, which module
owns an edit and the empty canvas are described in `core.py`; this module
finds the snapshots and keeps the legacy extraction path working.

Dev Mode reads a branch from a git worktree (`Source`); the graph, roots, the
LinkML download and new edits then all use that branch's snapshot.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..light_mode.schema_source import SchemaProfile, schema_profile_for_package
from . import core
from . import edits as edit_ops
from . import graph
from .extraction import DEFAULT_EXTRACTOR
from .extraction import build_graph as extracted_graph
from .extraction import extraction_mode, get_usage_for_section
from .extraction import list_sections as extracted_sections
from .legacy import UnknownRoot, UsageEntry
from .snapshots import get_snapshot, snapshot_yaml

SCRATCH_SUFFIX = core.SCRATCH_SUFFIX
Edited = core.Edited
is_scratch = core.is_scratch
snapshot_commit = core.snapshot_commit
with_stored = core.with_stored

EditError = edit_ops.EditError


class EditsUnavailable(RuntimeError):
    """The profile is on the legacy extraction path, which has no LinkML schema to edit."""


@dataclass(frozen=True)
class Source:
    """A git worktree to read the schema from instead of the installed package (Dev Mode branches)."""

    root: Path
    sha: str | None = None


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
    scope = core.snapshot_scope(profile, package)
    if source is None:
        return get_snapshot(profile, scope)
    return get_snapshot(profile, scope, source_root=source.root, source_version=source.sha)


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
    return core.edited(profile, snapshot, package, stored, commit=source.sha if source is not None else None)


def _unsupported(stored: Sequence[Mapping[str, Any]], profile: SchemaProfile, package: str) -> list[dict[str, Any]]:
    detail = f"edits need the LinkML extraction, which SCHEMA_STUDIO_EXTRACTION turns off for {profile.label}"
    return [{"edit": edit, "reason": "unsupported", "detail": detail, "applied": False}
            for edit in stored if edit.get("package") in (None, package)]


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
            return core.build_graph(state, package, empty=empty, **{**flags, "root": root})
        except graph.RootNotFound as exc:
            raise UnknownRoot(f"ValueError: {exc}") from exc
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
    return core.section_names(state, package)


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
            source_id = core.usage_source(state, section_id)
            if source_id is None:
                return ()
            section_id = source_id
    if source is None or state is None:
        return get_usage_for_section(section_id, package)
    snapshots = (state.snapshot, _snapshot(state.profile, state.profile.default_base_namespace, source))
    return tuple(UsageEntry(**entry) for entry in core.usage_entries(snapshots, section_id))


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
    return core.prepare(state, package, requests)


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
    return core.root_after(state, package, prepared, root)


def linkml_yaml(package: str, stored: Sequence[Mapping[str, Any]] = (), *, source: Source | None = None) -> str:
    """The module's LinkML schema as YAML, with the stored edits replayed onto it.

    Without edits, or on the legacy extraction path (which has nothing to
    edit), it is the snapshot's schema as converted.
    """
    profile = schema_profile_for_package(package)
    if not stored or not editable(profile):
        return snapshot_yaml(_snapshot(profile, package, source))
    return core.edited_yaml(edited(package, stored, source=source))


__all__ = [
    "Edited", "EditError", "EditsUnavailable", "SCRATCH_SUFFIX", "Source", "build_graph", "edited", "editable",
    "is_scratch", "linkml_yaml", "list_sections", "prepare", "root_after", "rules_summary", "snapshot_commit",
    "usage_for_section", "with_stored",
]

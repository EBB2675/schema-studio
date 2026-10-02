"""Edits on the server: stored edits replayed onto a snapshot's LinkML schema, then the graph adapter.

Shared by Light Mode and Dev Mode, which store edits differently (SQLite,
MongoDB); here an edit is the plain dict of `edits.py`. The edited LinkML
schema is the truth: graphs, roots, usage and the LinkML download all read it.

Edits belong to one profile module (`package`). The empty canvas uses a
module that does not exist (`<base namespace>.custom_schema`); its edits apply
to the whole profile's schema, so new classes can build on existing ones, and
its graph shows only the classes the edits added there.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..light_mode.schema_source import SchemaProfile, schema_profile_for_package
from . import edits as edit_ops
from . import graph
from .extraction import build_graph as extracted_graph
from .extraction import extraction_mode, get_usage_for_section
from .extraction import list_sections as extracted_sections
from .legacy import ExtractionFailed
from .linkml_yaml import dump_yaml
from .snapshots import get_snapshot, snapshot_yaml

SCRATCH_SUFFIX = ".custom_schema"

EditError = edit_ops.EditError


class EditsUnavailable(RuntimeError):
    """The profile is on the legacy extraction path, which has no LinkML schema to edit."""


@dataclass
class Edited:
    """A snapshot's schema with edits replayed onto it."""

    profile: SchemaProfile
    snapshot: dict[str, Any]
    schema: dict[str, Any]
    applied: list[Mapping[str, Any]] = field(default_factory=list)
    conflicts: list[dict[str, Any]] = field(default_factory=list)

    @property
    def commit(self) -> str | None:
        return snapshot_commit(self.snapshot)


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


def edited(
    package: str,
    stored: Sequence[Mapping[str, Any]] = (),
    *,
    base_namespace: str | None = None,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> Edited:
    """The module's snapshot (the whole profile's for the empty canvas) with the stored edits replayed."""
    profile = schema_profile_for_package(package, base_namespace)
    _require_editable(profile)
    scope = profile.default_base_namespace if is_scratch(package) else package
    snapshot = get_snapshot(profile, scope, source_root=source_root, source_version=source_version)
    schema, applied, conflicts = edit_ops.apply_edits(
        snapshot["linkml"], stored, rules=profile.edit_rules, commit=snapshot_commit(snapshot),
    )
    return Edited(profile=profile, snapshot=snapshot, schema=schema, applied=applied, conflicts=conflicts)


def _unsupported(stored: Sequence[Mapping[str, Any]], profile: SchemaProfile) -> list[dict[str, Any]]:
    detail = f"edits need the LinkML extraction, which SCHEMA_STUDIO_EXTRACTION turns off for {profile.label}"
    return [{"edit": edit, "reason": "unsupported", "detail": detail, "applied": False} for edit in stored]


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
) -> dict[str, Any]:
    """The module's graph from its edited schema, with `applied_edits` and `edit_conflicts` when there are any.

    `empty` starts the graph only from classes the edits added to the module.
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
    if not editable(profile):
        result = {"package": package, "root": root, "nodes": [], "edges": []} if empty else \
            extracted_graph(package, **flags)
        conflicts: list[dict[str, Any]] = _unsupported(stored, profile)
        applied: list[Mapping[str, Any]] = []
    else:
        state = edited(package, stored, base_namespace=base_namespace)
        extraction = state.snapshot["extraction"]
        if empty or is_scratch(package):
            # Only what the edits added to this module; nothing the source module binds.
            extraction = {**extraction, "modules": []}
        try:
            result = graph.build_graph(state.schema, extraction, package, **flags)
        except graph.RootNotFound as exc:
            raise ExtractionFailed(f"ValueError: {exc}") from exc
        result["root"] = root
        applied, conflicts = state.applied, state.conflicts
    if applied:
        result["applied_edits"] = list(applied)
    if conflicts:
        result["edit_conflicts"] = conflicts
    return result


def list_sections(package: str, stored: Sequence[Mapping[str, Any]] = ()) -> list[str]:
    """The roots a module offers, edits included."""
    profile = schema_profile_for_package(package)
    if not editable(profile) or (not stored and not is_scratch(package)):
        return extracted_sections(package)
    state = edited(package, stored)
    extraction = state.snapshot["extraction"]
    if is_scratch(package):
        extraction = {**extraction, "modules": []}
    return graph.section_names(state.schema, extraction, package)


def usage_for_section(section_id: str, package: str | None, stored: Sequence[Mapping[str, Any]] = ()) -> tuple:
    """Usage info of a section; a class an edit renamed keeps the usage of its source class."""
    if stored and package:
        profile = schema_profile_for_package(package)
        if editable(profile):
            cls = (edited(package, stored).schema.get("classes") or {}).get(section_id)
            if cls is not None and graph.annotation(cls, edit_ops.ADDED) == "true":
                return ()  # no code acts on a class that only the edits have
            if cls is not None:
                section_id = graph.source_class_id(section_id, cls)
    return get_usage_for_section(section_id, package)


def prepare(
    package: str,
    stored: Sequence[Mapping[str, Any]],
    requests: Sequence[Mapping[str, Any]],
    *,
    base_namespace: str | None = None,
) -> list[dict[str, Any]]:
    """New edits (`op`, `target`, `payload`), checked in order on top of the stored ones; raises `EditError`.

    All of them apply or none: an error in one leaves nothing to store.
    """
    state = edited(package, stored, base_namespace=base_namespace)
    schema = state.schema
    prepared = []
    for request in requests:
        edit = edit_ops.prepare_edit(
            schema, str(request.get("op") or ""), str(request.get("target") or ""), request.get("payload") or {},
            rules=state.profile.edit_rules, package=package, profile=state.profile.key, commit=state.commit,
        )
        edit_ops.apply_edit(schema, edit, rules=state.profile.edit_rules)
        prepared.append(edit)
    return prepared


def linkml_yaml(package: str, stored: Sequence[Mapping[str, Any]] = ()) -> str:
    """The module's LinkML schema as YAML, with the stored edits replayed onto it.

    Without edits, or on the legacy extraction path (which has nothing to
    edit), it is the snapshot's schema as converted.
    """
    profile = schema_profile_for_package(package)
    if not stored or not editable(profile):
        scope = profile.default_base_namespace if is_scratch(package) else package
        return snapshot_yaml(get_snapshot(profile, scope))
    state = edited(package, stored)
    snapshot = state.snapshot
    return dump_yaml(
        state.schema, profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        edited=bool(state.applied), report=snapshot["report"],
    )


__all__ = [
    "Edited", "EditError", "EditsUnavailable", "SCRATCH_SUFFIX", "build_graph", "edited", "editable", "is_scratch",
    "linkml_yaml", "list_sections", "prepare", "rules_summary", "snapshot_commit", "usage_for_section",
]

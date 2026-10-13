"""Graphs, roots and usage info for the app, through the legacy extraction or through LinkML.

`SCHEMA_STUDIO_EXTRACTION` chooses the path per profile:

- `linkml` (default): the profile's contract script extracts the module once,
  the snapshot holds it converted into LinkML, and `graph.py` builds the
  graph from that;
- `legacy`: `extractor/scripts/legacy.py` builds the graph inside the profile
  environment (see `legacy.py` here).

The value is either one setting for every profile (`legacy`) or a
comma-separated list per profile (`nomad-simulations=legacy,bam-masterdata=legacy`);
profiles not listed use `linkml`. A profile without a LinkML conversion always
uses `legacy`.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Collection
from pathlib import Path

from ..light_mode.schema_source import SchemaProfile, schema_profile_for_package
from . import graph, legacy
from .legacy import ExtractionFailed, UnknownRoot, UsageEntry
from .snapshots import get_snapshot, supports_linkml

logger = logging.getLogger(__name__)

EXTRACTION_SETTING = "SCHEMA_STUDIO_EXTRACTION"
EXTRACTION_MODES = ("legacy", "linkml")
DEFAULT_EXTRACTION = "linkml"
# The graph builder the legacy path runs by default; any other extractor stays on the legacy path.
DEFAULT_EXTRACTOR = "extractor.graph_builder:build_graph"


def _parse_setting(raw: str) -> dict[str, str]:
    """`linkml` -> {"*": "linkml"}; `a=linkml,b=legacy` -> {"a": "linkml", "b": "legacy"}."""
    settings: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        key, _, value = part.rpartition("=")
        key, value = key.strip() or "*", value.strip().lower()
        if value not in EXTRACTION_MODES:
            logger.warning("Ignoring %s entry %r: expected one of %s", EXTRACTION_SETTING, part, ", ".join(EXTRACTION_MODES))
            continue
        settings[key] = value
    return settings


def extraction_mode(profile: SchemaProfile) -> str:
    """`legacy` or `linkml` for this profile, from `SCHEMA_STUDIO_EXTRACTION`."""
    settings = _parse_setting(os.getenv(EXTRACTION_SETTING, ""))
    mode = settings.get(profile.key, settings.get("*", DEFAULT_EXTRACTION))
    if mode == "linkml" and not supports_linkml(profile):
        return "legacy"
    return mode


def build_graph(
    package: str,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    base_namespace: str | None = None,
    expand: Collection[str] = (),
    *,
    extractor: str | None = None,
    source_root: Path | None = None,
    source_version: str | None = None,
) -> dict:
    """The graph JSON for a module, starting at `root` if given, from the profile's extraction path.

    `expand` (classes whose subclasses are drawn) is not available on the legacy path.
    """
    profile = schema_profile_for_package(package, base_namespace)
    flags = {
        "root": root,
        "include_quantities": include_quantities,
        "include_subsections": include_subsections,
        "include_inheritance": include_inheritance,
        "allow_cross_module": allow_cross_module,
        "base_namespace": base_namespace,
    }
    if extraction_mode(profile) == "legacy" or (extractor or DEFAULT_EXTRACTOR) != DEFAULT_EXTRACTOR:
        return legacy.build_graph(
            package, **flags, extractor=extractor, source_root=source_root, source_version=source_version,
        )
    snapshot = get_snapshot(profile, package, source_root=source_root, source_version=source_version)
    try:
        return graph.build_graph(snapshot["linkml"], snapshot["extraction"], package, **flags, expand=expand)
    except graph.RootNotFound as exc:
        # The same error the legacy path reports.
        raise UnknownRoot(f"ValueError: {exc}") from exc


def list_sections(package: str) -> list[str]:
    """The roots a module offers: its section classes within its namespace."""
    profile = schema_profile_for_package(package)
    if extraction_mode(profile) == "legacy":
        return legacy.list_sections(package)
    snapshot = get_snapshot(profile, package)
    return graph.section_names(snapshot["linkml"], snapshot["extraction"], package)


def list_schema_modules(base_package: str) -> list[dict]:
    """Schema modules under `base_package` with their roots, as `{"package": ..., "sections": [...]}`."""
    profile = schema_profile_for_package(base_package)
    # The LinkML path reads whole profiles; any other namespace stays on the legacy path.
    if extraction_mode(profile) == "legacy" or base_package != profile.default_base_namespace:
        return legacy.list_schema_modules(base_package)
    snapshot = get_snapshot(profile, base_package)
    return graph.schema_modules(snapshot["linkml"], snapshot["extraction"])


def get_usage_for_section(section_id: str, package: str | None = None) -> tuple[UsageEntry, ...]:
    """The normalization code paths that act on a section.

    On the LinkML path they come from the snapshot of `package` (the module
    whose graph shows the section), or of the whole profile when that module
    does not hold the section.
    """
    # A nomad-lab base section (`nomad.…`) names no profile; the module shown does.
    profile = schema_profile_for_package(section_id, package)
    if extraction_mode(profile) == "legacy":
        return legacy.get_usage_for_section(section_id)
    scopes = [package] if package and schema_profile_for_package(package) is profile else []
    scopes.append(profile.default_base_namespace)
    for scope in dict.fromkeys(scopes):
        entries = graph.usage_entries(get_snapshot(profile, scope)["extraction"], section_id)
        if entries is not None:
            return tuple(UsageEntry(**entry) for entry in entries)
    return ()

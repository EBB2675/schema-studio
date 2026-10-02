"""A tiny converted snapshot for endpoint tests, so edits are really replayed onto LinkML data."""
from __future__ import annotations

from typing import Any

# Tests change these to stand for a new schema commit.
SOURCE: dict[str, str] = {"commit": "c0ffee", "description": "The root."}


def reset() -> None:
    SOURCE.update(commit="c0ffee", description="The root.")
    CALLS.clear()


# A class of another module that every module's graph reaches (through `RootSection.shared`).
SHARED = "nomad_simulations.schema_packages.beta.Shared"
CALLS: list[dict[str, Any]] = []


def fake_snapshot(_profile: Any, scope: str | None = None, **kwargs: Any) -> dict[str, Any]:
    """The module `scope` holding `<scope>.RootSection`, offered as root, which holds `Shared`."""
    CALLS.append({"scope": scope, **kwargs})
    root = f"{scope}.RootSection"
    label = {"name": "label", "range": "string", "annotations": {
        "source_kind": "quantity", "display_dtype": "m_str(str)", "display_shape": "[]"}}
    schema = {
        "name": scope, "default_prefix": "nomadsim",
        "classes": {
            root: {"name": root, "title": "RootSection", "description": SOURCE["description"], "attributes": {
                "label": label,
                "shared": {"name": "shared", "range": SHARED, "annotations": {
                    "source_kind": "subsection", "display_card": "0..1"}},
            }},
            SHARED: {"name": SHARED, "title": "Shared", "description": "Shared.", "attributes": {"note": {
                **label, "name": "note"}}},
        },
        "enums": {},
    }
    commit = kwargs.get("source_version") or SOURCE["commit"]
    return {
        "profile": "nomad-simulations", "tools": {}, "report": [],
        "source": {"name": "nomad-simulations", "module": scope, "version": "1.0", "commit": commit},
        "extraction": {"modules": [{"name": scope, "classes": [root]}], "classes": [], "usage": {}},
        "linkml": schema,
    }

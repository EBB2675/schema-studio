"""A tiny converted snapshot for endpoint tests, so edits are really replayed onto LinkML data."""
from __future__ import annotations

from typing import Any

# Tests change these to stand for a new schema commit.
SOURCE: dict[str, str] = {"commit": "c0ffee", "description": "The root."}


def reset() -> None:
    SOURCE.update(commit="c0ffee", description="The root.")


def fake_snapshot(_profile: Any, scope: str | None = None, **_kwargs: Any) -> dict[str, Any]:
    """The module `scope` holding `<scope>.RootSection`, with one quantity, offered as root."""
    root = f"{scope}.RootSection"
    schema = {
        "name": scope, "default_prefix": "nomadsim",
        "classes": {root: {"name": root, "title": "RootSection", "description": SOURCE["description"], "attributes": {
            "label": {"name": "label", "range": "string", "annotations": {
                "source_kind": "quantity", "display_dtype": "m_str(str)", "display_shape": "[]"}},
        }}},
        "enums": {},
    }
    return {
        "profile": "nomad-simulations", "tools": {}, "report": [],
        "source": {"name": "nomad-simulations", "module": scope, "version": "1.0", "commit": SOURCE["commit"]},
        "extraction": {"modules": [{"name": scope, "classes": [root]}], "classes": [], "usage": {}},
        "linkml": schema,
    }

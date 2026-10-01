"""Find the schema modules of an installed package. Standard library only.

Shared by the scripts in this folder, which load it by file path. It runs inside
a profile environment, never in the app.
"""
from __future__ import annotations

import importlib
import importlib.metadata
import re
from pathlib import Path
from typing import Any

NOMAD_ENTRY_POINT_GROUP = "nomad.plugin"


def normalize_dist(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def list_modules_for_base(base_package: str) -> list[str]:
    """
    List module names under an installed package without importing submodules.
    This avoids side effects from module-level registration code.
    """
    try:
        pkg = importlib.import_module(base_package)
    except Exception:
        return []

    modules: set[str] = {base_package}
    pkg_paths = getattr(pkg, "__path__", None)
    if not pkg_paths:
        return sorted(modules)

    for raw_root in pkg_paths:
        root = Path(raw_root)
        if not root.exists():
            continue
        for py_file in root.rglob("*.py"):
            rel = py_file.relative_to(root)
            if py_file.name == "__init__.py":
                if rel.parts[:-1]:
                    mod_name = ".".join((base_package, *rel.parts[:-1]))
                else:
                    mod_name = base_package
            else:
                mod_name = ".".join((base_package, *rel.with_suffix("").parts))
            modules.add(mod_name)

    return sorted(modules)


def nomad_schema_modules(dist: str | None) -> tuple[list[str], list[dict]]:
    """
    Modules that the distribution registers as NOMAD schema package entry points.
    Parser, normalizer, app and example-upload entry points are skipped.
    """
    modules: set[str] = set()
    skipped: list[dict] = []
    wanted = normalize_dist(dist) if dist else None
    for entry_point in importlib.metadata.entry_points(group=NOMAD_ENTRY_POINT_GROUP):
        owner = getattr(getattr(entry_point, "dist", None), "name", None)
        if wanted and (not owner or normalize_dist(owner) != wanted):
            continue
        try:
            plugin = entry_point.load()
            if not any(cls.__name__ == "SchemaPackageEntryPoint" for cls in type(plugin).__mro__):
                continue
            schema_package = plugin.load()
            module = _module_of_schema_package(schema_package)
        except Exception as exc:
            skipped.append({"module": entry_point.value, "error": f"{type(exc).__name__}: {exc}"})
            continue
        if module:
            modules.add(module)
    return sorted(modules), skipped


def _module_of_schema_package(schema_package: Any) -> str | None:
    """The Python module that defines a NOMAD schema package."""
    for definition in getattr(schema_package, "section_definitions", None) or []:
        section_cls = getattr(definition, "section_cls", None)
        module = getattr(section_cls, "__module__", None)
        if module:
            return module
    name = getattr(schema_package, "name", None)
    return name if isinstance(name, str) and name else None


def candidate_modules(base: str, dist: str | None, discovery: list[str]) -> tuple[list[str], list[dict]]:
    """
    Modules under `base` found by the requested methods: "entry-points" (NOMAD
    schema entry points of `dist`) and/or "walk" (every module file under `base`).
    """
    candidates: set[str] = set()
    skipped: list[dict] = []
    if "entry-points" in discovery:
        found, failed = nomad_schema_modules(dist)
        candidates.update(found)
        skipped.extend(failed)
    if "walk" in discovery:
        candidates.update(list_modules_for_base(base))
    inside = sorted(module for module in candidates if module == base or module.startswith(f"{base}."))
    return inside, skipped

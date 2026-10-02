"""Run the existing graph extraction inside a schema environment.

Temporary bridge: it calls `extractor/graph_builder.py` and
`extractor/scripts/usage_index.py` unchanged, but with the interpreter of
`environments/<profile>/` instead of the app's. Standard library only.

Usage (always started by `extractor/runner.py`, in isolated mode):

    python -I legacy.py [--source-root DIR] COMMAND JSON_ARGUMENTS

Commands: info, catalog, sections, graph, usage.

stdout carries exactly one JSON document: {"ok": true, "result": ...} or
{"ok": false, "error": {"type", "message", "name"}} together with a non-zero
exit code. Everything else, including output printed by schema imports, goes to
stderr.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib
import importlib.metadata
import importlib.util
import json
import sys
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
EXTRACTOR_DIR = SCRIPTS_DIR.parent
DEFAULT_EXTRACTOR = "extractor.graph_builder:build_graph"


def _load_sibling(name: str, directory: Path = SCRIPTS_DIR):
    """Load an extractor module by file path, without touching the import path."""
    module_name = f"_schema_studio_{name}"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, directory / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_graph_builder():
    return _load_sibling("graph_builder", EXTRACTOR_DIR)


# -------- commands --------

def command_info(dist: str) -> dict:
    """Installed version and install origin of the schema package."""
    distribution = importlib.metadata.distribution(dist)
    try:
        raw = distribution.read_text("direct_url.json")
    except Exception:
        raw = None
    try:
        direct_url = json.loads(raw) if raw else None
    except Exception:
        direct_url = None
    return {
        "dist": dist,
        "version": distribution.version,
        "direct_url": direct_url if isinstance(direct_url, dict) else None,
        "python": ".".join(str(part) for part in sys.version_info[:3]),
    }


def command_catalog(base: str, dist: str | None = None, discovery: list[str] | None = None) -> dict:
    """Schema modules under `base` together with their section names."""
    graph_builder = _load_graph_builder()
    candidates, skipped = _load_sibling("discovery").candidate_modules(base, dist, discovery or ["walk"])

    modules: list[dict] = []
    for module in candidates:
        try:
            sections = graph_builder.list_sections(module)
        except Exception as exc:
            skipped.append({"module": module, "error": f"{type(exc).__name__}: {exc}"})
            continue
        if sections:
            modules.append({"package": module, "sections": sorted(sections)})
    return {"base": base, "modules": modules, "skipped": skipped}


def command_sections(package: str) -> list[str]:
    return sorted(_load_graph_builder().list_sections(package))


def command_graph(package: str, extractor: str | None = None, **options: Any) -> dict:
    if extractor and extractor != DEFAULT_EXTRACTOR:
        # A custom extractor is addressed as "module:function"; make the app's
        # own packages importable last so that environment packages win.
        sys.path.append(str(EXTRACTOR_DIR.parent))
        module_name, function_name = extractor.split(":", 1)
        build = getattr(importlib.import_module(module_name), function_name)
    else:
        build = _load_graph_builder().build_graph
    return build(package, **{key: value for key, value in options.items() if value is not None})


def command_usage(section_id: str) -> list[dict]:
    entries = _load_sibling("usage_index").get_usage_for_section(section_id)
    return [asdict(entry) for entry in entries]


COMMANDS = {
    "info": command_info,
    "catalog": command_catalog,
    "sections": command_sections,
    "graph": command_graph,
    "usage": command_usage,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-root", help="Folder to import the schema package from instead of the installed one")
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("arguments", help="JSON object with the command's arguments")
    args = parser.parse_args(argv)

    out = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.source_root:
                sys.path.insert(0, args.source_root)
            result = COMMANDS[args.command](**json.loads(args.arguments))
        payload = {"ok": True, "result": result}
        code = 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        payload = {
            "ok": False,
            "error": {"type": type(exc).__name__, "message": str(exc), "name": getattr(exc, "name", None)},
        }
        code = 1
    out.write(json.dumps(payload, ensure_ascii=False))
    out.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

"""
Guard: the app never installs or imports a schema package.

Schema packages only live in `environments/<profile>/`. The only code allowed
to import them are the scripts in `extractor/scripts/`, which run with the
interpreter of those environments.
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PACKAGES = ("nomad", "nomad_simulations", "nomad_measurements", "bam_masterdata")
ALLOWED = PROJECT_ROOT / "extractor" / "scripts"
SKIPPED_DIRS = {"__pycache__", "_data", "_tmp_data", "static", "node_modules", ".venv"}


def test_schema_packages_are_not_installed_in_the_app_environment():
    # A fresh interpreter, so that fake packages other tests put on the import
    # path cannot hide or fake an installed schema package.
    probe = (
        "import importlib.util, json; "
        f"print(json.dumps([p for p in {SCHEMA_PACKAGES!r} if importlib.util.find_spec(p) is not None]))"
    )
    result = subprocess.run([sys.executable, "-I", "-c", probe], capture_output=True, text=True, check=True)
    installed = json.loads(result.stdout)
    assert installed == [], (
        f"{installed} importable from the app environment; schema packages belong in environments/<profile>/"
    )


def _imported_modules(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.append((node.lineno, node.module))
    return found


def test_only_extractor_scripts_may_import_schema_packages():
    offenders: list[str] = []
    for top in ("api", "extractor"):
        for path in sorted((PROJECT_ROOT / top).rglob("*.py")):
            if SKIPPED_DIRS.intersection(path.parts) or ALLOWED in path.parents:
                continue
            for lineno, module in _imported_modules(path):
                if module.split(".")[0] in SCHEMA_PACKAGES:
                    offenders.append(f"{path.relative_to(PROJECT_ROOT)}:{lineno} imports {module}")
    assert not offenders, "\n".join(offenders)

from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path
from typing import Dict, Any
from .settings import EXTRACTOR_ENTRY

EXTRACTOR_TIMEOUT_SECONDS = int(os.getenv("SCHEMA_UML_EXTRACTOR_TIMEOUT_SECONDS", "120"))

# Path to *this* project (so we can import `extractor.*`)
APP_ROOT = Path(__file__).resolve().parents[1]

RUNNER_SCRIPT = r"""
import json, sys, importlib, os
entry = os.environ.get("SCHEMA_UML_EXTRACTOR", %r)
mod_name, func_name = entry.split(":")
mod = importlib.import_module(mod_name)
fn = getattr(mod, func_name)

args = {}
for a in sys.argv[2:]:
    if a.startswith("--") and "=" in a:
        k,v = a[2:].split("=",1)
        if v.lower() in ("true","false"): v = v.lower()=="true"
        args[k] = v

out = fn(sys.argv[1], **args)
print(json.dumps(out, ensure_ascii=False))
""" % EXTRACTOR_ENTRY


def build_graph_in_subprocess(
    worktree: Path,
    package: str,
    extractor: str | None = None,
    **kwargs
) -> Dict[str, Any]:
    env = os.environ.copy()

    # Make the schema worktree importable AND this app’s modules (extractor/*)
    py_paths = [
        str(worktree),
        str(worktree / "src"),
        str(APP_ROOT),                 # e.g. /…/schema-uml
        str(APP_ROOT / "extractor"),   # safety: direct path to extractor package
    ]
    existing = env.get("PYTHONPATH")
    if existing:
        py_paths.append(existing)
    env["PYTHONPATH"] = os.pathsep.join(py_paths)

    # Propagate extractor entry
    if extractor:
        env["SCHEMA_UML_EXTRACTOR"] = extractor
    else:
        env.setdefault("SCHEMA_UML_EXTRACTOR", EXTRACTOR_ENTRY)

    args = [package]
    for k, v in kwargs.items():
        if v is not None:
            args.append(f"--{k}={v}")
    try:
        proc = subprocess.run(
            [sys.executable, "-c", RUNNER_SCRIPT, *args],
            cwd=str(worktree),
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=EXTRACTOR_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"Extractor timed out after {EXTRACTOR_TIMEOUT_SECONDS}s for package '{package}'."
        ) from exc
    if proc.returncode != 0:
        raise RuntimeError(f"Extractor failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout)

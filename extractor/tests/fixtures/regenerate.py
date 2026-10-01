"""Regenerate the stored NOMAD extraction documents from the profile environments.

The schema branches move, so tests read these stored documents instead of the
live environments. Regenerate them on purpose only, and review the diff:

    .venv/bin/python extractor/tests/fixtures/regenerate.py [PROFILE ...]

Each document records the commit it was read from in `source.commit`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))

from extractor.contract import validate_document  # noqa: E402
from extractor.runner import ExtractorEnvironment, run_script  # noqa: E402

FIXTURES = Path(__file__).resolve().parent
SCRIPT = PROJECT_ROOT / "extractor" / "scripts" / "nomad.py"

# A few modules per profile, not whole packages, to keep the files small.
MODULES = {
    "nomad-simulations": [
        "nomad_simulations.schema_packages.model_method",
        "nomad_simulations.schema_packages.model_system",
    ],
    "nomad-measurements": [
        "nomad_measurements.general",
        "nomad_measurements.transmission.schema",
    ],
}


def regenerate(profile: str) -> Path:
    environment = ExtractorEnvironment(name=profile, directory=PROJECT_ROOT / "environments" / profile)
    arguments = ["--dist", profile]
    for module in MODULES[profile]:
        arguments += ["--module", module]
    payload = run_script(environment, SCRIPT, arguments=tuple(arguments))
    document = validate_document(payload["result"])
    path = FIXTURES / f"{profile}.json"
    path.write_text(json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main(argv: list[str]) -> int:
    for profile in argv or sorted(MODULES):
        path = regenerate(profile)
        print(f"{profile}: {path.relative_to(PROJECT_ROOT)} ({path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

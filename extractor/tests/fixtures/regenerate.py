"""Regenerate the stored extraction documents from the profile environments.

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

from api.light_mode.schema_source import SCHEMA_PROFILES  # noqa: E402
from extractor.contract import validate_document  # noqa: E402
from extractor.runner import run_script  # noqa: E402

FIXTURES = Path(__file__).resolve().parent

# A few modules per profile, not whole packages, to keep the files small. For
# bam-masterdata, a few classes of one module (and what they refer to):
# inherited properties (Amorphous, DeviceTraining), object links and vocabularies.
MODULES = {
    "nomad-simulations": [
        "nomad_simulations.schema_packages.model_method",
        "nomad_simulations.schema_packages.model_system",
    ],
    "nomad-measurements": [
        "nomad_measurements.general",
        "nomad_measurements.transmission.schema",
    ],
    "bam-masterdata-v0": ["bam_masterdata.datamodel.v0.object_types"],
}
ROOTS = {"bam-masterdata-v0": ["Amorphous", "DeviceTraining", "Calibration"]}


def regenerate(key: str) -> Path:
    profile = SCHEMA_PROFILES[key]
    arguments = ["--dist", profile.package_dist]
    for module in MODULES[key]:
        arguments += ["--module", module]
    for root in ROOTS.get(key, []):
        arguments += ["--root", root]
    payload = run_script(profile.environment, profile.contract_script, arguments=tuple(arguments))
    document = validate_document(payload["result"])
    path = FIXTURES / f"{key}.json"
    path.write_text(json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main(argv: list[str]) -> int:
    for profile in argv or sorted(MODULES):
        path = regenerate(profile)
        print(f"{profile}: {path.relative_to(PROJECT_ROOT)} ({path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

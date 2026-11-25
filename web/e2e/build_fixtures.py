"""Build smoke-test data with the production writer and checked-in extraction fixtures.

Only schema discovery/extraction is replaced. Conversion, graph generation, the
frontend bundle, and the browser Python engine are the production implementation.
Never run this over a deployment artifact containing real snapshots.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import build_snapshots  # noqa: E402
from api.sources.schema_source import SchemaProfile  # noqa: E402
from api.sources.snapshots import make_snapshot  # noqa: E402

PROFILES = ("nomad-simulations", "nomad-measurements", "bam-masterdata-v0")


def document(profile: SchemaProfile) -> dict:
    return json.loads((ROOT / "extractor/tests/fixtures" / f"{profile.key}.json").read_text())


def snapshot(profile: SchemaProfile, scope: str | None = None) -> dict:
    return make_snapshot(profile, scope or profile.default_base_namespace, document(profile))


def info(profile: SchemaProfile) -> SimpleNamespace:
    return SimpleNamespace(version=document(profile)["source"]["commit"], source="smoke-fixture", package_version="fixture")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        parser.error("output must be empty; rebuild the frontend before generating fixture data")
    with patch.object(build_snapshots, "get_snapshot", snapshot), patch.object(build_snapshots, "current_schema_info", info):
        return build_snapshots.main(["--out", str(args.out), "--graphs", *[f"--profile={key}" for key in PROFILES]])


if __name__ == "__main__":
    raise SystemExit(main())

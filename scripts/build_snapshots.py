"""Build the snapshot files of every schema profile, for a build that has no profile environments.

For each profile this writes the whole profile's snapshot and one snapshot
per schema module (extraction document and LinkML schema, as the app's
snapshot cache holds them), and an `index.json` describing what is there.
With `--graphs` it also writes, per module, the graph the web app asks for
first (its first root, and the profile's default root in the default module;
no edits, default filters), so the static site can show it before its Python
engine has loaded:

    <out>/index.json
    <out>/snapshots/<profile>/<module>.json
    <out>/graphs/<profile>/<module>/<root>.json

The profile environments must be set up (`uv sync --project
environments/<profile>`); they are read, never created or updated. The
static site reads these files; nothing here depends on how they are served.

    python scripts/build_snapshots.py --out web/dist/data --graphs
    python scripts/build_snapshots.py --out build/data --profile bam-masterdata
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.light_mode.schema_source import (  # noqa: E402
    SchemaProfile,
    current_schema_info,
    list_schema_profiles,
)
from api.sources import core, edits, graph  # noqa: E402
from api.sources.snapshots import get_snapshot, supports_linkml  # noqa: E402

INDEX_FORMAT = 1


def _write(path: Path, data: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def first_roots(profile: SchemaProfile, package: str, sections: list[str]) -> list[str]:
    """The roots the web app asks for first in a module: the profile's default root, else the first one."""
    roots = [profile.default_root] if package == profile.default_package and profile.default_root in sections else []
    return roots + [root for root in sections[:1] if root not in roots]


def build_profile(profile: SchemaProfile, out: Path, *, graphs: bool = False) -> dict[str, Any]:
    """Write one profile's files; returns its entry of `index.json`."""
    info = current_schema_info(profile)
    started = time.monotonic()
    whole = get_snapshot(profile)
    folder = f"snapshots/{profile.key}"
    size = _write(out / folder / f"{profile.default_base_namespace}.json", whole)
    overview = graph.schema_modules(whole["linkml"], whole["extraction"])
    modules = []
    for module in overview:
        package = module["package"]
        snapshot = get_snapshot(profile, package)
        state = core.edited(profile, snapshot, package)
        size += _write(out / folder / f"{package}.json", snapshot)
        # The roots of the module's own snapshot (what `/roots` answers), not the whole profile's.
        sections = sorted(core.section_names(state, package))
        ready = {}
        for root in first_roots(profile, package, sections) if graphs else ():
            path = f"graphs/{profile.key}/{package}/{root}.json"
            size += _write(out / path, core.build_graph(state, package, root=root, base_namespace=profile.default_base_namespace))
            ready[root] = path
        modules.append({"package": package, "sections": sections, "snapshot": f"{folder}/{package}.json", "graphs": ready})
    _log(f"{profile.key}: {len(modules)} modules, {size / 1e6:.1f} MB, {time.monotonic() - started:.0f} s")
    return {
        "key": profile.key,
        "label": profile.label,
        "default_branch": profile.default_branch,
        "default_package": profile.default_package,
        "default_base_namespace": profile.default_base_namespace,
        "default_root": profile.default_root,
        "version": info.version,
        "source": info.source,
        "package_version": info.package_version,
        "commit": core.snapshot_commit(whole),
        "capabilities": sorted(profile.capabilities),
        "edit_rule_set": profile.edit_rules,
        "edit_rules": edits.rules_summary(profile.edit_rules),
        "snapshot": f"{folder}/{profile.default_base_namespace}.json",
        # What `/git/packages` and `/overview` list: modules with roots in the whole profile's schema.
        "overview": overview,
        "modules": modules,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, required=True, help="folder to write into (created if missing)")
    parser.add_argument("--profile", action="append", help="only this profile (repeatable; default: all)")
    parser.add_argument("--graphs", action="store_true", help="also write the first graph of each module")
    args = parser.parse_args(argv)

    profiles = [profile for profile in list_schema_profiles() if supports_linkml(profile)]
    if args.profile:
        unknown = set(args.profile) - {profile.key for profile in profiles}
        if unknown:
            parser.error(f"unknown profile(s): {', '.join(sorted(unknown))}")
        profiles = [profile for profile in profiles if profile.key in args.profile]

    entries = [build_profile(profile, args.out, graphs=args.graphs) for profile in profiles]
    index = {
        "format": INDEX_FORMAT,
        "static": True,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "profiles": entries,
    }
    _write(args.out / "index.json", index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

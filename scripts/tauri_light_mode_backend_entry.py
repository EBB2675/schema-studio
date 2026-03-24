from __future__ import annotations

import os
from pathlib import Path
import sys


def _ensure_headless_stdio() -> None:
    if sys.stdin is None:
        sys.stdin = open(os.devnull, "r", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _configure_frozen_dist() -> None:
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return
    os.environ.setdefault("SCHEMA_STUDIO_PACKAGED_BACKEND", "1")
    os.environ.setdefault("SCHEMA_STUDIO_HEADLESS", "1")
    dist_dir = Path(meipass) / "light_mode_static"
    if dist_dir.exists():
        os.environ.setdefault("SCHEMA_STUDIO_DIST_DIR", str(dist_dir))


def main() -> None:
    _ensure_headless_stdio()
    _configure_frozen_dist()
    from api.light_mode.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()

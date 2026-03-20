from __future__ import annotations

import os
from pathlib import Path
import sys


def _configure_frozen_dist() -> None:
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return
    dist_dir = Path(meipass) / "light_mode_static"
    if dist_dir.exists():
        os.environ.setdefault("SCHEMA_STUDIO_DIST_DIR", str(dist_dir))


def main() -> None:
    _configure_frozen_dist()
    from api.light_mode.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()

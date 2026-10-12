"""Where Schema Studio keeps its local data (caches of schema reads)."""
from __future__ import annotations

import os
from pathlib import Path

try:
    from platformdirs import user_config_dir
except ImportError:  # pragma: no cover - platformdirs is tiny; fallback to home

    def user_config_dir(appname: str, appauthor: str | None = None) -> str:
        base = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
        return str(base / (appauthor or appname) / appname)


DEFAULT_APP_NAME = "schema_studio"


def config_root() -> Path:
    """`SCHEMA_STUDIO_HOME`, else the user config folder, else `./.schema_studio`."""
    env_root = os.getenv("SCHEMA_STUDIO_HOME")
    if env_root:
        return Path(env_root)
    preferred = Path(user_config_dir(DEFAULT_APP_NAME))
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return preferred
    except Exception:
        fallback = Path.cwd() / ".schema_studio"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback

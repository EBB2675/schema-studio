"""Build-time cache location for generated schema snapshots."""
import os
from pathlib import Path
from platformdirs import user_cache_dir


def config_root() -> Path:
    return Path(os.environ.get("SCHEMA_STUDIO_HOME") or user_cache_dir("schema_studio"))

"""CLI entrypoint for Schema Studio Light Mode."""
from __future__ import annotations

import os
from pathlib import Path
import threading
import time
from urllib.request import urlopen
import webbrowser

import uvicorn


def _strip_wrapping_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _load_env_fallback(path: Path) -> bool:
    """Minimal .env loader used when python-dotenv is unavailable."""
    loaded_any = False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = _strip_wrapping_quotes(value)
        loaded_any = True
    return loaded_any


def _load_env_file(path: Path) -> bool:
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return _load_env_fallback(path)
    return bool(load_dotenv(dotenv_path=path, override=False))


def _candidate_env_files() -> list[Path]:
    candidates: list[Path] = []

    explicit = os.getenv("SCHEMA_STUDIO_ENV_FILE")
    if explicit:
        candidates.append(Path(explicit).expanduser())

    candidates.append(Path.cwd() / ".env")
    candidates.append(Path(__file__).resolve().parents[2] / ".env")

    unique: list[Path] = []
    seen: set[str] = set()
    for p in candidates:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def _load_first_available_env() -> Path | None:
    for env_path in _candidate_env_files():
        if not env_path.is_file():
            continue
        if _load_env_file(env_path):
            return env_path
    return None


def _banner(profile_key: str, branch: str) -> str:
    return (
        "Running in Light Mode (local, single-user, non-production; "
        f"schema profile={profile_key}, branch={branch})"
    )


def _open_browser_when_ready(url: str, timeout_seconds: float = 120.0) -> None:
    """
    Wait for the app to be reachable before opening a browser tab.
    This avoids the initial "page not found" race on startup.
    """
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urlopen(f"{url}/health", timeout=1.0) as resp:
                if 200 <= getattr(resp, "status", 500) < 500:
                    webbrowser.open(url)
                    return
        except Exception:
            time.sleep(0.2)
    webbrowser.open(url)


def main() -> None:
    loaded_env = _load_first_available_env()

    # Import after loading .env so app defaults resolve from environment when present.
    from .app import app, DEFAULT_HOST, DEFAULT_PORT
    from .schema_source import active_profile

    profile = active_profile()
    url = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"

    if loaded_env is not None:
        print(f"Loaded environment from {loaded_env}")
    print(_banner(profile.key, profile.default_branch))
    print(f"Launching browser at {url} when server is ready\n")
    threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()

    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT, log_level=os.getenv("UVICORN_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()

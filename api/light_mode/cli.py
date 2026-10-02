"""CLI entrypoint for Schema Studio Light Mode."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import sys
import threading
import time
from urllib.request import urlopen
import webbrowser

import uvicorn


def _strip_wrapping_quotes(value: str) -> str:
    """Remove one matching pair of leading/trailing quotes from an env value."""
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
    """Load a dotenv file with python-dotenv when available, else use fallback parser."""
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return _load_env_fallback(path)
    return bool(load_dotenv(dotenv_path=path, override=False))


def _candidate_env_files() -> list[Path]:
    """Return candidate `.env` files in precedence order, de-duplicated."""
    candidates: list[Path] = []

    explicit = os.getenv("SCHEMA_STUDIO_ENV_FILE")
    if explicit:
        candidates.append(Path(explicit).expanduser())

    candidates.append(Path.cwd() / ".env")
    candidates.append(Path(__file__).resolve().parents[2] / ".env")

    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def _load_first_available_env() -> Path | None:
    """Load the first existing env file that sets at least one variable."""
    for env_path in _candidate_env_files():
        if not env_path.is_file():
            continue
        if _load_env_file(env_path):
            return env_path
    return None


def _banner(profile_key: str, branch: str) -> str:
    """Build a startup banner describing active light-mode schema profile settings."""
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


def _env_flag(name: str, default: bool) -> bool:
    """Read a boolean-like environment variable with a default fallback."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _watch_parent_process() -> None:
    """Exit when the desktop parent process disappears."""
    raw_pid = os.getenv("SCHEMA_STUDIO_PARENT_PID", "").strip()
    if not raw_pid:
        return

    try:
        parent_pid = int(raw_pid)
    except ValueError:
        return

    if parent_pid <= 0:
        return

    def _watch_windows() -> None:
        synchronize = 0x00100000
        wait_object_0 = 0x00000000

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.OpenProcess(synchronize, False, parent_pid)
        if not handle:
            return
        try:
            result = kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
            if result == wait_object_0:
                os._exit(0)
        finally:
            kernel32.CloseHandle(handle)

    def _watch_posix() -> None:
        while True:
            try:
                os.kill(parent_pid, 0)
            except OSError:
                os._exit(0)
            time.sleep(1.0)

    target = _watch_windows if os.name == "nt" else _watch_posix
    threading.Thread(target=target, daemon=True).start()


def run_server(*, open_browser: bool | None = None) -> None:
    """Run the light-mode API server with environment-aware defaults."""
    loaded_env = _load_first_available_env()

    # Import after loading .env so app defaults resolve from environment when present.
    from .app import app, DEFAULT_HOST, DEFAULT_PORT
    from .schema_source import active_profile

    profile = active_profile()
    url = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"

    if loaded_env is not None:
        print(f"Loaded environment from {loaded_env}")
    print(_banner(profile.key, profile.default_branch))

    _watch_parent_process()
    if open_browser is None:
        open_browser = _env_flag("SCHEMA_STUDIO_OPEN_BROWSER", True)
    if open_browser:
        print(f"Launching browser at {url} when server is ready\n")
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()
    else:
        print(f"Browser auto-open disabled; server available at {url}\n")

    use_colors = sys.stdout is not None and sys.stderr is not None and not _env_flag("SCHEMA_STUDIO_HEADLESS", False)
    uvicorn.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        log_level=os.getenv("UVICORN_LOG_LEVEL", "info"),
        use_colors=use_colors,
    )


def main() -> None:
    """Run the light-mode API server with default browser behavior."""
    run_server()


if __name__ == "__main__":
    main()

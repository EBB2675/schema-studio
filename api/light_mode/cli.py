"""CLI entrypoint for Schema Studio Light Mode."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import threading
import time
from urllib.request import urlopen
import webbrowser

import uvicorn

from .app import app, DEFAULT_HOST, DEFAULT_PORT

BANNER = "Running in Light Mode (local, single-user, non-production; schema pinned to nomad-simulations/develop)"


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
    # Fallback: open anyway if readiness check timed out.
    webbrowser.open(url)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _watch_parent_process() -> None:
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
        SYNCHRONIZE = 0x00100000
        WAIT_OBJECT_0 = 0x00000000

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if not handle:
            return
        try:
            result = kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
            if result == WAIT_OBJECT_0:
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
    url = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"
    print(BANNER)
    _watch_parent_process()
    if open_browser is None:
        open_browser = _env_flag("SCHEMA_STUDIO_OPEN_BROWSER", True)
    if open_browser:
        print(f"Launching browser at {url} when server is ready\n")
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()
    else:
        print(f"Browser auto-open disabled; server available at {url}\n")

    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT, log_level=os.getenv("UVICORN_LOG_LEVEL", "info"))


def main() -> None:
    run_server()


if __name__ == "__main__":
    main()

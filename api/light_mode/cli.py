"""CLI entrypoint for Schema Studio Light Mode."""
from __future__ import annotations

import os
import webbrowser
import uvicorn

from .app import app, DEFAULT_HOST, DEFAULT_PORT

BANNER = "Running in Light Mode (local, single-user, non-production)"


def main() -> None:
    url = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"
    print(BANNER)
    print(f"Launching browser at {url}\n")
    try:
        webbrowser.open(url)
    except Exception:
        print("(Could not open browser automatically; open the URL manually.)")

    uvicorn.run(app, host=DEFAULT_HOST, port=DEFAULT_PORT, log_level=os.getenv("UVICORN_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()

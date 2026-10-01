"""Run an extractor script with the interpreter of a schema environment.

Adapted from schematerial `src/schematerial/extraction/runner.py` at commit
df3839b. Differences: no contract validation here (the caller decides what the
JSON means), the failed process output is kept on the exception, and the
interpreter path is resolved for both POSIX and Windows virtual environments.

The app never imports schema packages. It starts a script from
`extractor/scripts/` with the Python of `environments/<profile>/` in isolated
mode and reads one JSON document from stdout. Nothing here installs packages or
falls back to the app's own interpreter.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ExtractorEnvironment:
    """A schema environment: a name for messages and the folder of its uv project."""

    name: str
    directory: Path

    @property
    def python(self) -> Path:
        venv = self.directory / ".venv"
        windows = venv / "Scripts" / "python.exe"
        return windows if windows.is_file() else venv / "bin" / "python"


class ExtractorError(RuntimeError):
    """An extractor script could not be started or did not complete successfully."""

    def __init__(self, message: str, *, stdout: str = "", stderr: str = "", returncode: int | None = None):
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class EnvironmentMissing(ExtractorError):
    """The schema environment has not been created yet."""


def run_script(
    environment: ExtractorEnvironment,
    script: Path,
    *,
    arguments: tuple[str, ...] = (),
    timeout: float = 300,
) -> Any:
    """Return the JSON document the script printed; stderr is diagnostics only.

    Isolated mode (`-I`) ignores PYTHONPATH and user site packages and keeps the
    script's own folder off the import path.
    """
    python = environment.python.absolute()
    if not python.is_file():
        raise EnvironmentMissing(
            f"The schema environment {environment.name!r} is not set up: {python} does not exist."
        )
    script = script.absolute()
    if not script.is_file():
        raise ExtractorError(f"Extractor script does not exist: {script}")
    if timeout <= 0:
        raise ValueError("Extractor timeout must be positive")
    try:
        result = subprocess.run(
            [str(python), "-I", str(script), *arguments],
            capture_output=True, text=True, encoding="utf-8",
            timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ExtractorError(
            f"Schema environment {environment.name!r}: timed out after {timeout}s"
        ) from error
    except OSError as error:
        raise ExtractorError(
            f"Schema environment {environment.name!r}: cannot execute {python}: {error}"
        ) from error
    if result.returncode:
        raise ExtractorError(
            f"Schema environment {environment.name!r}: exit {result.returncode}; {result.stderr.strip()}",
            stdout=result.stdout, stderr=result.stderr, returncode=result.returncode,
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ExtractorError(
            f"Schema environment {environment.name!r}: script did not print valid JSON: {error}",
            stdout=result.stdout, stderr=result.stderr, returncode=result.returncode,
        ) from error

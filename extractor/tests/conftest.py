from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def fake_environment(tmp_path: Path):
    """
    An environment folder whose interpreter is the one running the tests.
    It lets the runner and the scripts be tested without any schema package.
    """
    from extractor.runner import ExtractorEnvironment

    if os.name == "nt":
        pytest.skip("needs a symlinked interpreter")
    directory = tmp_path / "environments" / "fake"
    (directory / ".venv" / "bin").mkdir(parents=True)
    (directory / ".venv" / "bin" / "python").symlink_to(sys.executable)
    return ExtractorEnvironment(name="fake", directory=directory)

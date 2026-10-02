from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

FIXTURES = PROJECT_ROOT / "extractor" / "tests" / "fixtures"


def load_fixture(profile: str) -> dict:
    """A stored extraction document (see extractor/tests/fixtures/regenerate.py)."""
    return json.loads((FIXTURES / f"{profile}.json").read_text(encoding="utf-8"))


@pytest.fixture()
def studio_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "studio-home"
    monkeypatch.setenv("SCHEMA_STUDIO_HOME", str(home))
    return home

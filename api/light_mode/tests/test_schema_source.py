from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def schema_source_module(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SCHEMA_STUDIO_PACKAGED_BACKEND", raising=False)
    monkeypatch.delenv("SCHEMA_STUDIO_SCHEMA_VERSION", raising=False)
    import api.light_mode.schema_source as schema_source

    return importlib.reload(schema_source)


def test_packaged_backend_uses_bundled_schema_without_distribution_metadata(
    schema_source_module, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    package_root = tmp_path / "nomad_simulations"
    package_root.mkdir()

    monkeypatch.setenv("SCHEMA_STUDIO_PACKAGED_BACKEND", "1")
    monkeypatch.setenv("SCHEMA_STUDIO_SCHEMA_VERSION", "2026.03-bundled")
    monkeypatch.setattr(
        schema_source_module.importlib.util,
        "find_spec",
        lambda _name: SimpleNamespace(submodule_search_locations=[str(package_root)], origin=None),
    )

    def missing_distribution(_name: str):
        raise schema_source_module.importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(schema_source_module.importlib.metadata, "distribution", missing_distribution)

    info = schema_source_module.current_schema_info()

    assert info.package_root == package_root.resolve()
    assert info.version == "2026.03-bundled"
    assert info.source == "bundled"


def test_packaged_backend_rejects_runtime_schema_update(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SCHEMA_STUDIO_PACKAGED_BACKEND", "1")

    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module.update_schema()

    assert "disabled in the packaged desktop build" in str(exc.value)

from __future__ import annotations

from pathlib import Path
import importlib
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _reload_settings(monkeypatch, **env):
    """Reload `api.settings` with a clean, test-specific environment."""
    keys = {
        "SCHEMA_UML_REPO",
        "NOMAD_SIM_REPO",
        "GIT_REPO_DIR",
        "NOMAD_MEASURE_REPO",
        "BAM_MASTERDATA_REPO",
        "SCHEMA_UML_REPO_MAP",
        "SCHEMA_UML_BASE_PACKAGE",
        "SCHEMA_UML_PACKAGE",
    }
    for key in keys:
        monkeypatch.delenv(key, raising=False)

    for key, value in env.items():
        monkeypatch.setenv(key, value)

    sys.modules.pop("api.settings", None)
    import api.settings as settings_mod

    return importlib.reload(settings_mod)


def test_bam_repo_is_selected_by_namespace(monkeypatch, tmp_path: Path):
    """BAM namespaces should resolve to BAM repo when configured."""
    default_repo = tmp_path / "default"
    bam_repo = tmp_path / "bam"

    mod = _reload_settings(
        monkeypatch,
        SCHEMA_UML_REPO=str(default_repo),
        BAM_MASTERDATA_REPO=str(bam_repo),
    )

    assert mod.repo_for_base_namespace("bam_masterdata.datamodel") == str(bam_repo)
    assert mod.repo_for_base_namespace("bam_masterdata.datamodel.object_types") == str(bam_repo)
    assert mod.repo_for_base_namespace("nomad_simulations.schema_packages") == str(default_repo)


def test_repo_map_overrides_default_namespace_mapping(monkeypatch, tmp_path: Path):
    """Explicit namespace mappings should override built-in repo defaults."""
    default_repo = tmp_path / "default"
    bam_repo = tmp_path / "bam"
    mapped_repo = tmp_path / "mapped"

    mod = _reload_settings(
        monkeypatch,
        SCHEMA_UML_REPO=str(default_repo),
        BAM_MASTERDATA_REPO=str(bam_repo),
        SCHEMA_UML_REPO_MAP=f"bam_masterdata.datamodel={mapped_repo}",
    )

    assert mod.repo_for_base_namespace("bam_masterdata.datamodel") == str(mapped_repo)
    assert mod.repo_for_base_namespace("bam_masterdata.datamodel.vocabulary_types") == str(mapped_repo)


def test_default_package_for_bam_namespace(monkeypatch, tmp_path: Path):
    """BAM base namespace should default to the object types module."""
    default_repo = tmp_path / "default"

    mod = _reload_settings(
        monkeypatch,
        SCHEMA_UML_REPO=str(default_repo),
        SCHEMA_UML_BASE_PACKAGE="bam_masterdata.datamodel",
    )

    assert mod.DEFAULT_PACKAGE == "bam_masterdata.datamodel.object_types"

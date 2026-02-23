from __future__ import annotations

import importlib
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _reload_schema_source(monkeypatch, *, profile: str | None = None, package_hint: str | None = None):
    """Reload schema-source module with controlled profile env vars."""
    monkeypatch.delenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", raising=False)
    monkeypatch.delenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", raising=False)

    if profile is not None:
        monkeypatch.setenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", profile)
    if package_hint is not None:
        monkeypatch.setenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", package_hint)

    sys.modules.pop("api.light_mode.schema_source", None)
    import api.light_mode.schema_source as mod

    return importlib.reload(mod)


def test_default_profile_is_nomad(monkeypatch):
    """Without overrides, light mode should select NOMAD defaults."""
    mod = _reload_schema_source(monkeypatch)

    assert mod.LIGHT_PROFILE_KEY == "nomad"
    assert mod.DEFAULT_BRANCH == "develop"
    assert mod.DEFAULT_PACKAGE == "nomad_simulations.schema_packages.model_method"
    assert mod.DEFAULT_BASE_NAMESPACE == "nomad_simulations.schema_packages"


def test_explicit_bam_profile(monkeypatch):
    """Explicit BAM profile should switch branch/package defaults."""
    mod = _reload_schema_source(monkeypatch, profile="bam")

    assert mod.LIGHT_PROFILE_KEY == "bam"
    assert mod.DEFAULT_BRANCH == "main"
    assert mod.DEFAULT_PACKAGE == "bam_masterdata.datamodel.object_types"
    assert mod.DEFAULT_BASE_NAMESPACE == "bam_masterdata.datamodel"
    assert mod.UPGRADE_TARGET.endswith("bam-masterdata.git@main")


def test_package_hint_selects_bam_profile(monkeypatch):
    """A BAM package hint should auto-select BAM profile when key is unset."""
    mod = _reload_schema_source(monkeypatch, package_hint="bam_masterdata.datamodel.vocabulary_types")

    assert mod.LIGHT_PROFILE_KEY == "bam"
    assert mod.PACKAGE_IMPORT == "bam_masterdata"
    assert mod.PACKAGE_DIST == "bam-masterdata"

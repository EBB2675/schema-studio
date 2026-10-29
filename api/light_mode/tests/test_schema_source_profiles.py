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


def test_default_profile_is_nomad_simulations(monkeypatch):
    """Without overrides, light mode should select nomad-simulations defaults."""
    mod = _reload_schema_source(monkeypatch)

    assert mod.LIGHT_PROFILE_KEY == "nomad-simulations"
    assert mod.DEFAULT_BRANCH == "develop"
    assert mod.DEFAULT_PACKAGE == "nomad_simulations.schema_packages.model_method"
    assert mod.DEFAULT_BASE_NAMESPACE == "nomad_simulations.schema_packages"
    assert mod.DEFAULT_ROOT == "ModelMethod"


def test_explicit_bam_profile(monkeypatch):
    """Explicit BAM profile should switch branch/package defaults."""
    mod = _reload_schema_source(monkeypatch, profile="bam-masterdata-v0")

    assert mod.LIGHT_PROFILE_KEY == "bam-masterdata-v0"
    assert mod.DEFAULT_BRANCH == "main"
    assert mod.DEFAULT_PACKAGE == "bam_masterdata.datamodel.v0.object_types"
    assert mod.DEFAULT_BASE_NAMESPACE == "bam_masterdata.datamodel.v0"
    assert mod.DEFAULT_ROOT == "SearchQuery"
    assert mod.UPGRADE_TARGET.endswith("bam-masterdata.git@main")


def test_bam_v1_profile_reads_the_same_environment(monkeypatch):
    mod = _reload_schema_source(monkeypatch, profile="bam-masterdata-v1")

    assert mod.DEFAULT_PACKAGE == "bam_masterdata.datamodel.v1.base_objects"
    assert mod.DEFAULT_BASE_NAMESPACE == "bam_masterdata.datamodel.v1"
    assert mod.DEFAULT_ROOT == "Root"
    v0, v1 = mod.SCHEMA_PROFILES["bam-masterdata-v0"], mod.SCHEMA_PROFILES["bam-masterdata-v1"]
    assert v0.environment == v1.environment
    assert v1.environment.directory.name == "bam-masterdata"


def test_package_hint_selects_bam_profile(monkeypatch):
    """A BAM package hint should auto-select BAM profile when key is unset."""
    mod = _reload_schema_source(monkeypatch, package_hint="bam_masterdata.datamodel.v0.vocabulary_types")

    assert mod.LIGHT_PROFILE_KEY == "bam-masterdata-v0"
    assert mod.PACKAGE_IMPORT == "bam_masterdata"
    assert mod.PACKAGE_DIST == "bam-masterdata"


def test_profile_can_be_inferred_from_package(monkeypatch):
    mod = _reload_schema_source(monkeypatch)

    nomad = mod.schema_profile_for_package("nomad_simulations.schema_packages.model_method")
    measurements = mod.schema_profile_for_package("nomad_measurements.xrd.schema")
    bam = mod.schema_profile_for_package("bam_masterdata.datamodel.v0.object_types")

    assert nomad.key == "nomad-simulations"
    assert measurements.key == "nomad-measurements"
    assert bam.key == "bam-masterdata-v0"
    # Each datamodel version is its own profile; the package alone names the first one.
    assert mod.schema_profile_for_package("bam_masterdata.datamodel.v1.base_objects").key == "bam-masterdata-v1"
    assert mod.schema_profile_for_package(None, "bam_masterdata.datamodel.v1").key == "bam-masterdata-v1"
    assert mod.schema_profile_for_package("bam_masterdata").key == "bam-masterdata-v0"


def test_explicit_measurements_profile(monkeypatch):
    """The nomad-measurements profile tracks main and starts at the XRD schema."""
    mod = _reload_schema_source(monkeypatch, profile="nomad-measurements")

    assert mod.LIGHT_PROFILE_KEY == "nomad-measurements"
    assert mod.DEFAULT_BRANCH == "main"
    assert mod.DEFAULT_PACKAGE == "nomad_measurements.xrd.schema"
    assert mod.DEFAULT_BASE_NAMESPACE == "nomad_measurements"
    assert mod.DEFAULT_ROOT == "ELNXRayDiffraction"


def test_profiles_are_listed_in_display_order_with_their_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("SCHEMA_STUDIO_ENVIRONMENTS_DIR", str(tmp_path))
    mod = _reload_schema_source(monkeypatch)

    profiles = mod.list_schema_profiles()
    assert [p.key for p in profiles] == ["nomad-simulations", "nomad-measurements", "bam-masterdata-v0", "bam-masterdata-v1"]
    for profile in profiles:
        assert profile.environment.directory == tmp_path / (profile.environment_key or profile.key)
        assert not mod.schema_available(profile)


def test_profile_can_be_resolved_by_package_name(monkeypatch):
    mod = _reload_schema_source(monkeypatch)

    assert mod.schema_profile_for_key("nomad_measurements").key == "nomad-measurements"
    assert mod.schema_profile_for_key("BAM-masterdata").key == "bam-masterdata-v0"
    assert mod.schema_profile_for_key("bam-masterdata-V1").key == "bam-masterdata-v1"

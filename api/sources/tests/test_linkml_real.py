"""LinkML export from the real profile environments.

Slow, and the environments must be set up first, so these are deselected by default:

    uv sync --project environments/<profile>
    pytest -m slow api/sources/tests/test_linkml_real.py
"""
from __future__ import annotations

import pytest
from linkml_runtime.utils.schemaview import SchemaView

pytestmark = pytest.mark.slow

MODULES = {
    "nomad-simulations": ["nomad_simulations.schema_packages.model_method", "nomad_simulations.schema_packages.general"],
    "nomad-measurements": ["nomad_measurements.xrd.schema", "nomad_measurements.general"],
    "bam-masterdata": ["bam_masterdata.datamodel.object_types", "bam_masterdata.datamodel.creep_test.object_types"],
}


@pytest.mark.parametrize("key,module", [(key, module) for key, modules in MODULES.items() for module in modules])
def test_module_exports_and_loads(key, module, studio_home):
    from api.light_mode.schema_source import SCHEMA_PROFILES, schema_available
    from api.sources.snapshots import get_snapshot, snapshot_yaml

    profile = SCHEMA_PROFILES[key]
    if not schema_available(profile):
        pytest.skip(f"environment for {key} is not set up")
    snapshot = get_snapshot(profile, module)
    text = snapshot_yaml(snapshot)
    assert snapshot_yaml(snapshot) == text
    view = SchemaView(text)
    document = snapshot["extraction"]
    for row in document["classes"]:
        induced = {str(slot.name) for slot in view.class_induced_slots(row["id"])}
        assert induced == {ref["name"] for ref in row["effective_attributes"]}, row["id"]
    assert not [row for row in snapshot["report"] if row["reason"].startswith("inheritance mismatch")]


@pytest.mark.parametrize("key", sorted(MODULES))
def test_whole_profile_converts(key, studio_home):
    from api.light_mode.schema_source import SCHEMA_PROFILES, schema_available
    from api.sources.snapshots import get_snapshot

    profile = SCHEMA_PROFILES[key]
    if not schema_available(profile):
        pytest.skip(f"environment for {key} is not set up")
    snapshot = get_snapshot(profile)
    assert len(snapshot["linkml"]["classes"]) == len(snapshot["extraction"]["classes"])


def test_whole_bam_datamodel_exports_and_loads(studio_home):
    from api.light_mode.schema_source import SCHEMA_PROFILES, schema_available
    from api.sources.snapshots import get_snapshot, snapshot_yaml

    profile = SCHEMA_PROFILES["bam-masterdata"]
    if not schema_available(profile):
        pytest.skip("environment for bam-masterdata is not set up")
    snapshot = get_snapshot(profile)
    view = SchemaView(snapshot_yaml(snapshot))
    assert len(view.all_classes()) == len(snapshot["extraction"]["classes"])
    assert len(view.all_enums()) == len(snapshot["extraction"]["enums"])
    assert not [row for row in snapshot["report"] if row["reason"].startswith("inheritance mismatch")]

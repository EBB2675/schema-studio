"""The LinkML path gives the same graphs, roots and usage info as the legacy path.

Both run in the same profile environment, so they read the same schema commit.
Slow, and the environments must be set up first, so these are deselected by default:

    uv sync --project environments/<profile>
    pytest -m slow api/sources/tests/test_graph_regression.py

Explained differences are taken out before comparing, each by its own rule
below; anything else fails the test. They are: undocumented quantities get no
description (legacy shows NOMAD's generic Quantity docstring); a blank
docstring gives no description; metainfo categories are not sections; and the
legacy builder misses the quantities of a few nomad-lab classes.
"""
from __future__ import annotations

import copy

import pytest

pytestmark = pytest.mark.slow

PACKAGES = {
    "nomad-simulations": [
        "nomad_simulations.schema_packages.model_method",
        "nomad_simulations.schema_packages.general",
        "nomad_simulations.schema_packages.outputs",
    ],
    "nomad-measurements": [
        "nomad_measurements.xrd.schema",
        "nomad_measurements.transmission.schema",
        "nomad_measurements.general",
    ],
}
ROOTS = {
    "nomad-simulations": ("nomad_simulations.schema_packages.model_method", "ModelMethod"),
    "nomad-measurements": ("nomad_measurements.xrd.schema", "ELNXRayDiffraction"),
}
FLAGS = [
    {},
    {"allow_cross_module": False},
    {"include_quantities": False, "include_inheritance": False},
]

# The legacy graph builder looks for a class attribute called `quantities`
# before NOMAD's definitions. These nomad-lab classes have one that is not the
# list of quantity definitions (a plain list of names, or a quantity that is
# itself called `quantities`), so the legacy graph shows them without quantities.
LEGACY_QUANTITIES_MISREAD = {
    "nomad.datamodel.datamodel.EntryMetadata",
    "nomad.datamodel.metainfo.simulation.method.CoreHole",
    "nomad.datamodel.metainfo.simulation.method.SingleElectronState",
    "nomad.datamodel.results.CoreHole",
}
GENERIC_QUANTITY_DOC = "To define quantities, instantiate :class:`Quantity`"


@pytest.fixture(scope="module")
def studio_home(tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        home = tmp_path_factory.mktemp("studio-home")
        patch.setenv("SCHEMA_STUDIO_HOME", str(home))
        yield home


def available(key):
    from api.light_mode.schema_source import SCHEMA_PROFILES, schema_available

    profile = SCHEMA_PROFILES[key]
    if not schema_available(profile):
        pytest.skip(f"environment for {key} is not set up")
    return profile


def skipped_classes(document, legacy_graph):
    """Classes the extraction skips (metainfo categories), and bases only reached through them."""
    classes = {record["id"] for record in document["classes"]}
    skipped = {row["path"] for row in document["report"] if row["reason"].startswith("not a section")}
    changed = True
    while changed:
        changed = False
        for edge in legacy_graph["edges"]:
            if edge["type"] == "inherits" and edge["source"] in skipped and edge["target"] not in classes | skipped:
                skipped.add(edge["target"])
                changed = True
    return skipped


def explained(legacy_graph, linkml_graph, document):
    """Both graphs with the explained differences taken out."""
    legacy_graph, linkml_graph = copy.deepcopy(legacy_graph), copy.deepcopy(linkml_graph)
    skipped = skipped_classes(document, legacy_graph)
    legacy_graph["nodes"] = [node for node in legacy_graph["nodes"] if node["id"] not in skipped]
    legacy_graph["edges"] = [
        edge for edge in legacy_graph["edges"] if edge["source"] not in skipped and edge["target"] not in skipped
    ]
    for node in legacy_graph["nodes"]:
        if node["kind"] == "quantity":
            assert node["owner"] not in LEGACY_QUANTITIES_MISREAD, f"{node['owner']} has quantities in legacy now"
        if node["doc"] == "" or (node["kind"] == "quantity" and (node["doc"] or "").startswith(GENERIC_QUANTITY_DOC)):
            node["doc"] = None
    misread = {
        node["id"] for node in linkml_graph["nodes"]
        if node["kind"] == "quantity" and node["owner"] in LEGACY_QUANTITIES_MISREAD
    }
    linkml_graph["nodes"] = [node for node in linkml_graph["nodes"] if node["id"] not in misread]
    linkml_graph["edges"] = [edge for edge in linkml_graph["edges"] if edge["target"] not in misread]
    for node in linkml_graph["nodes"]:
        node.pop("unit", None)
    return legacy_graph, linkml_graph


CASES = [
    (key, package, flags) for key, packages in PACKAGES.items() for package in packages for flags in FLAGS
] + [
    (key, package, {"root": root, **flags}) for key, (package, root) in ROOTS.items() for flags in FLAGS
]


@pytest.mark.parametrize("key,package,flags", CASES, ids=lambda value: str(value))
def test_graph_is_unchanged(key, package, flags, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    profile = available(key)
    flags = {"base_namespace": profile.default_base_namespace, **flags}
    snapshot = get_snapshot(profile, package)
    expected, result = explained(
        legacy.build_graph(package, **flags),
        graph.build_graph(snapshot["linkml"], snapshot["extraction"], package, **flags),
        snapshot["extraction"],
    )
    assert result["nodes"] == expected["nodes"]
    assert result["edges"] == expected["edges"]
    assert result == expected


@pytest.mark.parametrize("key,package", [(key, package) for key, packages in PACKAGES.items() for package in packages])
def test_roots_are_unchanged(key, package, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    snapshot = get_snapshot(available(key), package)
    skipped = {path.rpartition(".")[2] for path in skipped_classes(snapshot["extraction"], {"edges": []})}
    expected = [name for name in legacy.list_sections(package) if name not in skipped]
    assert graph.section_names(snapshot["linkml"], snapshot["extraction"], package) == expected


@pytest.mark.parametrize("key", sorted(PACKAGES))
def test_module_list_is_unchanged(key, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    profile = available(key)
    snapshot = get_snapshot(profile)
    skipped = {path.rpartition(".")[2] for path in skipped_classes(snapshot["extraction"], {"edges": []})}
    expected = []
    for module in legacy.list_schema_modules(profile.default_base_namespace):
        sections = [name for name in module["sections"] if name not in skipped]
        if sections:
            expected.append({"package": module["package"], "sections": sections})
    found = graph.schema_modules(snapshot["linkml"], snapshot["extraction"])
    assert sorted(found, key=lambda module: module["package"]) == sorted(expected, key=lambda module: module["package"])


@pytest.mark.parametrize("key", sorted(ROOTS))
def test_usage_is_unchanged(key, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    profile = available(key)
    package, root = ROOTS[key]
    snapshot = get_snapshot(profile, package)
    shown = graph.build_graph(snapshot["linkml"], snapshot["extraction"], package, root=root,
                              base_namespace=profile.default_base_namespace)
    # Nodes are sorted by module, so nomad-lab base sections come first.
    sections = [node["id"] for node in shown["nodes"] if node["kind"] == "section"][:15]
    for section_id in sections:
        expected = [entry.__dict__ for entry in legacy.get_usage_for_section(section_id)]
        assert graph.usage_entries(snapshot["extraction"], section_id) == expected, section_id

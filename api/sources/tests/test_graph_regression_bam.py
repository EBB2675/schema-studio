"""bam-masterdata: the LinkML path gives the same graphs, roots and module list as the legacy path.

Both run in the same profile environment, so they read the same schema commit.
Slow, and the environment must be set up first, so these are deselected by default:

    uv sync --project environments/bam-masterdata
    pytest -m slow api/sources/tests/test_graph_regression_bam.py

Explained differences are taken out before comparing, each by its own rule
below; anything else fails the test. They are: a description written as
`English//Deutsch` shows its English half, the German half moves to `doc_de`;
a property or vocabulary term without a description of its own gets none
(legacy shows the docstring of bam-masterdata's definition class); and nodes
carry the openBIS facts the doc panel shows.
"""
from __future__ import annotations

import copy

import pytest

pytestmark = pytest.mark.slow

KEY = "bam-masterdata"
PACKAGES = [
    "bam_masterdata.datamodel.object_types",
    "bam_masterdata.datamodel.vocabulary_types",
    "bam_masterdata.datamodel.instruments",
    "bam_masterdata.datamodel.creep_test.object_types",
    "bam_masterdata.datamodel.collection_types",
]
ROOTS = [
    ("bam_masterdata.datamodel.object_types", "SearchQuery"),
    ("bam_masterdata.datamodel.object_types", "Amorphous"),
    ("bam_masterdata.datamodel.instruments", "Thermocouple"),
]
FLAGS = [
    {},
    {"allow_cross_module": False},
    {"include_quantities": False, "include_inheritance": False},
]
# Fields the LinkML path adds to nodes (the legacy graph has none of them).
ADDED_FIELDS = ("unit", "code", "title", "title_de", "doc_de", "mandatory", "section", "iri")
# Docstrings of bam-masterdata's PropertyTypeAssignment and VocabularyTerm classes.
GENERIC_DOCS = ("Base class used to define properties inside", "Base class used to define terms inside")


@pytest.fixture(scope="module")
def studio_home(tmp_path_factory):
    with pytest.MonkeyPatch.context() as patch:
        home = tmp_path_factory.mktemp("studio-home")
        patch.setenv("SCHEMA_STUDIO_HOME", str(home))
        yield home


def available():
    from api.light_mode.schema_source import SCHEMA_PROFILES, schema_available

    profile = SCHEMA_PROFILES[KEY]
    if not schema_available(profile):
        pytest.skip(f"environment for {KEY} is not set up")
    return profile


def explained(legacy_graph, linkml_graph):
    """Both graphs with the explained differences taken out."""
    from api.sources.to_linkml.bam import split_bilingual
    from api.sources.to_linkml.common import Report

    legacy_graph, linkml_graph = copy.deepcopy(legacy_graph), copy.deepcopy(linkml_graph)
    german = {node["id"]: node.get("doc_de") for node in linkml_graph["nodes"]}
    for node in legacy_graph["nodes"]:
        doc = node["doc"]
        if node["kind"] == "quantity" and (doc or "").startswith(GENERIC_DOCS):
            node["doc"] = None
            continue
        english, deutsch = split_bilingual(doc, node["id"], "description", Report())
        if deutsch is not None:
            assert german.get(node["id"]) == deutsch, node["id"]
            node["doc"] = english
    for node in linkml_graph["nodes"]:
        for field in ADDED_FIELDS:
            node.pop(field, None)
    return legacy_graph, linkml_graph


CASES = [(package, flags) for package in PACKAGES for flags in FLAGS] + [
    (package, {"root": root, **flags}) for package, root in ROOTS for flags in FLAGS
]


@pytest.mark.parametrize("package,flags", CASES, ids=lambda value: str(value))
def test_graph_is_unchanged(package, flags, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    profile = available()
    flags = {"base_namespace": profile.default_base_namespace, **flags}
    snapshot = get_snapshot(profile, package)
    expected, result = explained(
        legacy.build_graph(package, **flags),
        graph.build_graph(snapshot["linkml"], snapshot["extraction"], package, **flags),
    )
    assert result["nodes"] == expected["nodes"]
    assert result["edges"] == expected["edges"]
    assert result == expected


@pytest.mark.parametrize("package", PACKAGES)
def test_roots_are_unchanged(package, studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    snapshot = get_snapshot(available(), package)
    assert graph.section_names(snapshot["linkml"], snapshot["extraction"], package) == legacy.list_sections(package)


def test_module_list_is_unchanged(studio_home):
    from api.sources import graph, legacy
    from api.sources.snapshots import get_snapshot

    profile = available()
    snapshot = get_snapshot(profile)
    expected = legacy.list_schema_modules(profile.default_base_namespace)
    found = graph.schema_modules(snapshot["linkml"], snapshot["extraction"])
    assert sorted(found, key=lambda module: module["package"]) == sorted(expected, key=lambda module: module["package"])


def test_every_module_builds_through_the_linkml_path(studio_home):
    from api.sources import graph
    from api.sources.snapshots import get_snapshot

    profile = available()
    whole = get_snapshot(profile)
    for module in graph.schema_modules(whole["linkml"], whole["extraction"]):
        snapshot = get_snapshot(profile, module["package"])
        result = graph.build_graph(snapshot["linkml"], snapshot["extraction"], module["package"],
                                   base_namespace=profile.default_base_namespace)
        assert {node["label"] for node in result["nodes"] if node["kind"] == "section"} >= set(module["sections"])


def test_amorphous_shows_inherited_properties_like_its_parent(studio_home):
    """The frontend marks a child's member inherited when the parent has it with the same dtype, shape and card."""
    from api.sources import graph
    from api.sources.snapshots import get_snapshot

    profile = available()
    package = "bam_masterdata.datamodel.object_types"
    snapshot = get_snapshot(profile, package)
    result = graph.build_graph(snapshot["linkml"], snapshot["extraction"], package, root="Amorphous",
                               base_namespace=profile.default_base_namespace)
    by_owner: dict[str, dict[str, tuple]] = {}
    for node in result["nodes"]:
        if node["kind"] == "quantity":
            by_owner.setdefault(node["owner"], {})[node["label"]] = (node["dtype"], node["shape"], node["card"])
    parent = by_owner[f"{package}.MatSimStructure"]
    child = by_owner[f"{package}.Amorphous"]
    assert parent and all(child[name] == shown for name, shown in parent.items())

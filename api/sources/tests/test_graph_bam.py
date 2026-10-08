"""The graph adapter on bam-masterdata, from the stored extraction document of real classes.

`web/tests/fixtures/bam-amorphous-graph.json` is the graph the frontend tests
read for `Amorphous`; it must stay what the adapter builds from the stored
document. After a deliberate change, rewrite it with:

    SCHEMA_STUDIO_WRITE_FIXTURES=1 pytest api/sources/tests/test_graph_bam.py
"""
from __future__ import annotations

import json
import os

import pytest

from api.sources import graph
from api.sources.to_linkml import convert_bam

from .conftest import PROJECT_ROOT, load_fixture

MODULE = "bam_masterdata.datamodel.object_types"
NS = "bam_masterdata.datamodel"
AMORPHOUS = f"{MODULE}.Amorphous"
MAT_SIM = f"{MODULE}.MatSimStructure"
WEB_FIXTURE = PROJECT_ROOT / "web" / "tests" / "fixtures" / "bam-amorphous-graph.json"


@pytest.fixture(scope="module")
def snapshot():
    document = load_fixture("bam-masterdata")
    return convert_bam(document).schema, document


def build(snapshot, **flags):
    schema, document = snapshot
    return graph.build_graph(schema, document, MODULE, base_namespace=NS, **flags)


def test_inherited_properties_are_on_every_child_like_on_their_declaring_class(snapshot):
    """What the frontend needs to show them as inherited (read-only) on the child."""
    result = build(snapshot, root="Amorphous")
    nodes = {node["id"]: node for node in result["nodes"]}
    assert (AMORPHOUS, MAT_SIM, "inherits") in {(e["source"], e["target"], e["type"]) for e in result["edges"]}
    parent = {node["label"]: node for node in nodes.values() if node["owner"] == MAT_SIM}
    child = {node["label"]: node for node in nodes.values() if node["owner"] == AMORPHOUS}
    assert parent and set(parent) < set(child)
    for name, inherited in parent.items():
        copy = child[name]
        # The frontend treats a child's member as inherited when its dtype, shape and card match the parent's.
        assert (copy["dtype"], copy["shape"], copy["card"]) == (inherited["dtype"], inherited["shape"], inherited["card"])
        assert copy["id"] == f"{AMORPHOUS}.{name}"
    own = set(child) - set(parent)
    assert "atom_short_rng_ord" in own


def test_vocabulary_terms_are_quantities_named_by_python_attribute(snapshot):
    schema, document = snapshot
    vocabulary = next(name for name, cls in schema["classes"].items() if cls["title"] == "ShortRngOrd")
    result = graph.build_graph(schema, document, MODULE, base_namespace=NS, root="Amorphous")
    # Vocabularies a property refers to are not drawn: properties are not links.
    assert vocabulary not in {node["id"] for node in result["nodes"]}
    terms = [node for node in graph.build_graph(
        schema, {**document, "modules": [{"name": MODULE, "classes": [vocabulary]}]}, MODULE, base_namespace=NS,
    )["nodes"] if node["kind"] == "quantity"]
    assert terms and all(node["dtype"] == "VOCAB_TERM" and node["card"] is None for node in terms)
    enum = schema["enums"][schema["classes"][vocabulary]["annotations"]["source_vocabulary_enum"]]
    names = {value["annotations"]["source_python_name"]: code for code, value in enum["permissible_values"].items()}
    assert {node["label"]: node["code"] for node in terms} == names


def test_openbis_facts_on_nodes(snapshot):
    nodes = {node["id"]: node for node in build(snapshot, root="Amorphous")["nodes"]}
    amorphous = nodes[AMORPHOUS]
    assert amorphous["code"] == "MAT_SIM_STRUCTURE.AMORPHOUS"
    assert amorphous["doc"] == "Material simulation structure - amorphous"
    assert amorphous["doc_de"] == "Material-simulationsstruktur - amorph"
    temperature = nodes[f"{AMORPHOUS}.atom_sample_temp_in_k"]
    assert temperature["doc"] == "Current temperature of sample [K]"
    assert temperature["doc_de"] == "Aktuelle Temperatur der Probe [K]"
    assert temperature["mandatory"] is False
    assert temperature["code"] == "ATOM_SAMPLE_TEMP_IN_K"


def test_nomad_nodes_carry_no_openbis_facts():
    from api.sources.to_linkml import convert_nomad

    document = load_fixture("nomad-simulations")
    schema = convert_nomad(document).schema
    package = document["modules"][0]["name"]
    result = graph.build_graph(schema, document, package)
    base_fields = {"id", "kind", "label", "doc", "module", "dtype", "shape", "card", "owner", "methods"}
    assert {key for node in result["nodes"] for key in node} == base_fields | {"unit", "subclasses"}


def test_frontend_fixture_is_what_the_adapter_builds(snapshot):
    result = build(snapshot, root="Amorphous")
    text = json.dumps(result, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("SCHEMA_STUDIO_WRITE_FIXTURES"):
        WEB_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        WEB_FIXTURE.write_text(text, encoding="utf-8")
    assert WEB_FIXTURE.read_text(encoding="utf-8") == text

import sys
import textwrap
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from api.rdfs_io import graph_to_rdfs, rdfs_to_graph


def test_roundtrip_preserves_quantities_and_sections():
    graph = {
        "package": "demo.schema",
        "nodes": [
            {"id": "demo.schema.Root", "kind": "section", "label": "Root", "doc": "Root doc"},
            {
                "id": "demo.schema.Root.value",
                "kind": "quantity",
                "label": "value",
                "doc": "Value doc",
                "dtype": "float",
                "card": "0..1",
                "owner": "demo.schema.Root",
            },
        ],
        "edges": [
            {"source": "demo.schema.Root", "target": "demo.schema.Root.value", "type": "hasQuantity", "card": "0..1"},
        ],
    }

    rdf_text = graph_to_rdfs(graph, base_uri="https://example.org/schema#")
    rebuilt = rdfs_to_graph(rdf_text, rdf_format="turtle", package_hint="demo.schema", base_uri="https://example.org/schema#")

    ids = {n["id"] for n in rebuilt["nodes"]}
    assert "demo.schema.Root" in ids
    assert "demo.schema.Root.value" in ids

    qty = next(n for n in rebuilt["nodes"] if n["kind"] == "quantity")
    assert qty["dtype"] == "float"
    assert qty["owner"] == "demo.schema.Root"

    assert any(e for e in rebuilt["edges"] if e["type"] == "hasQuantity" and e["source"] == "demo.schema.Root")


def test_imports_domain_and_range_relationships():
    ttl = textwrap.dedent(
        """
        @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
        @prefix ex: <https://example.org/schema#> .

        ex:Person a rdfs:Class ; rdfs:label "Person" .
        ex:Address a rdfs:Class ; rdfs:label "Address" .

        ex:name a rdf:Property ;
            rdfs:domain ex:Person ;
            rdfs:range xsd:string ;
            rdfs:label "name" .

        ex:address a rdf:Property ;
            rdfs:domain ex:Person ;
            rdfs:range ex:Address ;
            rdfs:label "address" .
        """
    )

    graph = rdfs_to_graph(ttl, rdf_format="turtle", package_hint="example.schema", base_uri="https://example.org/schema#")

    person = next(n for n in graph["nodes"] if n["label"] == "Person")
    address_section = next(n for n in graph["nodes"] if n["label"] == "Address")
    name_quantity = next(n for n in graph["nodes"] if n["label"] == "name")
    address_quantity = next(n for n in graph["nodes"] if n["label"] == "address")

    assert name_quantity["owner"] == person["id"]
    assert address_quantity["owner"] == person["id"]
    assert name_quantity["dtype"] in {"str", "string"}

    assert any(
        e for e in graph["edges"] if e["type"] == "hasSubSection" and e["source"] == person["id"] and e["target"] == address_section["id"]
    )

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import quote, unquote

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS, XSD

SCHEMA_UML = Namespace("https://schema-uml.nomad-lab.eu/schema#")

DTYPE_TO_XSD = {
    "bool": XSD.boolean,
    "boolean": XSD.boolean,
    "str": XSD.string,
    "string": XSD.string,
    "int": XSD.integer,
    "float": XSD.double,
    "float64": XSD.double,
    "float32": XSD.float,
    "datetime": XSD.dateTime,
}


def _normalize_base_uri(raw: Optional[str], package: Optional[str]) -> str:
    if raw:
        base = raw
    else:
        base = f"https://schema-uml.nomad-lab.eu/{package or 'schema'}#"
    if not base.endswith(("#", "/")):
        base = base + "#"
    return base


def _node_label(node: Dict[str, Any]) -> str:
    return node.get("label") or node.get("name") or node.get("id") or "node"


def _local_part(uri: URIRef) -> str:
    text = str(uri)
    if "#" in text:
        return text.rsplit("#", 1)[-1]
    if "/" in text:
        return text.rsplit("/", 1)[-1]
    return text


def _unwrap_id(uri: URIRef, base: Optional[str]) -> str:
    text = str(uri)
    if base and text.startswith(base):
        return unquote(text[len(base) :])
    return text


def _first_literal(graph: Graph, subject: URIRef, predicate: URIRef) -> Optional[str]:
    for obj in graph.objects(subject, predicate):
        if isinstance(obj, Literal):
            return str(obj)
    return None


def _dtype_from_range(range_uri: Optional[URIRef]) -> Optional[str]:
    if range_uri is None:
        return None
    text = str(range_uri)
    for dtype, uri in DTYPE_TO_XSD.items():
        if text == str(uri):
            return dtype
    return _local_part(range_uri)


def _edge_cardinality(graph: Graph, subject: URIRef) -> Optional[str]:
    for pred in (SCHEMA_UML.cardinality, SCHEMA_UML.edgeCardinality):
        card = _first_literal(graph, subject, pred)
        if card:
            return card
    return None


def graph_to_rdfs(graph: Dict[str, Any], base_uri: Optional[str] = None, rdf_format: str = "turtle") -> str:
    base = Namespace(_normalize_base_uri(base_uri, graph.get("package")))
    rdf_graph = Graph()
    rdf_graph.bind("rdfs", RDFS)
    rdf_graph.bind("schemauml", SCHEMA_UML)
    rdf_graph.bind("base", base)

    node_uris: Dict[str, URIRef] = {}

    def uri_for(node_id: str) -> URIRef:
        if node_id not in node_uris:
            node_uris[node_id] = URIRef(str(base) + quote(str(node_id)))
        return node_uris[node_id]

    for node in graph.get("nodes", []):
        node_id = str(node.get("id"))
        uri = uri_for(node_id)
        kind = node.get("kind")
        label = _node_label(node)
        doc = node.get("doc")
        module = node.get("module")
        dtype = node.get("dtype")
        shape = node.get("shape")
        card = node.get("card")
        owner = node.get("owner")

        if kind == "section":
            rdf_graph.add((uri, RDF.type, RDFS.Class))
        else:
            rdf_graph.add((uri, RDF.type, RDF.Property))
        rdf_graph.add((uri, RDFS.label, Literal(label)))
        rdf_graph.add((uri, SCHEMA_UML.kind, Literal(kind or "unknown")))

        if doc:
            rdf_graph.add((uri, RDFS.comment, Literal(doc)))
        if module:
            rdf_graph.add((uri, SCHEMA_UML.module, Literal(module)))
        if dtype:
            dtype_uri = DTYPE_TO_XSD.get(str(dtype))
            if dtype_uri is not None:
                rdf_graph.add((uri, RDFS.range, dtype_uri))
            else:
                rdf_graph.add((uri, SCHEMA_UML.dtype, Literal(str(dtype))))
        if shape:
            rdf_graph.add((uri, SCHEMA_UML.shape, Literal(shape)))
        if card:
            rdf_graph.add((uri, SCHEMA_UML.cardinality, Literal(card)))
        if owner:
            rdf_graph.add((uri, SCHEMA_UML.owner, uri_for(str(owner))))

    for edge in graph.get("edges", []):
        source = str(edge.get("source"))
        target = str(edge.get("target"))
        etype = edge.get("type")
        card = edge.get("card")

        src_uri = uri_for(source)
        tgt_uri = uri_for(target)

        if etype == "hasQuantity":
            rdf_graph.add((src_uri, SCHEMA_UML.hasQuantity, tgt_uri))
        elif etype == "hasSubSection":
            rdf_graph.add((src_uri, SCHEMA_UML.hasSubSection, tgt_uri))
        else:
            rdf_graph.add((src_uri, SCHEMA_UML.relatedTo, tgt_uri))

        if card:
            rdf_graph.add((tgt_uri, SCHEMA_UML.cardinality, Literal(card)))

    return rdf_graph.serialize(format=rdf_format)


def rdfs_to_graph(
    data: str,
    rdf_format: str = "turtle",
    package_hint: Optional[str] = None,
    base_uri: Optional[str] = None,
) -> Dict[str, Any]:
    rdf_graph = Graph()
    rdf_graph.parse(data=data, format=rdf_format)

    decode_base = _normalize_base_uri(base_uri, package_hint) if base_uri else None
    nodes: Dict[str, Dict[str, Any]] = {}
    edges: list[Dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def ensure_section(uri: URIRef) -> Dict[str, Any]:
        uid = _unwrap_id(uri, decode_base)
        if uid not in nodes:
            nodes[uid] = {"id": uid, "kind": "section", "label": _local_part(uri)}
        return nodes[uid]

    has_quantity_pairs = list(rdf_graph.subject_objects(SCHEMA_UML.hasQuantity))
    has_subsection_pairs = list(rdf_graph.subject_objects(SCHEMA_UML.hasSubSection))

    for subj in rdf_graph.subjects(RDF.type, RDFS.Class):
        node_id = _unwrap_id(subj, decode_base)
        node = ensure_section(subj)
        node["label"] = _first_literal(rdf_graph, subj, RDFS.label) or node.get("label")
        node["doc"] = _first_literal(rdf_graph, subj, RDFS.comment)
        node["module"] = _first_literal(rdf_graph, subj, SCHEMA_UML.module)
        nodes[node_id] = node

    for subj in rdf_graph.subjects(RDF.type, RDF.Property):
        node_id = _unwrap_id(subj, decode_base)
        label = _first_literal(rdf_graph, subj, RDFS.label) or _local_part(subj)
        doc = _first_literal(rdf_graph, subj, RDFS.comment)
        dtype = _first_literal(rdf_graph, subj, SCHEMA_UML.dtype)
        shape = _first_literal(rdf_graph, subj, SCHEMA_UML.shape)
        card = _edge_cardinality(rdf_graph, subj)
        owner_uri = next(iter(rdf_graph.objects(subj, SCHEMA_UML.owner)), None)
        if owner_uri is None:
            owner_uri = next(iter(rdf_graph.objects(subj, RDFS.domain)), None)

        range_uri = next(iter(rdf_graph.objects(subj, RDFS.range)), None)
        inferred_dtype = _dtype_from_range(range_uri)
        if inferred_dtype:
            dtype = dtype or inferred_dtype

        owner_id = _unwrap_id(owner_uri, decode_base) if owner_uri is not None else None
        range_id = _unwrap_id(range_uri, decode_base) if range_uri is not None else None

        node = {
            "id": node_id,
            "kind": "quantity",
            "label": label,
            "doc": doc,
            "dtype": dtype,
            "shape": shape,
            "card": card,
            "owner": owner_id,
        }
        nodes[node_id] = node

        if owner_uri is not None:
            add_edge = (owner_id, node_id, "hasQuantity")
            if add_edge not in seen_edges:
                edge: Dict[str, Any] = {"source": add_edge[0], "target": add_edge[1], "type": "hasQuantity"}
                if card:
                    edge["card"] = card
                edges.append(edge)
                seen_edges.add(add_edge)

        if range_id is not None and range_id in nodes:
            add_edge = (owner_id if owner_id is not None else node_id, range_id, "hasSubSection")
            if add_edge not in seen_edges:
                edge: Dict[str, Any] = {"source": add_edge[0], "target": add_edge[1], "type": "hasSubSection"}
                edges.append(edge)
                seen_edges.add(add_edge)

    for src, tgt in has_quantity_pairs:
        src_id = _unwrap_id(src, decode_base)
        tgt_id = _unwrap_id(tgt, decode_base)
        add_edge = (src_id, tgt_id, "hasQuantity")
        if add_edge in seen_edges:
            continue
        ensure_section(src)
        nodes.setdefault(tgt_id, {
            "id": tgt_id,
            "kind": "quantity",
            "label": _local_part(tgt),
            "owner": src_id,
        })
        edge: Dict[str, Any] = {"source": add_edge[0], "target": add_edge[1], "type": "hasQuantity"}
        edges.append(edge)
        seen_edges.add(add_edge)

    for src, tgt in has_subsection_pairs:
        src_id = _unwrap_id(src, decode_base)
        tgt_id = _unwrap_id(tgt, decode_base)
        add_edge = (src_id, tgt_id, "hasSubSection")
        if add_edge in seen_edges:
            continue
        ensure_section(src)
        ensure_section(tgt)
        edge: Dict[str, Any] = {"source": add_edge[0], "target": add_edge[1], "type": "hasSubSection"}
        edges.append(edge)
        seen_edges.add(add_edge)

    package = package_hint or (base_uri or str(rdf_graph.identifier) or "rdfs_schema")

    return {
        "package": package,
        "root": None,
        "base_uri": base_uri,
        "nodes": list(nodes.values()),
        "edges": edges,
    }

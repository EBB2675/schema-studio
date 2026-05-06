from __future__ import annotations

from collections import deque
from typing import Any, Iterable

from fastapi import HTTPException


def _section_by_label_in_package(nodes: list[dict[str, Any]], package: str, class_name: str) -> dict[str, Any] | None:
    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("label") != class_name:
            continue
        module = node.get("module") or ""
        if module.startswith(package):
            return node
    return None


def _section_by_id_or_label(nodes: list[dict[str, Any]], value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    for node in nodes:
        if node.get("kind") != "section":
            continue
        if node.get("id") == value or node.get("label") == value:
            return node
    return None


def _parents_by_child(edges: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for edge in edges:
        if edge.get("type") != "inherits":
            continue
        source = edge.get("source")
        target = edge.get("target")
        if not source or not target:
            continue
        # Inheritance convention: source=child, target=parent
        out.setdefault(source, [])
        if target not in out[source]:
            out[source].append(target)
    return out


def _find_inherited_quantity_origin(
    *,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    section_id: str,
    quantity_name: str,
    parent_name: str | None,
    parent_relation: str | None,
) -> tuple[str, str] | None:
    if parent_relation and parent_relation != "inherits":
        return None

    parents = _parents_by_child(edges)
    start_nodes: list[str] = []

    if parent_name and (not parent_relation or parent_relation == "inherits"):
        parent = _section_by_id_or_label(nodes, parent_name)
        start_nodes.append(parent.get("id") if parent else parent_name)
    else:
        start_nodes.extend(parents.get(section_id, []))

    if not start_nodes:
        return None

    labels_by_id = {
        node.get("id"): node.get("label")
        for node in nodes
        if node.get("kind") == "section" and node.get("id")
    }

    quantity_names_by_owner: dict[str, set[str]] = {}
    for node in nodes:
        if node.get("kind") != "quantity":
            continue
        owner = node.get("owner")
        label = node.get("label")
        if not owner or not label:
            continue
        quantity_names_by_owner.setdefault(owner, set()).add(label)

    visited: set[str] = set()
    queue: deque[str] = deque(node_id for node_id in start_nodes if node_id)

    while queue:
        ancestor_id = queue.popleft()
        if ancestor_id in visited:
            continue
        visited.add(ancestor_id)

        if quantity_name in quantity_names_by_owner.get(ancestor_id, set()):
            ancestor_label = labels_by_id.get(ancestor_id) or ancestor_id
            return ancestor_id, ancestor_label

        for parent_id in parents.get(ancestor_id, []):
            if parent_id not in visited:
                queue.append(parent_id)

    return None


def attach_custom_quantity(graph: dict[str, Any], req: Any, *, supported_dtypes: set[str]) -> dict[str, Any]:
    if req.dtype not in supported_dtypes:
        allowed = ", ".join(sorted(supported_dtypes))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dtype '{req.dtype}'. Supported: {allowed}",
        )

    nodes = list(graph.get("nodes", []))
    edges = list(graph.get("edges", []))

    target_section = _section_by_label_in_package(nodes, req.package, req.class_name)

    if target_section is None:
        if not req.parent_name:
            raise HTTPException(
                status_code=404,
                detail=f"Section '{req.class_name}' not found in package '{req.package}'",
            )

        # Allow adding a quantity to a freshly created synthetic class by materializing it here.
        new_id = f"{req.package}.{req.class_name}"
        target_section = {
            "id": new_id,
            "kind": "section",
            "label": req.class_name,
            "doc": None,
            "module": req.package,
        }
        nodes = nodes + [target_section]

        parent = _section_by_id_or_label(nodes, req.parent_name)
        parent_id = parent.get("id") if parent else req.parent_name
        relation = req.parent_relation or "inherits"
        if relation == "inherits":
            edges = edges + [{"source": new_id, "target": parent_id, "type": relation, "card": None}]
        else:
            edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": None}]

    section_id = target_section["id"]

    inherited_origin = _find_inherited_quantity_origin(
        nodes=nodes,
        edges=edges,
        section_id=section_id,
        quantity_name=req.quantity_name,
        parent_name=req.parent_name,
        parent_relation=req.parent_relation,
    )
    if inherited_origin is not None:
        _, ancestor_label = inherited_origin
        raise HTTPException(
            status_code=400,
            detail=(
                f"Quantity '{req.quantity_name}' is inherited from '{ancestor_label}' "
                f"and cannot be redefined on section '{req.class_name}'"
            ),
        )

    for node in nodes:
        if node.get("kind") == "quantity" and node.get("owner") == section_id and node.get("label") == req.quantity_name:
            raise HTTPException(
                status_code=400,
                detail=f"Quantity '{req.quantity_name}' already exists on section '{req.class_name}'",
            )

    qid = f"{section_id}.{req.quantity_name}"
    new_node = {
        "id": qid,
        "kind": "quantity",
        "label": req.quantity_name,
        "doc": req.docstring or None,
        "dtype": req.dtype,
        "owner": section_id,
        "module": target_section.get("module"),
    }

    updated = dict(graph)
    updated["nodes"] = nodes + [new_node]
    updated["edges"] = edges + [{"source": section_id, "target": qid, "type": "hasQuantity", "card": None}]
    return updated


def attach_custom_class(graph: dict[str, Any], req: Any) -> dict[str, Any]:
    nodes = list(graph.get("nodes", []))
    edges = list(graph.get("edges", []))
    update_existing = bool(getattr(req, "update_existing", False))

    for index, node in enumerate(nodes):
        if node.get("kind") != "section":
            continue
        if node.get("label") == req.name or node.get("id") == req.name or node.get("id") == f"{req.package}.{req.name}":
            if update_existing:
                updated_node = {**node, "doc": req.docstring or None}
                updated = dict(graph)
                updated["nodes"] = [*nodes[:index], updated_node, *nodes[index + 1:]]
                updated["edges"] = edges
                return updated
            raise HTTPException(status_code=400, detail=f"Class '{req.name}' already exists")

    # Always use a fully qualified id to keep consistency when adding quantities later.
    new_id = f"{req.package}.{req.name}"

    new_node = {
        "id": new_id,
        "kind": "section",
        "label": req.name,
        "doc": req.docstring or None,
        "module": req.package,
    }
    nodes = nodes + [new_node]

    if req.parent:
        parent = _section_by_id_or_label(nodes, req.parent)
        parent_id = parent.get("id") if parent else req.parent
        relation = req.relation if req.relation in ("inherits", "hasSubSection") else "inherits"
        card = getattr(req, "card", None) if relation == "hasSubSection" else None
        if relation == "inherits":
            edges = edges + [{"source": new_id, "target": parent_id, "type": relation, "card": None}]
        else:
            edges = edges + [{"source": parent_id, "target": new_id, "type": relation, "card": card}]

    updated = dict(graph)
    updated["nodes"] = nodes
    updated["edges"] = edges
    return updated

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.custom_graph_edits import attach_custom_class, attach_custom_quantity


def test_flattened_inherited_quantity_prefers_inherited_error():
    graph = {
        "nodes": [
            {"id": "pkg.Parent", "kind": "section", "label": "Parent", "module": "pkg"},
            {"id": "pkg.Child", "kind": "section", "label": "Child", "module": "pkg"},
            {
                "id": "pkg.Parent.shared_q",
                "kind": "quantity",
                "label": "shared_q",
                "owner": "pkg.Parent",
                "module": "pkg",
            },
            # Flattened inherited quantity materialized on the child.
            {
                "id": "pkg.Child.shared_q",
                "kind": "quantity",
                "label": "shared_q",
                "owner": "pkg.Child",
                "module": "pkg",
            },
        ],
        "edges": [
            {"source": "pkg.Child", "target": "pkg.Parent", "type": "inherits", "card": None},
            {"source": "pkg.Parent", "target": "pkg.Parent.shared_q", "type": "hasQuantity", "card": None},
            {"source": "pkg.Child", "target": "pkg.Child.shared_q", "type": "hasQuantity", "card": None},
        ],
    }

    req = SimpleNamespace(
        package="pkg",
        class_name="Child",
        quantity_name="shared_q",
        dtype="float",
        docstring=None,
        parent_name=None,
        parent_relation=None,
    )

    with pytest.raises(HTTPException) as exc_info:
        attach_custom_quantity(graph, req, supported_dtypes={"float", "str"})

    assert exc_info.value.status_code == 400
    assert "inherited" in str(exc_info.value.detail)


def test_custom_subsection_preserves_cardinality():
    graph = {
        "nodes": [
            {"id": "pkg.Parent", "kind": "section", "label": "Parent", "module": "pkg"},
        ],
        "edges": [],
    }

    req = SimpleNamespace(
        package="pkg",
        name="Child",
        parent="pkg.Parent",
        relation="hasSubSection",
        card="0..*",
        docstring=None,
    )

    updated = attach_custom_class(graph, req)

    assert {
        "source": "pkg.Parent",
        "target": "pkg.Child",
        "type": "hasSubSection",
        "card": "0..*",
    } in updated["edges"]


def test_custom_inheritance_ignores_cardinality():
    graph = {
        "nodes": [
            {"id": "pkg.Parent", "kind": "section", "label": "Parent", "module": "pkg"},
        ],
        "edges": [],
    }

    req = SimpleNamespace(
        package="pkg",
        name="Child",
        parent="pkg.Parent",
        relation="inherits",
        card="0..*",
        docstring=None,
    )

    updated = attach_custom_class(graph, req)

    assert {
        "source": "pkg.Child",
        "target": "pkg.Parent",
        "type": "inherits",
        "card": None,
    } in updated["edges"]


def test_custom_class_update_existing_changes_docstring():
    graph = {
        "nodes": [
            {"id": "pkg.Child", "kind": "section", "label": "Child", "module": "pkg", "doc": "old"},
        ],
        "edges": [],
    }

    req = SimpleNamespace(
        package="pkg",
        name="Child",
        parent=None,
        relation="inherits",
        card=None,
        docstring="new",
        update_existing=True,
    )

    updated = attach_custom_class(graph, req)

    assert updated["nodes"] == [
        {"id": "pkg.Child", "kind": "section", "label": "Child", "module": "pkg", "doc": "new"}
    ]

"""Compare an extraction document with the graph `legacy.py` builds for the same schema.

The display annotations of `extractor/scripts/nomad.py` must give the strings
the graph shows today. Known, deliberate differences are not reported:

- quantity docs: the graph falls back to the docstring of NOMAD's Quantity
  class when a quantity has no description; the document leaves it out;
- metainfo categories: the graph draws them (and their base categories) as
  sections; the document skips them with a report entry;
- empty docstrings: the graph shows "", the document leaves the description out.
"""
from __future__ import annotations

from typing import Any


def _declared(classes: dict[str, dict], class_id: str, name: str) -> dict | None:
    """The attribute `name` as seen on `class_id`, from the class that declares it."""
    for reference in classes[class_id]["effective_attributes"]:
        if reference["name"] == name:
            declaring = classes[reference["declaring_class_id"]]
            return next(item for item in declaring["attributes"] if item["name"] == name)
    return None


def differences(document: dict[str, Any], graph: dict[str, Any], base_namespace: str) -> list[str]:
    """Every place where the document would show something else than `graph`."""
    classes = {item["id"]: item for item in document["classes"]}
    skipped = {row["path"] for row in document["report"]}
    # A class only reached as the base of a skipped class is not read at all.
    changed = True
    while changed:
        changed = False
        for edge in graph["edges"]:
            if edge["type"] == "inherits" and edge["source"] in skipped and edge["target"] not in classes.keys() | skipped:
                skipped.add(edge["target"])
                changed = True
    found: list[str] = []
    for node in graph["nodes"]:
        if node["kind"] == "section":
            record = classes.get(node["id"])
            if record is None:
                if node["id"] not in skipped:
                    found.append(f"section {node['id']} is missing and not reported")
                continue
            if (record.get("description") or "") != (node["doc"] or ""):
                found.append(f"section {node['id']}: doc differs")
            methods = sorted(m["name"] for m in record.get("methods", []) if m["module"].startswith(base_namespace))
            if (methods or None) != node["methods"]:
                found.append(f"section {node['id']}: methods {methods} != {node['methods']}")
            continue
        attribute = _declared(classes, node["owner"], node["label"])
        if attribute is None:
            found.append(f"quantity {node['id']} is missing")
            continue
        annotations = attribute.get("annotations", {})
        shown = (annotations.get("display_dtype"), annotations.get("display_shape"), annotations.get("display_card"))
        if shown != (node["dtype"], node["shape"], node["card"]):
            found.append(f"quantity {node['id']}: {shown} != {(node['dtype'], node['shape'], node['card'])}")
        if "description" in attribute and attribute["description"] != node["doc"]:
            found.append(f"quantity {node['id']}: doc differs")
    for edge in graph["edges"]:
        if edge["type"] != "hasSubSection":
            continue
        cards = [
            attribute.get("annotations", {}).get("display_card")
            for reference in classes[edge["source"]]["effective_attributes"]
            if reference["kind"] == "subsection"
            for attribute in [_declared(classes, edge["source"], reference["name"])]
            if attribute["range"]["name"] == edge["target"]
        ]
        if edge["card"] not in cards:
            found.append(f"subsection {edge['source']} -> {edge['target']}: card {edge['card']} not in {cards}")
    return found

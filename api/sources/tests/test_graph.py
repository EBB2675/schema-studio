"""The graph adapter: LinkML schema (plain JSON data) to the graph JSON the frontend reads."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from api.sources import graph
from api.sources.to_linkml import convert_nomad

from .conftest import PROJECT_ROOT


def attribute(name, kind, *, range_=None, description=None, **annotations):
    slot = {"name": name, "range": range_ or "string"}
    if description:
        slot["description"] = description
    slot["annotations"] = {"source_kind": kind, **annotations}
    return slot


def cls(name, *, is_a=None, mixins=(), description=None, attributes=(), effective=None):
    entry = {"name": name, "title": name.rpartition(".")[2]}
    if description:
        entry["description"] = description
    if is_a:
        entry["is_a"] = is_a
    if mixins:
        entry["mixins"] = list(mixins)
    if attributes:
        entry["attributes"] = {slot["name"]: slot for slot in attributes}
    if effective is not None:
        entry["annotations"] = {"source_effective_attributes": json.dumps(
            [{"name": n, "kind": k, "declaring_class_id": d} for n, k, d in effective]
        )}
    return entry


# A small module `pkg.app.main`, with a base and a part in other modules of the
# same package, and one class outside the package namespace.
BASE = "pkg.app.base.Base"
MIXIN = "pkg.app.base.Mixin"
CHILD = "pkg.app.main.Child"
GRANDCHILD = "pkg.app.main.GrandChild"
PART = "pkg.app.main.Part"
FAR = "other.lib.Far"
SCHEMA = {
    "classes": {
        BASE: cls(BASE, description="The base.", attributes=[
            attribute("name", "quantity", description="A name.", display_dtype="m_str(str)", display_shape="[]"),
            attribute("size", "quantity", display_dtype="m_float64(float64)", display_shape="['*']",
                      display_card="0..1", source_unit="meter"),
        ], effective=[("name", "quantity", BASE), ("size", "quantity", BASE)]),
        MIXIN: cls(MIXIN, attributes=[attribute("far", "subsection", range_=FAR, display_card="0..1")],
                   effective=[("far", "subsection", MIXIN)]),
        CHILD: cls(CHILD, is_a=BASE, mixins=[MIXIN], attributes=[
            attribute("size", "quantity", description="Size, redeclared.", display_dtype="m_int(int)",
                      display_shape="[]"),
            attribute("part", "quantity", range_=PART, display_dtype="Reference[main.Part]", display_shape="[]"),
            attribute("parts", "subsection", range_=PART, display_card="0..*"),
            attribute("best_part", "subsection", range_=PART, display_card="0..1"),
        ], effective=[
            ("name", "quantity", BASE), ("size", "quantity", CHILD), ("part", "quantity", CHILD),
            ("far", "subsection", MIXIN), ("parts", "subsection", CHILD), ("best_part", "subsection", CHILD),
        ]),
        GRANDCHILD: cls(GRANDCHILD, is_a=CHILD, effective=[
            ("name", "quantity", BASE), ("size", "quantity", CHILD), ("part", "quantity", CHILD),
            ("far", "subsection", MIXIN), ("parts", "subsection", CHILD), ("best_part", "subsection", CHILD),
        ]),
        PART: cls(PART, attributes=[attribute("label", "quantity", display_dtype="m_str(str)", display_shape="[]")],
                  effective=[("label", "quantity", PART)]),
        FAR: cls(FAR, description="Outside the package.", effective=[]),
    },
}
EXTRACTION = {
    "modules": [{"name": "pkg.app.main", "classes": [GRANDCHILD, CHILD, PART]}],
    "classes": [
        {"id": CHILD, "methods": [{"name": "normalize", "module": "pkg.app.base"},
                                  {"name": "plot", "module": "pkg.app.main"},
                                  {"name": "helper", "module": "other.lib"}]},
    ],
    "usage": {CHILD: [{"kind": "normalize_method", "qualname": f"{CHILD}.normalize", "module": "pkg.app.main",
                       "short_name": "normalize", "doc": "Normalize."}]},
}


def build(**flags):
    return graph.build_graph(SCHEMA, EXTRACTION, "pkg.app.main", **flags)


def nodes(result):
    return {node["id"]: node for node in result["nodes"]}


def edges(result):
    return {(edge["source"], edge["target"], edge["type"]): edge["card"] for edge in result["edges"]}


def test_classes_become_sections_and_quantities_follow_display_annotations():
    result = build()
    assert {key: result[key] for key in ("package", "root", "base_namespace")} == {
        "package": "pkg.app.main", "root": None, "base_namespace": "pkg.app.main",
    }
    shown = nodes(result)
    assert shown[CHILD] == {
        "id": CHILD, "kind": "section", "label": "Child", "doc": None, "module": "pkg.app.main",
        "dtype": None, "shape": None, "card": None, "owner": None, "methods": ["plot"],
    }
    assert shown[BASE]["doc"] == "The base." and shown[BASE]["module"] == "pkg.app.base"
    # Inherited quantities belong to each class that has them; the redeclared one wins.
    assert shown[f"{CHILD}.name"] == {
        "id": f"{CHILD}.name", "kind": "quantity", "label": "name", "doc": "A name.", "module": "pkg.app.main",
        "dtype": "m_str(str)", "shape": "[]", "card": None, "owner": CHILD, "methods": None, "unit": None,
    }
    assert shown[f"{BASE}.size"]["unit"] == "meter" and shown[f"{BASE}.size"]["card"] == "0..1"
    assert shown[f"{CHILD}.size"]["dtype"] == "m_int(int)" and shown[f"{CHILD}.size"]["doc"] == "Size, redeclared."
    assert shown[f"{GRANDCHILD}.size"]["dtype"] == "m_int(int)"
    # A reference stays a quantity, with no subsection edge of its own.
    assert shown[f"{CHILD}.part"]["dtype"] == "Reference[main.Part]"
    assert edges(result)[(CHILD, f"{CHILD}.size", "hasQuantity")] is None


def test_inheritance_edges_go_to_every_ancestor():
    found = {(source, target) for source, target, kind in edges(build()) if kind == "inherits"}
    assert found == {(CHILD, BASE), (CHILD, MIXIN), (GRANDCHILD, CHILD), (GRANDCHILD, BASE), (GRANDCHILD, MIXIN)}


def test_subsections_become_edges_and_the_first_declared_one_sets_the_card():
    found = edges(build())
    # `parts` and `best_part` both lead to Part; like the graph builder, the first one is kept.
    assert found[(CHILD, PART, "hasSubSection")] == "0..*"
    assert found[(MIXIN, FAR, "hasSubSection")] == "0..1"
    assert found[(GRANDCHILD, FAR, "hasSubSection")] == "0..1"


def test_root_selects_one_class_and_unknown_roots_are_refused():
    result = build(root="Part")
    assert set(nodes(result)) == {PART, f"{PART}.label"}
    assert result["root"] == "Part"
    with pytest.raises(graph.RootNotFound, match="Root section 'Nope' not found in pkg.app.main"):
        build(root="Nope")


def test_flags_leave_out_quantities_subsections_and_inheritance():
    without_quantities = build(include_quantities=False)
    assert {node["kind"] for node in without_quantities["nodes"]} == {"section"}
    assert "hasQuantity" not in {edge["type"] for edge in without_quantities["edges"]}

    without_inheritance = build(root="Child", include_inheritance=False)
    assert "inherits" not in {edge["type"] for edge in without_inheritance["edges"]}
    assert BASE not in nodes(without_inheritance)

    without_subsections = build(root="Child", include_subsections=False)
    assert "hasSubSection" not in {edge["type"] for edge in without_subsections["edges"]}
    assert PART not in nodes(without_subsections) and FAR not in nodes(without_subsections)


def test_cross_module_links_stop_at_the_base_namespace():
    inside = build(root="Child", allow_cross_module=False, base_namespace="pkg.app")
    assert FAR not in nodes(inside) and BASE in nodes(inside)
    assert (MIXIN, FAR, "hasSubSection") not in edges(inside)
    assert FAR in nodes(build(root="Child", base_namespace="pkg.app"))


def test_methods_are_limited_to_the_base_namespace():
    assert nodes(build(base_namespace="pkg.app.main"))[CHILD]["methods"] == ["plot"]
    assert nodes(build(base_namespace="pkg"))[CHILD]["methods"] == ["normalize", "plot"]
    assert nodes(build(base_namespace="nothing"))[CHILD]["methods"] is None


def test_framework_classes_are_left_out():
    schema = {"classes": {**SCHEMA["classes"], "nomad.metainfo.metainfo.MSection": cls("nomad.metainfo.metainfo.MSection")}}
    schema["classes"][PART] = {**schema["classes"][PART], "is_a": "nomad.metainfo.metainfo.MSection"}
    result = graph.build_graph(schema, EXTRACTION, "pkg.app.main", root="Part")
    assert "nomad.metainfo.metainfo.MSection" not in nodes(result)
    assert [edge for edge in result["edges"] if edge["type"] == "inherits"] == []


def test_empty_returns_a_graph_shell():
    assert build(root="Child", empty=True) == {"package": "pkg.app.main", "root": "Child", "nodes": [], "edges": []}


def test_nodes_and_edges_are_sorted_like_the_graph_builder():
    result = build()
    keys = [(node["kind"], node["module"] or "", node["label"]) for node in result["nodes"]]
    assert keys == sorted(keys)
    edge_keys = [(edge["source"], edge["type"], edge["target"]) for edge in result["edges"]]
    assert edge_keys == sorted(edge_keys)
    assert build() == result


def edited(change):
    schema = json.loads(json.dumps(SCHEMA))
    change(schema["classes"])
    return graph.build_graph(schema, EXTRACTION, "pkg.app.main")


def test_edits_show_although_the_source_attribute_list_is_older():
    # The source list only orders the attributes; the current schema decides which there are.
    def add(classes):
        classes[BASE]["attributes"]["added"] = attribute("added", "quantity", display_dtype="m_str(str)")
    shown = nodes(edited(add))
    assert {f"{BASE}.added", f"{CHILD}.added", f"{GRANDCHILD}.added"} <= set(shown)

    def remove(classes):
        del classes[BASE]["attributes"]["name"]
    shown = nodes(edited(remove))
    assert not {f"{BASE}.name", f"{CHILD}.name", f"{GRANDCHILD}.name"} & set(shown)

    def move(classes):  # `size` now declared on Mixin only
        del classes[BASE]["attributes"]["size"]
        del classes[CHILD]["attributes"]["size"]
        classes[MIXIN]["attributes"]["size"] = attribute("size", "quantity", display_dtype="moved")
    assert nodes(edited(move))[f"{GRANDCHILD}.size"]["dtype"] == "moved"

    def override(classes):  # the redeclaration is dropped: Base's `size` shows again
        del classes[CHILD]["attributes"]["size"]
    assert nodes(edited(override))[f"{CHILD}.size"]["dtype"] == "m_float64(float64)"

    def rebase(classes):  # Child no longer inherits Mixin, so its `far` subsection goes
        del classes[CHILD]["mixins"]
    result = edited(rebase)
    assert (CHILD, FAR, "hasSubSection") not in edges(result)
    assert (CHILD, MIXIN, "inherits") not in edges(result)

    def retarget(classes):  # a subsection pointed elsewhere
        classes[CHILD]["attributes"]["parts"]["range"] = FAR
    found = edges(edited(retarget))
    assert found[(CHILD, FAR, "hasSubSection")] == "0..1"  # `far` comes first in the source order
    assert found[(CHILD, PART, "hasSubSection")] == "0..1"  # only `best_part` still leads to Part


def test_source_order_comes_first_and_new_attributes_follow():
    classes = json.loads(json.dumps(SCHEMA))["classes"]
    classes[CHILD]["attributes"]["zeta"] = attribute("zeta", "subsection", range_=FAR, display_card="0..*")
    classes[BASE]["attributes"]["alpha"] = attribute("alpha", "subsection", range_=FAR, display_card="1..1")
    members = [slot["name"] for _, slot in graph.effective_attributes(CHILD, classes, {})]
    # New ones after the known ones, base classes first.
    assert members == ["name", "size", "part", "far", "parts", "best_part", "alpha", "zeta"]
    # So `far` (0..1) still sets the card of the single Child -> Far edge.
    found = edges(graph.build_graph({"classes": classes}, EXTRACTION, "pkg.app.main"))
    assert found[(CHILD, FAR, "hasSubSection")] == "0..1"


def test_classes_without_source_effective_attributes_inherit_along_the_resolution_order():
    # For example classes added by an edit: their own attributes override inherited ones.
    schema = {"classes": {
        "m.A": cls("m.A", attributes=[attribute("x", "quantity", display_dtype="A")]),
        "m.B": cls("m.B", attributes=[attribute("x", "quantity", display_dtype="B")]),
        "m.C": cls("m.C", is_a="m.A", mixins=["m.B"], attributes=[attribute("y", "quantity", display_dtype="C")]),
    }}
    extraction = {"modules": [{"name": "m", "classes": ["m.C"]}]}
    shown = nodes(graph.build_graph(schema, extraction, "m", root="C"))
    assert shown["m.C.x"]["dtype"] == "A"  # Python order: C, A, B
    assert shown["m.C.y"]["dtype"] == "C"


def test_without_source_attribute_list_the_first_declared_subsection_sets_the_card():
    # `parts` is declared before `best_part`; sorting by name would let `best_part` win.
    schema = {"classes": {
        "m.Part": cls("m.Part"),
        "m.Holder": cls("m.Holder", attributes=[
            attribute("parts", "subsection", range_="m.Part", display_card="0..*"),
            attribute("best_part", "subsection", range_="m.Part", display_card="0..1"),
        ]),
    }}
    extraction = {"modules": [{"name": "m", "classes": ["m.Holder"]}]}
    found = edges(graph.build_graph(schema, extraction, "m", root="Holder"))
    assert found[("m.Holder", "m.Part", "hasSubSection")] == "0..*"


def test_linkml_annotation_objects_are_read_too():
    schema = json.loads(json.dumps(SCHEMA))
    for entry in schema["classes"].values():
        for slot in (entry.get("attributes") or {}).values():
            slot["annotations"] = {tag: {"tag": tag, "value": value} for tag, value in slot["annotations"].items()}
    assert build() == graph.build_graph(schema, EXTRACTION, "pkg.app.main")


def test_usage_entries_come_from_the_extraction_document():
    assert graph.usage_entries(EXTRACTION, CHILD) == [{
        "kind": "normalize_method", "qualname": f"{CHILD}.normalize", "module": "pkg.app.main",
        "short_name": "normalize", "doc": "Normalize.",
    }]
    assert graph.usage_entries({**EXTRACTION, "classes": [{"id": PART}]}, PART) == []
    assert graph.usage_entries(EXTRACTION, "unknown.Class") is None


def test_roots_are_the_names_the_module_binds():
    names = {"Child": CHILD, "GrandChild": GRANDCHILD, "Part": PART, "Piece": PART}
    extraction = {**EXTRACTION, "modules": [{**EXTRACTION["modules"][0], "names": names}]}
    assert graph.section_names(SCHEMA, extraction, "pkg.app.main") == ["Child", "GrandChild", "Part", "Piece"]
    assert graph.build_graph(SCHEMA, extraction, "pkg.app.main", root="Piece") == build(root="Part") | {"root": "Piece"}
    # A class bound only under another name is offered under that name alone, as the module has it.
    del names["Part"]
    assert graph.section_names(SCHEMA, extraction, "pkg.app.main") == ["Child", "GrandChild", "Piece"]
    with pytest.raises(graph.RootNotFound):
        graph.build_graph(SCHEMA, extraction, "pkg.app.main", root="Part")


def test_roots_are_the_module_classes_in_its_namespace():
    extraction = {**EXTRACTION, "modules": [*EXTRACTION["modules"], {"name": "pkg.app.base", "classes": [BASE, MIXIN, FAR]}]}
    assert graph.section_names(SCHEMA, extraction, "pkg.app.main") == ["Child", "GrandChild", "Part"]
    # Far is exposed by the module but lives outside its namespace.
    assert graph.section_names(SCHEMA, extraction, "pkg.app.base") == ["Base", "Mixin"]
    assert graph.section_names(SCHEMA, extraction, "pkg.app.missing") == []
    assert graph.schema_modules(SCHEMA, extraction) == [
        {"package": "pkg.app.main", "sections": ["Child", "GrandChild", "Part"]},
        {"package": "pkg.app.base", "sections": ["Base", "Mixin"]},
    ]


# -------- against the legacy graph builder, on the fake NOMAD package --------

@pytest.fixture()
def fake_nomad(tmp_path: Path):
    from extractor.runner import ExtractorEnvironment
    from extractor.tests.test_nomad_script import FILES

    if sys.platform == "win32":
        pytest.skip("needs a symlinked interpreter")
    directory = tmp_path / "environments" / "fake"
    (directory / ".venv" / "bin").mkdir(parents=True)
    (directory / ".venv" / "bin" / "python").symlink_to(sys.executable)
    root = tmp_path / "worktree" / "src"
    for name, content in FILES.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.lstrip("\n"))
    return ExtractorEnvironment(name="fake", directory=directory), root


@pytest.mark.parametrize("flags", [
    {},
    {"root": "Measurement"},
    {"root": "Specimen"},
    {"root": "Measurement", "allow_cross_module": False, "base_namespace": "fakeschema.measurement"},
    {"include_quantities": False},
    {"include_inheritance": False, "include_subsections": False},
])
def test_graph_matches_the_legacy_graph_on_a_fake_package(fake_nomad, flags):
    from extractor.tests.test_nomad_script import MEASUREMENT, _legacy, _nomad

    environment, source_root = fake_nomad
    document = _nomad(environment, source_root, "--module", MEASUREMENT)
    document["source"]["name"] = "nomad-measurements"  # any NOMAD profile, for the id prefix
    flags = {"base_namespace": "fakeschema", **flags}
    expected = _legacy(environment, source_root, "graph", package=MEASUREMENT, **flags)
    result = graph.build_graph(convert_nomad(document).schema, document, MEASUREMENT, **flags)

    # Explained differences: the category is not a section, and an undocumented
    # quantity has no description.
    category = "fakeschema.measurement.MeasurementCategory"
    expected["nodes"] = [node for node in expected["nodes"] if node["id"] != category]
    expected["edges"] = [edge for edge in expected["edges"] if category not in (edge["source"], edge["target"])]
    for node in expected["nodes"]:
        if node["doc"] == "Generic text about quantities in general.":
            node["doc"] = None
    for node in result["nodes"]:
        node.pop("unit", None)
    assert result == expected

    if not flags.get("root"):
        sections = _legacy(environment, source_root, "sections", package=MEASUREMENT)
        assert graph.section_names(convert_nomad(document).schema, document, MEASUREMENT) == [
            name for name in sections if name != "MeasurementCategory"
        ]


# -------- design rule: plain data, standard library only --------

def test_graph_adapter_and_edits_use_the_standard_library_only():
    """They run in the browser later (Pyodide), so they may import nothing but the standard library."""
    sources = PROJECT_ROOT / "api" / "sources"
    code = (
        "import importlib.util, json, sys\n"
        "def load(name):\n"
        f"    spec = importlib.util.spec_from_file_location(name, {str(sources)!r} + '/' + name + '.py')\n"
        "    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module\n"
        "graph, edits = load('graph'), load('edits')\n"
        "schema = {'default_prefix': 'nomadsim', 'classes': {'m.A': {'name': 'm.A', 'title': 'A', 'attributes': {'x': {'name': 'x', "
        "'annotations': {'source_kind': 'quantity', 'display_dtype': 'str'}}, 'p': {'name': 'p', 'required': True, "
        "'annotations': {'source_kind': 'property', 'source_property_code': 'P', 'source_annotations': '{}'}}}}, "
        "'m.V': {'name': 'm.V', 'title': 'V', 'annotations': {'source_vocabulary_enum': 'm.V.terms'}}}, "
        "'enums': {'m.V.terms': {'permissible_values': {'T': {'annotations': {'source_python_name': 't'}}}}}}\n"
        "stored = [edits.prepare_edit(schema, 'add_class', '', {'name': 'B', 'is_a': 'm.A'}, rules='nomad', package='m'),\n"
        "          edits.prepare_edit(schema, 'set_description', 'm.A', {'description': 'A.'}, rules='nomad', package='m')]\n"
        "edited, applied, conflicts = edits.apply_edits(schema, stored, rules='nomad')\n"
        "result = graph.build_graph(edited, {'modules': [{'name': 'm', 'classes': ['m.A', 'm.V']}]}, 'm')\n"
        "json.dumps([result, stored, conflicts])\n"
        "print(len(result['nodes']), len(applied), len(conflicts))\n"
        "print(sorted({n.split('.')[0] for n in sys.modules} - set(sys.stdlib_module_names) - {'graph', 'edits', '__main__'}))\n"
    )
    # -S: no site packages at all, so anything outside the standard library fails to import.
    out = subprocess.run([sys.executable, "-I", "-S", "-c", code], capture_output=True, text=True, check=True)
    # A, its two quantities, V and its term, and B with A's two quantities.
    assert out.stdout.split("\n")[:2] == ["8 2 0", "[]"]
    for name in ("graph.py", "edits.py"):
        source = (sources / name).read_text(encoding="utf-8")
        for forbidden in ("fastapi", "sqlite3", "linkml_runtime", "extractor", "yaml", "pydantic"):
            assert f"import {forbidden}" not in source and f"from {forbidden}" not in source

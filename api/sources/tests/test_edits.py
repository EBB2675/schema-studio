"""Edit operations on the LinkML schema (plain JSON data), per profile, and their replay."""
from __future__ import annotations

import copy
import json

import pytest
import yaml

from api.sources import edits, graph
from api.sources.edits import EditError
from api.sources.linkml_yaml import dump_yaml
from api.sources.to_linkml import convert

from .conftest import load_fixture

SIM = "nomad_simulations.schema_packages.model_method"
MEAS = "nomad_measurements.transmission.schema"
BAM = "bam_masterdata.datamodel.object_types"
VOCABULARIES = "bam_masterdata.datamodel.vocabulary_types"
RULES = {"nomad-simulations": "nomad", "nomad-measurements": "nomad", "bam-masterdata": "bam-masterdata"}
PACKAGE = {"nomad-simulations": SIM, "nomad-measurements": MEAS, "bam-masterdata": BAM}


@pytest.fixture(scope="module")
def converted():
    """profile -> (extraction document, converted schema), converted once per module."""
    return {profile: (document, convert(document).schema)
            for profile in RULES for document in [load_fixture(profile)]}


class Session:
    """Edits made one after the other on a profile's schema, as the app makes and stores them."""

    def __init__(self, converted, profile: str, commit: str = "c1") -> None:
        self.profile = profile
        self.document, self.source = converted[profile]
        self.schema = copy.deepcopy(self.source)
        self.commit = commit
        self.stored: list[dict] = []

    @property
    def rules(self) -> str:
        return RULES[self.profile]

    def edit(self, op: str, target: str = "", **payload):
        edit = edits.prepare_edit(self.schema, op, target, payload, rules=self.rules,
                                  package=PACKAGE[self.profile], profile=self.profile, commit=self.commit)
        edits.apply_edit(self.schema, edit, rules=self.rules)
        self.stored.append(edit)
        return edit

    def refuse(self, op: str, target: str = "", **payload) -> EditError:
        before = copy.deepcopy(self.schema)
        with pytest.raises(EditError) as raised:
            edits.prepare_edit(self.schema, op, target, payload, rules=self.rules,
                               package=PACKAGE[self.profile], profile=self.profile, commit=self.commit)
        assert self.schema == before
        return raised.value

    def graph(self, **flags):
        return graph.build_graph(self.schema, self.document, PACKAGE[self.profile], **flags)

    def nodes(self, **flags):
        return {node["id"]: node for node in self.graph(**flags)["nodes"]}

    def roots(self):
        return graph.section_names(self.schema, self.document, PACKAGE[self.profile])

    def module_class(self) -> str:
        """A class the package defines itself."""
        package = PACKAGE[self.profile]
        module = next(module for module in self.document["modules"] if module["name"] == package)
        return next(name for name in module["classes"] if name.startswith(package))


# -------- NOMAD profiles --------

@pytest.mark.parametrize("profile", ["nomad-simulations", "nomad-measurements"])
def test_nomad_add_class_and_quantity_look_like_extracted_ones(converted, profile):
    session = Session(converted, profile)
    package = PACKAGE[profile]
    base = session.module_class()
    session.edit("add_class", name="Added", is_a=base, description="A new class.")
    added = f"{package}.Added"
    assert session.stored[0]["target"] == added
    session.edit("add_attribute", added, name="cutoff", kind="quantity", dtype="float64", description="A cutoff.")
    session.edit("add_attribute", added, name="parts", kind="subsection", range=base, multivalued=True)

    cls = session.schema["classes"][added]
    assert cls["is_a"] == base and cls["title"] == "Added"
    assert cls["class_uri"] == f"{session.schema['default_prefix']}:{added.replace('.', '%2E')}"
    assert cls["annotations"]["edit_added"] == "true"
    slot = cls["attributes"]["cutoff"]
    assert slot["range"] == "double"
    assert slot["annotations"]["source_type"] == '{"type_data": "float64", "type_kind": "numpy"}'
    assert slot["annotations"]["display_dtype"] == "m_float64(float64)"

    nodes = session.nodes()
    assert nodes[added]["label"] == "Added" and nodes[added]["methods"] is None
    assert nodes[f"{added}.cutoff"] | {"unit": None} == {
        "id": f"{added}.cutoff", "kind": "quantity", "label": "cutoff", "doc": "A cutoff.", "module": package,
        "dtype": "m_float64(float64)", "shape": "[]", "card": None, "owner": added, "methods": None, "unit": None,
    }
    edges = {(edge["source"], edge["target"], edge["type"]): edge["card"] for edge in session.graph()["edges"]}
    assert edges[(added, base, "hasSubSection")] == "0..*"
    assert edges[(added, base, "inherits")] is None
    # Inherited quantities show on the new class too, as on any child.
    inherited = next(iter(session.schema["classes"][base].get("attributes") or {}), None)
    if inherited and graph.annotation(session.schema["classes"][base]["attributes"][inherited], "source_kind") == "quantity":
        assert f"{added}.{inherited}" in nodes
    # The new class is a root of its module, and the graph can start there.
    assert "Added" in session.roots()
    assert session.graph(root="Added")["nodes"]


def test_nomad_rename_and_remove_attribute(converted):
    session = Session(converted, "nomad-simulations")
    owner = f"{SIM}.BaseModelMethod"
    child = f"{SIM}.ModelMethodElectronic"
    declared = list(session.schema["classes"][owner]["attributes"])
    name = next(key for key in declared
                if graph.annotation(session.schema["classes"][owner]["attributes"][key], "source_kind") == "quantity")
    order_before = [node["label"] for node in session.graph(root="ModelMethodElectronic")["nodes"]
                    if node.get("owner") == child]

    session.edit("rename_attribute", owner, attribute=name, new_name="renamed_q")
    assert "renamed_q" in session.schema["classes"][owner]["attributes"]
    nodes = session.nodes()
    assert f"{owner}.renamed_q" in nodes and f"{owner}.{name}" not in nodes
    # The child shows the renamed one in the same place.
    order_after = [node["label"] for node in session.graph(root="ModelMethodElectronic")["nodes"]
                   if node.get("owner") == child]
    assert sorted(order_after) == sorted(["renamed_q" if label == name else label for label in order_before])
    assert f"{child}.renamed_q" in nodes

    # Inherited members are read-only on the child.
    assert session.refuse("rename_attribute", child, attribute="renamed_q", new_name="x").reason == "inherited"
    assert session.refuse("remove_attribute", child, attribute="renamed_q").reason == "inherited"
    assert session.refuse("set_description", child, attribute="renamed_q", description="x").reason == "inherited"

    session.edit("remove_attribute", owner, attribute="renamed_q")
    nodes = session.nodes()
    assert f"{owner}.renamed_q" not in nodes and f"{child}.renamed_q" not in nodes


def test_nomad_rename_class_keeps_its_bindings_methods_and_references(converted):
    session = Session(converted, "nomad-simulations")
    dft = f"{SIM}.DFT"
    record = next(row for row in session.document["classes"] if row["id"] == dft)
    subclasses = [name for name, cls in session.schema["classes"].items() if cls.get("is_a") == dft]
    session.edit("rename_class", dft, new_name="DensityFunctional")
    renamed = f"{SIM}.DensityFunctional"
    assert renamed in session.schema["classes"] and dft not in session.schema["classes"]
    assert session.schema["classes"][renamed]["annotations"]["source_class"] == dft
    for name in subclasses:
        assert session.schema["classes"][name]["is_a"] == renamed
    roots = session.roots()
    assert "DensityFunctional" in roots and "DFT" not in roots
    node = session.nodes(root="DensityFunctional")[renamed]
    assert node["label"] == "DensityFunctional"
    # Methods describe the source class's code, which the renamed class still is.
    expected = graph._methods(record, graph.root_namespace(SIM))
    assert node["methods"] == expected
    assert session.refuse("rename_class", renamed, new_name="ModelMethod").reason == "exists"


def test_nomad_remove_class_only_when_unused(converted):
    session = Session(converted, "nomad-simulations")
    error = session.refuse("remove_class", f"{SIM}.ModelMethod")
    assert error.reason == "in_use" and "inherits from it" in error.detail
    session.edit("add_class", name="Scratch")
    assert "Scratch" in session.roots()
    session.edit("remove_class", f"{SIM}.Scratch")
    assert "Scratch" not in session.roots()
    # A source class nothing refers to can go too; it stops being a root.
    leaf = next(name for name in session.document["modules"][0]["classes"]
                if name.startswith(SIM) and not edits._references(session.schema, name))
    session.edit("remove_class", leaf)
    assert graph._title(leaf, {}) not in session.roots()


def test_nomad_set_range_description_and_required(converted):
    session = Session(converted, "nomad-measurements")
    owner = next(name for name, cls in session.schema["classes"].items() if name.startswith(MEAS) and any(
        graph.annotation(slot, "source_kind") == "quantity" for slot in (cls.get("attributes") or {}).values()))
    name = next(key for key, slot in session.schema["classes"][owner]["attributes"].items()
                if graph.annotation(slot, "source_kind") == "quantity")
    edit = session.edit("set_range", owner, attribute=name, dtype="int64")
    assert set(edit["payload"]["before"]) == {"range", "display_dtype"}
    slot = session.schema["classes"][owner]["attributes"][name]
    assert slot["range"] == "integer" and slot["annotations"]["display_dtype"] == "m_int64(int64)"
    session.edit("set_description", owner, attribute=name, description="Now documented.")
    session.edit("set_required", owner, attribute=name, required=True)
    assert slot["required"] is True and slot["description"] == "Now documented."
    session.edit("set_description", owner, description="")
    assert "description" not in session.schema["classes"][owner]
    assert session.refuse("set_range", owner, attribute=name, dtype="np.float64").reason == "invalid"


def test_nomad_enum_values(converted):
    session = Session(converted, "nomad-measurements")
    enum = f"{MEAS}.PolDepol.mode"
    session.edit("add_enum_value", enum, value="Both", description="Polarizer and depolarizer.")
    values = session.schema["enums"][enum]["permissible_values"]
    assert list(values)[-1] == "Both" and values["Both"]["annotations"]["edit_added"] == "true"
    assert session.refuse("add_enum_value", enum, value="Both").reason == "exists"
    session.edit("remove_enum_value", enum, value="Polarizer")
    assert "Polarizer" not in values
    assert session.refuse("remove_enum_value", enum, value="Polarizer").reason == "not_found"


def test_nomad_validation_errors(converted):
    session = Session(converted, "nomad-simulations")
    owner = f"{SIM}.ModelMethod"
    for op, target, payload, reason in (
        ("add_class", "", {"name": "9Bad"}, "invalid"),
        ("add_class", "", {"name": "ModelMethod"}, "exists"),
        ("add_class", "", {"name": "X", "is_a": "missing.Class"}, "not_found"),
        ("add_attribute", owner, {"name": "x", "kind": "quantity", "dtype": "np.int32"}, "invalid"),
        ("add_attribute", owner, {"name": "x", "kind": "quantity"}, "invalid"),
        ("add_attribute", owner, {"name": "x", "kind": "subsection", "range": "missing.Class"}, "not_found"),
        ("add_attribute", owner, {"name": "x", "kind": "property", "dtype": "str"}, "invalid"),
        ("add_attribute", "missing.Class", {"name": "x", "kind": "quantity", "dtype": "str"}, "not_found"),
        ("rename_attribute", owner, {"attribute": "nope", "new_name": "x"}, "not_found"),
        ("set_required", owner, {"attribute": next(iter(session.schema["classes"][owner]["attributes"])),
                                 "required": "yes"}, "invalid"),
        ("add_enum_value", owner, {"value": "x"}, "invalid"),
        ("frobnicate", owner, {}, "invalid"),
    ):
        assert session.refuse(op, target, **payload).reason == reason, (op, payload)


# -------- bam-masterdata --------

def test_bam_object_type_codes(converted):
    session = Session(converted, "bam-masterdata")
    structure = f"{BAM}.MatSimStructure"
    # Code rules: upper case segments; a child's code extends its parent's by one segment.
    assert session.refuse("add_class", code="crystal").reason == "invalid"
    assert session.refuse("add_class", code="$CRYSTAL").reason == "invalid"
    error = session.refuse("add_class", code="CRYSTAL", is_a=structure)
    assert "MAT_SIM_STRUCTURE.<NAME>" in error.detail
    assert session.refuse("add_class", code="MAT_SIM_STRUCTURE.A.B", is_a=structure).reason == "invalid"
    assert session.refuse("add_class", code="PERSON.BAM").reason == "exists"
    assert session.refuse("add_class", code="X", is_a=f"{VOCABULARIES}.ShortRngOrd").reason == "invalid"

    edit = session.edit("add_class", code="MAT_SIM_STRUCTURE.CRYSTAL_LATTICE", is_a=structure,
                        description="A crystal.", description_de="Ein Kristall.")
    # The class name follows bam-masterdata's code_to_class_name.
    assert edit["target"] == f"{BAM}.CrystalLattice"
    node = session.nodes()[f"{BAM}.CrystalLattice"]
    assert {key: node[key] for key in ("label", "doc", "code", "doc_de")} == {
        "label": "CrystalLattice", "doc": "A crystal.", "code": "MAT_SIM_STRUCTURE.CRYSTAL_LATTICE",
        "doc_de": "Ein Kristall.",
    }
    # Inherited properties show on the new object type.
    assert f"{BAM}.CrystalLattice.name" in session.nodes()
    assert "CrystalLattice" in session.roots()


def test_bam_properties(converted):
    session = Session(converted, "bam-masterdata")
    owner = f"{BAM}.Calibration"
    session.edit("add_attribute", owner, code="CALIBRATION_NOTE", data_type="MULTILINE_VARCHAR", label="Note",
                 description="A note.", description_de="Eine Notiz.", section="General Information")
    session.edit("add_attribute", owner, code="CALIBRATED_BY", data_type="OBJECT", range=f"{BAM}.Bam", mandatory=True)
    session.edit("add_attribute", owner, code="ORDERING", data_type="CONTROLLEDVOCABULARY",
                 range=f"{VOCABULARIES}.ShortRngOrd")
    nodes = session.nodes()
    note = nodes[f"{owner}.calibration_note"]
    assert {key: note[key] for key in ("dtype", "card", "code", "title", "doc", "doc_de", "mandatory", "section")} == {
        "dtype": "MULTILINE_VARCHAR", "card": "0..1", "code": "CALIBRATION_NOTE", "title": "Note", "doc": "A note.",
        "doc_de": "Eine Notiz.", "mandatory": False, "section": "General Information",
    }
    by = nodes[f"{owner}.calibrated_by"]
    assert (by["dtype"], by["card"], by["mandatory"]) == ("OBJECT[PERSON.BAM]", "1..1", True)
    assert session.schema["classes"][owner]["attributes"]["calibrated_by"]["range"] == f"{BAM}.Bam"
    ordering = session.schema["classes"][owner]["attributes"]["ordering"]
    assert ordering["range"] == f"{VOCABULARIES}.ShortRngOrd.terms"
    assert nodes[f"{owner}.ordering"]["dtype"] == "CONTROLLEDVOCABULARY[SHORT_RNG_ORD]"

    session.edit("set_required", owner, attribute="calibrated_by", required=False)
    assert session.nodes()[f"{owner}.calibrated_by"]["card"] == "0..1"
    session.edit("set_range", owner, attribute="calibration_note", data_type="VARCHAR")
    assert session.nodes()[f"{owner}.calibration_note"]["dtype"] == "VARCHAR"
    session.edit("rename_attribute", owner, attribute="calibration_note", new_name="note")
    note = session.nodes()[f"{owner}.note"]
    assert note["code"] == "CALIBRATION_NOTE"  # the code names the property type, not the attribute
    session.edit("remove_attribute", owner, attribute="note")
    assert f"{owner}.note" not in session.nodes()


def test_bam_property_rules(converted):
    session = Session(converted, "bam-masterdata")
    owner = f"{BAM}.Calibration"
    for payload, reason, words in (
        ({"code": "lower", "data_type": "VARCHAR"}, "invalid", "upper case"),
        ({"code": "$NAME", "data_type": "VARCHAR"}, "invalid", "reserved for openBIS"),
        ({"code": "NEW_THING", "data_type": "STRING"}, "invalid", "unsupported data type"),
        ({"code": "NEW_THING", "data_type": "OBJECT"}, "invalid", "range is required"),
        ({"code": "NEW_THING", "data_type": "OBJECT", "range": f"{VOCABULARIES}.ShortRngOrd"}, "invalid", "is a vocabulary"),
        ({"code": "NEW_THING", "data_type": "CONTROLLEDVOCABULARY", "range": f"{BAM}.Bam"}, "invalid", "not a vocabulary"),
        # A code names one openBIS property type, with one data type.
        ({"code": "CALIBRATION_DATE", "data_type": "VARCHAR", "name": "other_date"}, "invalid", "already used"),
        # The derived attribute name already exists.
        ({"code": "CALIBRATION_DATE", "data_type": "DATE"}, "exists", "already has"),
        # Inherited by the class.
        ({"code": "NAME", "data_type": "VARCHAR"}, "exists", "already has"),
    ):
        error = session.refuse("add_attribute", owner, **payload)
        assert error.reason == reason and words in error.detail, (payload, error)
    assert session.refuse("add_attribute", f"{VOCABULARIES}.ShortRngOrd", code="X", data_type="VARCHAR").reason == "invalid"
    # Reusing a code with the same type is fine (one property type, assigned twice).
    date = session.schema["classes"][owner]["attributes"]["calibration_date"]
    assert json.loads(date["annotations"]["source_annotations"])["data_type"] == "DATE"
    session.edit("add_attribute", f"{BAM}.Person", code="CALIBRATION_DATE", data_type="DATE")


def test_bam_vocabulary_terms(converted):
    session = Session(converted, "bam-masterdata")
    vocabulary = f"{VOCABULARIES}.ShortRngOrd"
    session.edit("add_enum_value", vocabulary, value="CHAIN_LIKE", label="Chain-like", description="Chains.",
                 description_de="Ketten.")
    graph_result = graph.build_graph(session.schema, {"modules": [{"name": VOCABULARIES, "classes": [vocabulary]}]},
                                     VOCABULARIES)
    term = {node["id"]: node for node in graph_result["nodes"]}[f"{vocabulary}.chain_like"]
    assert {key: term[key] for key in ("dtype", "code", "title", "doc", "doc_de")} == {
        "dtype": "VOCAB_TERM", "code": "CHAIN_LIKE", "title": "Chain-like", "doc": "Chains.", "doc_de": "Ketten.",
    }
    assert edits.term_value(session.schema, vocabulary, "chain_like") == "CHAIN_LIKE"
    assert session.refuse("add_enum_value", vocabulary, value="chain").reason == "invalid"
    assert session.refuse("add_enum_value", vocabulary, value="X" * 51).reason == "invalid"
    assert session.refuse("add_enum_value", vocabulary, value="CHAIN_LIKE").reason == "exists"
    assert session.refuse("add_enum_value", f"{BAM}.Bam", value="X").reason == "invalid"
    session.edit("set_description", vocabulary, value="CHAIN_LIKE", description="Chain structures.")
    session.edit("remove_enum_value", vocabulary, value="CHAIN_LIKE")
    assert "CHAIN_LIKE" not in session.schema["enums"][f"{vocabulary}.terms"]["permissible_values"]
    # A vocabulary a property uses cannot be removed.
    error = session.refuse("remove_class", vocabulary)
    assert error.reason == "in_use" and "Amorphous.atom_short_rng_ord refers to it" in error.detail


# -------- replay --------

def test_replay_gives_the_same_schema_and_reports_conflicts_across_commits(converted):
    session = Session(converted, "nomad-simulations", commit="c1")
    owner = f"{SIM}.ModelMethod"
    session.edit("add_class", name="Added", is_a=owner)
    session.edit("add_attribute", f"{SIM}.Added", name="extra", kind="quantity", dtype="str")
    session.edit("set_description", owner, description="Mine.")
    session.edit("rename_class", f"{SIM}.DFT", new_name="DensityFunctional")

    # Same commit: the stored edits rebuild exactly the edited schema.
    replayed, applied, conflicts = edits.apply_edits(session.source, session.stored, rules="nomad", commit="c1")
    assert replayed == session.schema and len(applied) == 4 and conflicts == []
    assert session.source == converted["nomad-simulations"][1]  # the snapshot itself is never changed

    # A new commit that changed what the edits touch.
    upstream = copy.deepcopy(session.source)
    upstream["classes"][owner]["description"] = "Rewritten upstream."
    upstream["classes"][f"{SIM}.Added"] = {"name": f"{SIM}.Added", "title": "Added"}
    del upstream["classes"][f"{SIM}.DFT"]
    for cls in upstream["classes"].values():
        if cls.get("is_a") == f"{SIM}.DFT":
            cls["is_a"] = owner
    replayed, applied, conflicts = edits.apply_edits(upstream, session.stored, rules="nomad", commit="c2")
    assert [(c["edit"]["op"], c["reason"], c["applied"]) for c in conflicts] == [
        ("add_class", "exists", False),
        ("set_description", "changed_upstream", True),
        ("rename_class", "not_found", False),
    ]
    # The quantity still lands on the class the source now has under that name.
    assert "extra" in replayed["classes"][f"{SIM}.Added"]["attributes"]
    assert replayed["classes"][owner]["description"] == "Mine."
    # Unchanged source on a new commit: no report.
    _, _, conflicts = edits.apply_edits(session.source, session.stored, rules="nomad", commit="c2")
    assert conflicts == []


def test_prepare_is_checked_and_complete(converted):
    session = Session(converted, "bam-masterdata")
    edit = session.edit("add_attribute", f"{BAM}.Calibration", code="CALIBRATION_NOTE", data_type="VARCHAR")
    assert edit == {
        "op": "add_attribute", "target": f"{BAM}.Calibration",
        "payload": {"code": "CALIBRATION_NOTE", "data_type": "VARCHAR", "name": "calibration_note"},
        "profile": "bam-masterdata", "commit": "c1",
    }
    json.dumps(edit)  # plain data, ready for any store


def test_rules_summary():
    assert [dtype["name"] for dtype in edits.rules_summary("nomad")["dtypes"]] == list(edits.NOMAD_DTYPES)
    bam = edits.rules_summary("bam-masterdata")
    assert {dtype["name"] for dtype in bam["dtypes"] if dtype["needs_range"]} == {"OBJECT", "CONTROLLEDVOCABULARY"}
    with pytest.raises(EditError):
        edits.rules_summary("other")


# -------- export round trip --------

@pytest.mark.parametrize("profile", list(RULES))
def test_export_round_trip(converted, profile):
    from linkml_runtime.utils.schemaview import SchemaView

    session = Session(converted, profile)
    if profile == "bam-masterdata":
        session.edit("add_class", code="CALIBRATION.FIELD", is_a=f"{BAM}.Calibration")
        session.edit("add_attribute", f"{BAM}.Field", code="FIELD_NOTE", data_type="VARCHAR", mandatory=True)
        session.edit("add_enum_value", f"{VOCABULARIES}.ShortRngOrd", value="CHAIN_LIKE")
        added, attribute, enum = f"{BAM}.Field", "field_note", f"{VOCABULARIES}.ShortRngOrd.terms"
    else:
        package = PACKAGE[profile]
        base = session.module_class()
        session.edit("add_class", name="Added", is_a=base)
        session.edit("add_attribute", f"{package}.Added", name="extra", kind="quantity", dtype="int32")
        enum = next(iter(session.schema["enums"]))
        session.edit("add_enum_value", enum, value="added_value")
        added, attribute = f"{package}.Added", "extra"
    text = dump_yaml(session.schema, profile=profile, source={"name": profile}, tools={}, edited=True)
    assert text.startswith("# LinkML schema exported by schema-studio (with edits)\n")
    view = SchemaView(yaml.safe_load(text) and text)
    assert view.get_class(added) is not None
    induced = {str(slot.name): slot for slot in view.class_induced_slots(added)}
    assert attribute in induced
    if profile == "bam-masterdata":
        assert induced[attribute].required is True
    assert ("CHAIN_LIKE" if profile == "bam-masterdata" else "added_value") in view.get_enum(enum).permissible_values

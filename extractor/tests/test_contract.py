"""Validation of extraction documents (`extractor/contract.py`)."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from extractor.contract import CONTRACT_VERSION, ContractError, read_document, validate_document
from extractor.runner import ExtractorError, run_script

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

VALID = {
    "contract_version": CONTRACT_VERSION,
    "source": {
        "name": "example-schema",
        "version": "1.0",
        "module": "example",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "dependencies": {"nomad-lab": "1.4.3"},
    },
    "modules": [{"name": "example.alpha", "classes": ["example.alpha.Child"]}],
    "classes": [
        {
            "id": "example.alpha.Base",
            "name": "Base",
            "bases": [],
            "attributes": [
                {"name": "label", "kind": "quantity", "range": {"kind": "datatype", "name": "str"},
                 "annotations": {"display_dtype": "m_str(str)", "display_shape": "[]"}},
            ],
            "effective_attributes": [{"name": "label", "kind": "quantity", "declaring_class_id": "example.alpha.Base"}],
        },
        {
            "id": "example.alpha.Child",
            "name": "Child",
            "description": "A child.",
            "bases": ["example.alpha.Base"],
            "attributes": [
                {"name": "mode", "kind": "quantity", "range": {"kind": "enum", "name": "example.alpha.Child.mode"}},
                {"name": "parts", "kind": "subsection", "range": {"kind": "class", "name": "example.alpha.Base"},
                 "repeats": True, "annotations": {"display_card": "0..*"}},
            ],
            "effective_attributes": [
                {"name": "label", "kind": "quantity", "declaring_class_id": "example.alpha.Base"},
                {"name": "mode", "kind": "quantity", "declaring_class_id": "example.alpha.Child"},
                {"name": "parts", "kind": "subsection", "declaring_class_id": "example.alpha.Child"},
            ],
            "annotations": {"source_file": "example/alpha.py", "source_line": 12},
            "methods": [{"name": "check", "module": "example.alpha"}],
        },
    ],
    "enums": [{"id": "example.alpha.Child.mode", "values": ["a", {"value": "b", "description": "B"}]}],
    "usage": {
        "example.alpha.Child": [
            {"kind": "normalize_method", "qualname": "example.alpha.Child.normalize",
             "module": "example.alpha", "short_name": "normalize", "doc": "Normalize."},
        ],
    },
    "report": [{"path": "example.alpha.Other", "status": "skipped", "reason": "not readable"}],
}


def _document(change=None) -> dict:
    document = copy.deepcopy(VALID)
    if change:
        change(document)
    return document


def _child(document: dict) -> dict:
    return document["classes"][1]


def test_a_complete_document_is_valid():
    assert validate_document(_document()) == VALID


def test_the_added_fields_are_optional():
    def strip(document):
        for key in ("modules", "usage"):
            del document[key]
        del document["source"]["commit"]
        del _child(document)["methods"]
        del _child(document)["annotations"]

    validate_document(_document(strip))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.update(contract_version="1.2"), "contract_version"),
        (lambda d: d["source"].pop("dependencies"), "dependencies"),
        (lambda d: _child(d).pop("effective_attributes"), "effective_attributes"),
        (lambda d: d.update(extra=True), "extra"),
        (lambda d: _child(d)["attributes"][0].update(kind="field"), "field"),
        (lambda d: _child(d)["annotations"].update(nested={"a": 1}), "nested"),
        (lambda d: d["usage"]["example.alpha.Child"][0].update(kind="other"), "other"),
        (lambda d: d["usage"]["example.alpha.Child"][0].update(doc=None), "doc"),
        (lambda d: _child(d)["methods"][0].pop("module"), "module"),
    ],
)
def test_shape_errors_are_reported_with_their_path(change, message):
    with pytest.raises(ContractError, match=message):
        validate_document(_document(change))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d["classes"].append(copy.deepcopy(d["classes"][0])), r"\$\.classes\[2\]: duplicate identifier"),
        (lambda d: d["enums"].append(copy.deepcopy(d["enums"][0])), r"\$\.enums\[1\]: duplicate identifier"),
        (lambda d: d["enums"][0]["values"].append({"value": "a"}), r"\$\.enums\[0\]\.values\[2\]: duplicate"),
        (lambda d: _child(d)["bases"].append("example.alpha.Missing"), r"bases\[1\]: unknown class"),
        (lambda d: _child(d)["bases"].append("example.alpha.Base"), r"bases\[1\]: duplicate"),
        (lambda d: _child(d)["attributes"].append(copy.deepcopy(_child(d)["attributes"][0])), r"attributes\[2\]: duplicate"),
        (lambda d: _child(d)["attributes"][1]["range"].update(name="example.alpha.Missing"), r"attributes\[1\]\.range\.name: unknown class"),
        (lambda d: _child(d)["attributes"][0]["range"].update(name="missing.enum"), r"attributes\[0\]\.range\.name: unknown enum"),
        (lambda d: _child(d)["attributes"][1].pop("repeats"), "subsection requires class range and repeats"),
        (lambda d: _child(d)["attributes"][1].update(range={"kind": "datatype", "name": "str"}), "subsection requires class range"),
        (lambda d: _child(d)["effective_attributes"][0].update(declaring_class_id="example.alpha.Child"), r"effective_attributes\[0\]: no matching local quantity"),
        (lambda d: _child(d)["effective_attributes"][2].update(kind="quantity"), r"effective_attributes\[2\]: no matching local quantity"),
        (lambda d: _child(d)["effective_attributes"].append(copy.deepcopy(_child(d)["effective_attributes"][0])), r"effective_attributes\[3\]: duplicate"),
        (lambda d: _child(d)["methods"].append({"name": "check", "module": "elsewhere"}), r"methods\[1\]: duplicate"),
        (lambda d: d["modules"][0]["classes"].append("example.alpha.Missing"), r"\$\.modules\[0\]\.classes\[1\]: unknown class"),
        (lambda d: d["modules"].append(copy.deepcopy(d["modules"][0])), r"\$\.modules\[1\]: duplicate"),
        (lambda d: d["modules"][0].update(aliases={"Kid": "example.alpha.Parent"}), r"\$\.modules\[0\]\.aliases\.Kid: .* is not a class of the module"),
        (lambda d: d["usage"].update({"example.alpha.Missing": []}), r"\$\.usage: unknown class"),
    ],
)
def test_cross_reference_errors_are_reported_with_their_path(change, message):
    with pytest.raises(ContractError, match=message):
        validate_document(_document(change))


def test_read_document_rejects_duplicate_keys_and_non_finite_numbers():
    text = json.dumps(VALID)
    assert read_document(text) == VALID

    with pytest.raises(ContractError, match="duplicate JSON key 'report'"):
        read_document(text[:-1] + ', "report": []}')
    with pytest.raises(ContractError, match="invalid JSON number NaN"):
        read_document(text.replace('"source_line": 12', '"source_line": NaN'))
    with pytest.raises(ContractError, match="non-finite JSON number 1e999"):
        read_document(text.replace('"source_line": 12', '"source_line": 1e999'))
    with pytest.raises(ContractError, match="invalid JSON at line 1"):
        read_document(text[:-1])


def test_fake_script_hands_a_document_through_the_runner(fake_environment, tmp_path):
    path = tmp_path / "document.json"
    path.write_text(json.dumps(VALID), encoding="utf-8")

    payload = run_script(fake_environment, SCRIPTS / "fake.py", arguments=(str(path),))

    assert payload["ok"] is True
    assert validate_document(payload["result"]) == VALID


def test_fake_script_reports_a_missing_document(fake_environment, tmp_path):
    with pytest.raises(ExtractorError) as exc:
        run_script(fake_environment, SCRIPTS / "fake.py", arguments=(str(tmp_path / "absent.json"),))

    assert json.loads(exc.value.stdout)["error"]["type"] == "FileNotFoundError"


@pytest.mark.parametrize("name", ["nomad-simulations", "nomad-measurements"])
def test_stored_snapshot_fixtures_are_valid(name):
    path = FIXTURES / f"{name}.json"
    document = read_document(path.read_text(encoding="utf-8"))

    assert document["source"]["name"] == name
    assert len(document["source"]["commit"]) == 40

"""`extractor/scripts/legacy.py`, started through the runner like the app does."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from extractor.runner import ExtractorError, run_script

LEGACY_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "legacy.py"


@pytest.fixture()
def source_root(tmp_path: Path) -> Path:
    """A small NOMAD-like package tree; sections are recognized by `m_def`."""
    files = {
        "pkg/__init__.py": "",
        "pkg/schema/__init__.py": "",
        "pkg/schema/alpha.py": """
print("schema imports may print to stdout")


class Quantity:
    def __init__(self, type):
        self.type = type


class Base:
    m_def = object()


class SchemaClass(Base):
    m_def = object()
    quantities = {"name": Quantity(str)}
""",
        "pkg/schema/support.py": "HELPER = 1\n",
        "pkg/schema/broken.py": "import support_dep\n",
        "pkg/schema/nested/__init__.py": "",
        "pkg/schema/nested/beta.py": "class Other:\n    m_def = object()\n",
    }
    root = tmp_path / "worktree" / "src"
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return root


def _run(environment, source_root: Path, command: str, **arguments):
    payload = run_script(
        environment,
        LEGACY_SCRIPT,
        arguments=("--source-root", str(source_root), command, json.dumps(arguments)),
    )
    assert payload["ok"] is True
    return payload["result"]


def test_catalog_lists_only_modules_with_sections(fake_environment, source_root):
    result = _run(fake_environment, source_root, "catalog", base="pkg.schema", discovery=["walk"])

    assert result["modules"] == [
        {"package": "pkg.schema.alpha", "sections": ["Base", "SchemaClass"]},
        {"package": "pkg.schema.nested.beta", "sections": ["Other"]},
    ]
    assert [item["module"] for item in result["skipped"]] == ["pkg.schema.broken"]
    assert "support_dep" in result["skipped"][0]["error"]


def test_catalog_of_unknown_namespace_is_empty(fake_environment, source_root):
    result = _run(fake_environment, source_root, "catalog", base="not_there", discovery=["walk"])

    assert result["modules"] == []


def test_entry_point_discovery_without_nomad_plugins_finds_nothing(fake_environment, source_root):
    result = _run(fake_environment, source_root, "catalog", base="pkg.schema", dist="pkg", discovery=["entry-points"])

    assert result["modules"] == []


def test_sections_and_graph_match_the_in_process_extractor(fake_environment, source_root):
    assert _run(fake_environment, source_root, "sections", package="pkg.schema.alpha") == ["Base", "SchemaClass"]

    graph = _run(
        fake_environment,
        source_root,
        "graph",
        package="pkg.schema.alpha",
        root="SchemaClass",
        base_namespace="pkg.schema",
        include_quantities=True,
        include_subsections=True,
        include_inheritance=True,
        allow_cross_module=True,
    )

    assert graph["package"] == "pkg.schema.alpha"
    assert graph["root"] == "SchemaClass"
    ids = {node["id"]: node["kind"] for node in graph["nodes"]}
    assert ids["pkg.schema.alpha.SchemaClass"] == "section"
    assert ids["pkg.schema.alpha.Base"] == "section"
    assert "quantity" in ids.values()
    assert {"source": "pkg.schema.alpha.SchemaClass", "target": "pkg.schema.alpha.Base", "type": "inherits", "card": None} in graph["edges"]


def test_usage_of_a_class_without_normalizers_is_empty(fake_environment, source_root):
    assert _run(fake_environment, source_root, "usage", section_id="pkg.schema.alpha.SchemaClass") == []


def test_errors_are_one_json_document_with_the_exception_type(fake_environment, source_root):
    with pytest.raises(ExtractorError) as exc:
        run_script(
            fake_environment,
            LEGACY_SCRIPT,
            arguments=("--source-root", str(source_root), "sections", json.dumps({"package": "pkg.schema.missing"})),
        )

    payload = json.loads(exc.value.stdout)
    assert payload["ok"] is False
    assert payload["error"]["type"] == "ModuleNotFoundError"
    assert payload["error"]["name"] == "pkg.schema.missing"
    assert "Traceback" in exc.value.stderr


def test_info_of_a_package_that_is_not_installed_fails(fake_environment, source_root):
    with pytest.raises(ExtractorError) as exc:
        run_script(fake_environment, LEGACY_SCRIPT, arguments=("info", json.dumps({"dist": "surely-not-installed-dist"})))

    assert json.loads(exc.value.stdout)["error"]["type"] == "PackageNotFoundError"

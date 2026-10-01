from __future__ import annotations

from pathlib import Path

import pytest

from extractor.runner import EnvironmentMissing, ExtractorEnvironment, ExtractorError, run_script


def _script(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "script.py"
    path.write_text(body)
    return path


def test_returns_the_json_document_from_stdout(fake_environment, tmp_path):
    script = _script(tmp_path, "import json, sys\nprint('noise', file=sys.stderr)\nprint(json.dumps({'args': sys.argv[1:]}))\n")

    assert run_script(fake_environment, script, arguments=("a", "b")) == {"args": ["a", "b"]}


def test_runs_isolated_from_pythonpath_and_the_script_folder(fake_environment, tmp_path, monkeypatch):
    (tmp_path / "leaked.py").write_text("")
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    script = _script(
        tmp_path,
        "import importlib.util, json, sys\n"
        "print(json.dumps({'leaked': importlib.util.find_spec('leaked') is not None, 'isolated': bool(sys.flags.isolated)}))\n",
    )

    assert run_script(fake_environment, script) == {"leaked": False, "isolated": True}


def test_missing_environment_is_not_replaced_by_the_app_interpreter(tmp_path):
    environment = ExtractorEnvironment(name="absent", directory=tmp_path / "absent")
    script = _script(tmp_path, "print('{}')\n")

    with pytest.raises(EnvironmentMissing) as exc:
        run_script(environment, script)

    assert "absent" in str(exc.value)


def test_failed_script_keeps_its_output_for_the_caller(fake_environment, tmp_path):
    script = _script(tmp_path, "import sys\nprint('{\"ok\": false}')\nprint('details', file=sys.stderr)\nsys.exit(3)\n")

    with pytest.raises(ExtractorError) as exc:
        run_script(fake_environment, script)

    assert exc.value.returncode == 3
    assert exc.value.stdout.strip() == '{"ok": false}'
    assert "details" in exc.value.stderr


def test_timeout_and_invalid_output_are_reported(fake_environment, tmp_path):
    slow = _script(tmp_path, "import time\ntime.sleep(30)\n")
    with pytest.raises(ExtractorError, match="timed out"):
        run_script(fake_environment, slow, timeout=0.5)

    noisy = _script(tmp_path, "print('not json')\n")
    with pytest.raises(ExtractorError, match="valid JSON"):
        run_script(fake_environment, noisy)

    with pytest.raises(ExtractorError, match="does not exist"):
        run_script(fake_environment, tmp_path / "nowhere.py")

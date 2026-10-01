from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def schema_source_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.delenv("SCHEMA_STUDIO_PACKAGED_BACKEND", raising=False)
    monkeypatch.delenv("SCHEMA_STUDIO_LIGHT_SCHEMA_PROFILE", raising=False)
    monkeypatch.delenv("SCHEMA_STUDIO_DEFAULT_PACKAGE", raising=False)
    monkeypatch.setenv("SCHEMA_STUDIO_ENVIRONMENTS_DIR", str(tmp_path / "environments"))
    import api.light_mode.schema_source as schema_source

    return importlib.reload(schema_source)


def _git_install(repo: str, revision: str, commit: str = "c0ffee") -> dict:
    return {
        "version": "1.2.3",
        "direct_url": {"url": repo, "vcs_info": {"vcs": "git", "commit_id": commit, "requested_revision": revision}},
    }


def test_missing_environment_is_reported_with_setup_instructions(schema_source_module):
    profile = schema_source_module.schema_profile_for_key("bam-masterdata")

    assert not schema_source_module.schema_available(profile)
    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module.current_schema_info(profile)

    message = str(exc.value)
    assert "not set up" in message
    assert f"uv sync --project {profile.environment.directory}" in message


def test_schema_info_reports_commit_of_tracked_branch(schema_source_module):
    profile = schema_source_module.schema_profile_for_key("nomad-measurements")
    payload = _git_install("https://github.com/FAIRmat-NFDI/nomad-measurements", "main")

    info = schema_source_module._schema_info_from_payload(profile, payload)

    assert info.version == "c0ffee"
    assert info.commit == "c0ffee"
    assert info.package_version == "1.2.3"
    assert info.source == "remote-main"


def test_schema_info_without_install_origin_uses_package_version(schema_source_module):
    profile = schema_source_module.schema_profile_for_key("bam-masterdata")

    info = schema_source_module._schema_info_from_payload(profile, {"version": "0.14.0", "direct_url": None})

    assert info.version == "0.14.0"
    assert info.commit is None
    assert info.source == "installed"


@pytest.mark.parametrize(
    "payload, expected",
    [
        ({"version": "1", "direct_url": {"url": "file:///home/me/nomad-simulations"}}, "does not support local"),
        (_git_install("https://github.com/someone/fork.git", "develop"), "must use repository"),
        (_git_install("https://github.com/nomad-coe/nomad-simulations.git", "my-branch"), "pinned to remote develop"),
    ],
)
def test_schema_info_rejects_installs_outside_the_profile_policy(schema_source_module, payload, expected):
    profile = schema_source_module.schema_profile_for_key("nomad-simulations")

    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module._schema_info_from_payload(profile, payload)

    assert expected in str(exc.value)


def test_schema_info_is_read_through_the_runner_and_cached(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    profile = schema_source_module.schema_profile_for_key("bam-masterdata")
    calls = []

    def fake_run_script(environment, script, *, arguments, timeout):
        calls.append((environment.name, script.name, arguments))
        return {"ok": True, "result": _git_install("https://github.com/BAMresearch/bam-masterdata.git", "main")}

    monkeypatch.setattr(schema_source_module, "run_script", fake_run_script)

    first = schema_source_module.current_schema_info(profile)
    second = schema_source_module.current_schema_info(profile)

    assert first.version == second.version == "c0ffee"
    assert calls == [("bam-masterdata", "legacy.py", ("info", '{"dist": "bam-masterdata"}'))]


def test_update_needs_uv_and_never_uses_the_app_interpreter(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    profile = schema_source_module.schema_profile_for_key("bam-masterdata")
    profile.environment.directory.mkdir(parents=True)
    (profile.environment.directory / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    monkeypatch.setattr(schema_source_module.shutil, "which", lambda _name: None)
    monkeypatch.setattr(
        schema_source_module.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail("no command may run without uv"),
    )

    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module.update_schema(profile)

    assert "`uv`" in str(exc.value)


def test_update_runs_uv_in_the_profile_environment(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    profile = schema_source_module.schema_profile_for_key("bam-masterdata")
    profile.environment.directory.mkdir(parents=True)
    (profile.environment.directory / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    commands = []

    class Done:
        returncode = 0
        stdout = stderr = ""

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        assert "VIRTUAL_ENV" not in kwargs["env"]
        return Done()

    monkeypatch.setenv("VIRTUAL_ENV", "/somewhere/app/.venv")
    monkeypatch.setattr(schema_source_module.shutil, "which", lambda _name: "/usr/bin/uv")
    monkeypatch.setattr(schema_source_module.subprocess, "run", fake_run)
    monkeypatch.setattr(
        schema_source_module,
        "run_script",
        lambda *args, **kwargs: {"ok": True, "result": _git_install("https://github.com/BAMresearch/bam-masterdata.git", "main")},
    )

    info = schema_source_module.update_schema(profile)

    project = str(profile.environment.directory)
    assert commands == [
        ["/usr/bin/uv", "lock", "--upgrade-package", "bam-masterdata", "--project", project],
        ["/usr/bin/uv", "sync", "--project", project],
    ]
    assert info.version == "c0ffee"


def test_packaged_backend_has_no_schema_environments(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SCHEMA_STUDIO_PACKAGED_BACKEND", "1")

    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module.current_schema_info()

    assert "not bundled" in str(exc.value)


def test_packaged_backend_rejects_runtime_schema_update(schema_source_module, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SCHEMA_STUDIO_PACKAGED_BACKEND", "1")

    with pytest.raises(schema_source_module.SchemaUnavailable) as exc:
        schema_source_module.update_schema()

    assert "disabled in the packaged desktop build" in str(exc.value)

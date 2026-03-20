from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
DIST_DIR = WEB_DIR / "dist"
TAURI_BIN_DIR = WEB_DIR / "src-tauri" / "binaries"
ENTRYPOINT = ROOT / "scripts" / "tauri_light_mode_backend_entry.py"
BACKEND_NAME = "schema-studio-backend"


def host_triple() -> str:
    result = subprocess.run(
        ["rustc", "--print", "host-tuple"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()

    fallback = subprocess.run(
        ["rustc", "-vV"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=True,
    )
    for line in fallback.stdout.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    raise RuntimeError("Could not determine rust host target triple.")


def ensure_pyinstaller() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "PyInstaller is required for Windows packaging.\n"
            "Install it in your active environment, e.g.:\n"
            "  python -m pip install pyinstaller"
        ) from exc


def ensure_frontend_dist() -> None:
    if (DIST_DIR / "index.html").exists():
        return
    raise SystemExit(
        "Missing web/dist/index.html.\n"
        "Build the Light Mode frontend first, e.g.:\n"
        "  cd web\n"
        "  VITE_LIGHT_MODE=true npm run build"
    )


def output_binary_path(target_triple: str) -> Path:
    suffix = ".exe" if sys.platform.startswith("win") else ""
    return TAURI_BIN_DIR / f"{BACKEND_NAME}-{target_triple}{suffix}"


def pyinstaller_command(target_triple: str, workdir: Path) -> list[str]:
    distpath = workdir / "dist"
    workpath = workdir / "build"
    specpath = workdir / "spec"
    return [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        BACKEND_NAME,
        "--distpath",
        str(distpath),
        "--workpath",
        str(workpath),
        "--specpath",
        str(specpath),
        "--collect-submodules",
        "api",
        "--collect-submodules",
        "extractor",
        "--collect-all",
        "nomad_simulations",
        "--collect-all",
        "uvicorn",
        "--collect-all",
        "fastapi",
        "--collect-all",
        "httpx",
        "--collect-all",
        "platformdirs",
        "--add-data",
        f"{DIST_DIR}{os.pathsep}light_mode_static",
        str(ENTRYPOINT),
    ]


def main() -> None:
    ensure_pyinstaller()
    ensure_frontend_dist()
    TAURI_BIN_DIR.mkdir(parents=True, exist_ok=True)
    target_triple = host_triple()
    out_path = output_binary_path(target_triple)

    with tempfile.TemporaryDirectory(prefix="schema-studio-backend-") as tmp:
        workdir = Path(tmp)
        cmd = pyinstaller_command(target_triple, workdir)
        print("Running:", " ".join(cmd))
        subprocess.run(cmd, cwd=ROOT, check=True)

        built = workdir / "dist" / (BACKEND_NAME + (".exe" if sys.platform.startswith("win") else ""))
        if not built.exists():
            raise SystemExit(f"PyInstaller did not produce expected output: {built}")
        shutil.copy2(built, out_path)

    print(f"Built backend sidecar: {out_path}")


if __name__ == "__main__":
    main()

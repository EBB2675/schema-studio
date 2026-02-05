#!/bin/sh
set -e

schema_repo_path="${SCHEMA_UML_REPO:-/schema-repo}"
schema_data_dir="${SCHEMA_UML_DATA_DIR:-/schema-data}"
install_deps="${SCHEMA_UML_INSTALL_SCHEMA_DEPS:-true}"

# Allow git operations on the mounted schema repo even if ownership differs inside the container.
git config --global --add safe.directory "${schema_repo_path}" >/dev/null 2>&1 || true
git config --global --add safe.directory "${schema_repo_path}/.git" >/dev/null 2>&1 || true

if [ -d "${schema_repo_path}/src" ]; then
  export PYTHONPATH="${schema_repo_path}/src:${PYTHONPATH}"
fi

if [ "$install_deps" = "true" ] && [ -f "${schema_repo_path}/pyproject.toml" ]; then
  dep_hash="$(python - <<PY
import hashlib
import sys
from pathlib import Path

data = Path("${schema_repo_path}/pyproject.toml").read_bytes()
h = hashlib.sha256()
h.update(data)
h.update(sys.version.encode())
print(h.hexdigest()[:16])
PY
)"
  marker_file="/tmp/schema_deps_installed_${dep_hash}"
  if [ ! -f "${marker_file}" ]; then
    echo "Installing schema repo dependencies from ${schema_repo_path}..."
deps="$(python - <<PY
import tomllib
from pathlib import Path

data = tomllib.loads(Path("${schema_repo_path}/pyproject.toml").read_text())
deps = data.get("project", {}).get("dependencies", [])
print("\n".join(deps))
PY
)"
    if [ -n "${deps}" ]; then
      pip install --no-cache-dir ${deps}
    fi
    mkdir -p "${schema_data_dir}"
    touch "${marker_file}"
  fi
fi

exec "$@"

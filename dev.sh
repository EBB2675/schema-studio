#!/usr/bin/env bash
# Unified dev runner for backend (FastAPI) + frontend (Vite)
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-5179}"
WEB_PORT="${WEB_PORT:-5173}"
DEFAULT_SCHEMA_REPO="${HOME}/src/nomad-simulations"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' not found. Please install it (or activate your virtualenv) and retry." >&2
    exit 1
  fi
}

need_cmd uvicorn
need_cmd npm

resolve_schema_repo() {
  # Mirrors api/settings.py resolution order
  local candidate
  for var in SCHEMA_UML_REPO NOMAD_SIM_REPO GIT_REPO_DIR; do
    candidate=${!var-}
    if [[ -n "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  echo "${DEFAULT_SCHEMA_REPO}"
}

validate_schema_repo() {
  local repo_path
  repo_path="$(resolve_schema_repo)"

  if [[ ! -d "${repo_path}" ]]; then
    cat <<EOF
Error: Could not find a schema repository.
- Set one of SCHEMA_UML_REPO / NOMAD_SIM_REPO / GIT_REPO_DIR to a local git clone.
- Current default (${DEFAULT_SCHEMA_REPO}) does not exist.
EOF
    exit 1
  fi

  if [[ ! -d "${repo_path}/.git" && ! -f "${repo_path}/HEAD" ]]; then
    cat <<EOF
Error: '${repo_path}' is not a git repository.
- Point SCHEMA_UML_REPO (or NOMAD_SIM_REPO / GIT_REPO_DIR) to a local clone.
EOF
    exit 1
  fi

  echo "Using schema repo: ${repo_path}"
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    if [[ -n "${pid}" ]] && ps -p "${pid}" > /dev/null 2>&1; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

cd "${ROOT_DIR}"

validate_schema_repo

echo "Starting FastAPI backend on :${API_PORT}..."
uvicorn --app-dir "${ROOT_DIR}" api.main:app --reload --port "${API_PORT}" &
API_PID=$!

echo "Switching to frontend (web/)"
cd "${ROOT_DIR}/web"
if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies (web/node_modules not found)..."
  npm install
fi

echo "Starting Vite frontend on :${WEB_PORT}..."
npm run dev -- --host --port "${WEB_PORT}" &
WEB_PID=$!

cd "${ROOT_DIR}"

echo "Both services launched. Press Ctrl+C to stop."

# Wait until one of the services exits (or the user hits Ctrl+C)
while true; do
  if ! wait -n; then
    echo "A service stopped with a non-zero exit code. Shutting down the stack..."
    break
  fi
  # If we reach here, a service exited cleanly (unlikely during dev); continue waiting.
  if ! ps -p "${API_PID}" >/dev/null 2>&1 || ! ps -p "${WEB_PID}" >/dev/null 2>&1; then
    break
  fi
done


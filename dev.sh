#!/usr/bin/env bash
# Unified dev runner for backend (FastAPI) + frontend (Vite)
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-5179}"
WEB_PORT="${WEB_PORT:-5173}"
DEFAULT_SCHEMA_REPO="${HOME}/src/nomad-simulations"
UVICORN_LOG_LEVEL="${UVICORN_LOG_LEVEL:-warning}"
# Dev-friendly auth defaults (override via env for non-dev)
: "${SCHEMA_UML_ALLOW_INSECURE_DEFAULTS:=true}"
: "${SCHEMA_UML_ENABLE_DEFAULT_ADMIN:=true}"
: "${SCHEMA_UML_DEFAULT_USER:=admin}"
: "${SCHEMA_UML_DEFAULT_PASSWORD:=admin}"
: "${SCHEMA_UML_SECRET:=dev-secret}"
: "${SCHEMA_UML_PW_SALT:=dev-salt}"
# Set START_MONGO_DOCKER=1 to have this script start a local MongoDB container (mongo:7)

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' not found. Please install it (or activate your virtualenv) and retry." >&2
    exit 1
  fi
}

need_cmd git
need_cmd uvicorn
need_cmd npm
start_mongo_docker() {
  if [[ -z "${START_MONGO_DOCKER:-}" ]]; then
    return
  fi
  need_cmd docker
  if docker ps --format '{{.Names}}' | grep -q '^schema-uml-mongo$'; then
    echo "MongoDB container 'schema-uml-mongo' is already running."
    return
  fi
  echo "Starting MongoDB container 'schema-uml-mongo'..."
  docker rm -f schema-uml-mongo >/dev/null 2>&1 || true
  if ! docker run --name schema-uml-mongo -p 27017:27017 -v /tmp/mongo-data:/data/db -d mongo:7 >/dev/null; then
    echo "Failed to start mongo:7 container. Start Mongo manually or check Docker permissions."
    exit 1
  fi
}

# Verify required Python packages are installed before starting uvicorn.
python - <<'PY'
try:
    import jwt  # PyJWT
except ModuleNotFoundError:
    import sys

    sys.stderr.write(
        "Missing dependency: PyJWT is required.\n"
        "Install backend requirements via `pip install -r api/requirements.txt` and retry.\n"
    )
    sys.exit(1)
PY

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

  if ! git -C "${repo_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cat <<EOF
Error: '${repo_path}' is not a git repository.
- Point SCHEMA_UML_REPO (or NOMAD_SIM_REPO / GIT_REPO_DIR) to a local clone (a subdirectory of a clone is fine).
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
start_mongo_docker

echo "Starting FastAPI backend on :${API_PORT}..."
uvicorn --app-dir "${ROOT_DIR}" api.main:app --reload --port "${API_PORT}" --log-level "${UVICORN_LOG_LEVEL}" &
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

# Wait until one of the services exits (or the user hits Ctrl+C). macOS ships with
# Bash 3.x, which lacks `wait -n`, so poll the processes for portability.
status_api=""
status_web=""
while true; do
  if [[ -z "${status_api}" ]] && ! ps -p "${API_PID}" >/dev/null 2>&1; then
    wait "${API_PID}" || status_api=$?
    break
  fi

  if [[ -z "${status_web}" ]] && ! ps -p "${WEB_PID}" >/dev/null 2>&1; then
    wait "${WEB_PID}" || status_web=$?
    break
  fi

  sleep 1
done

if [[ -n "${status_api}" || -n "${status_web}" ]]; then
  echo "A service stopped with a non-zero exit code. Shutting down the stack..."
fi

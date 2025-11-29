#!/usr/bin/env bash
# Unified dev runner for backend (FastAPI) + frontend (Vite)
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-5179}"
WEB_PORT="${WEB_PORT:-5173}"

cleanup() {
  trap - EXIT
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    if [[ -n "${pid}" ]] && ps -p "${pid}" > /dev/null 2>&1; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT

echo "Starting FastAPI backend on :${API_PORT}..."
uvicorn --app-dir "${ROOT_DIR}" api.main:app --reload --port "${API_PORT}" &
API_PID=$!

cd "${ROOT_DIR}/web"
if [[ ! -d node_modules ]]; then
  echo "Installing frontend dependencies (web/node_modules not found)..."
  npm install
fi

echo "Starting Vite frontend on :${WEB_PORT}..."
npm run dev -- --host --port "${WEB_PORT}" &
WEB_PID=$!

cd "${ROOT_DIR}"

# Wait until one of the services exits (or the user hits Ctrl+C)
if ! wait -n; then
  echo "A service stopped with a non-zero exit code. Shutting down the stack..."
fi

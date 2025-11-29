#!/usr/bin/env bash
# Unified dev runner for backend (FastAPI) + frontend (Vite)
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-5179}"
WEB_PORT="${WEB_PORT:-5173}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' not found. Please install it (or activate your virtualenv) and retry." >&2
    exit 1
  fi
}

need_cmd uvicorn
need_cmd npm

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


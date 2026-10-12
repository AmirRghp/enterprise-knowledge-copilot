#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PIDS=()

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  printf 'run.sh requires Bash 4.3 or newer.\n' >&2
  exit 1
fi

stop_services() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}

trap stop_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  printf 'Missing %s/.env. Copy .env.example and configure it first.\n' "$ROOT_DIR" >&2
  exit 1
fi

for command in uv npm node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

printf 'Preparing Python dependencies, embedding provider, and database schema...\n'
(
  cd "$ROOT_DIR/apps/api"
  uv sync --locked
  uv run --locked python -m app.cli.preflight_embedding
  DB_NAME=enterprise_knowledge_copilot uv run --locked alembic upgrade head
)

if [[ ! -d "$ROOT_DIR/apps/web/node_modules" ]]; then
  printf 'Installing web dependencies...\n'
  (cd "$ROOT_DIR/apps/web" && npm ci)
fi

printf 'Starting API, web app, and ingestion worker. Press Ctrl+C to stop all three.\n'
(
  cd "$ROOT_DIR/apps/api"
  exec env DB_NAME=enterprise_knowledge_copilot uv run --locked python -m app
) &
PIDS+=("$!")
(
  cd "$ROOT_DIR/apps/web"
  exec npm run dev
) &
PIDS+=("$!")
(
  cd "$ROOT_DIR/apps/api"
  exec env DB_NAME=enterprise_knowledge_copilot uv run --locked python -m app.cli.run_worker
) &
PIDS+=("$!")

if wait -n "${PIDS[@]}"; then
  printf 'A service stopped; stopping the remaining services.\n' >&2
  exit 1
else
  status=$?
  printf 'A service failed (exit %s); stopping the remaining services.\n' "$status" >&2
  exit "$status"
fi

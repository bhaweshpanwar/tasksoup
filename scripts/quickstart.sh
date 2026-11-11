#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin"
fi

command -v docker >/dev/null 2>&1 || {
  echo "Error: docker is required but not installed." >&2
  exit 1
}

docker compose version >/dev/null 2>&1 || {
  echo "Error: docker compose (v2) is required." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "Error: node is required but not installed." >&2
  exit 1
}

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js version 20+ required (found v${NODE_VERSION})." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  npm ci
fi

export DB_PORT="${DB_PORT:-5433}"

docker compose down -v
docker compose up -d --build --scale worker=8

HEALTH_URL="http://localhost:3000/health"
HEALTH_OK=0
for i in $(seq 1 30); do
  if curl -s -f "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "Error: API /health endpoint did not respond with 200 within 30s." >&2
  exit 1
fi

rm -f data/jobs.log

mkdir -p results/quickstart
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
OUTPUT_FILE="results/quickstart/quickstart-${TIMESTAMP}.txt"

SEED=$(od -vAn -N4 -tu4 < /dev/urandom 2>/dev/null | tr -d '[:space:]')
if [ -z "$SEED" ]; then
  SEED=$RANDOM
fi

CHAOS_SEED="$SEED" JOB_COUNT=500 DB_PORT="${DB_PORT}" node scripts/chaos.js 2>&1 | tee "$OUTPUT_FILE" || true
RUN_EXIT="${PIPESTATUS[0]}"

echo ""
echo "Output saved to: $OUTPUT_FILE"
echo "Stack remains running. Next reviewer steps:"
echo "  1. View logs: docker compose logs worker"
echo "  2. Full 10,000-job run: ./scripts/chaos-run.sh final 5"
echo "  3. Mutation test nofence: ./scripts/mutation-test.sh nofence"
echo "  4. Mutation test naiveclaim: ./scripts/mutation-test.sh naiveclaim"
echo "  5. Reset stack: ./scripts/reset.sh"

exit "$RUN_EXIT"

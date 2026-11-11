#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ] || { [ "$1" != "nofence" ] && [ "$1" != "naiveclaim" ]; }; then
  echo "Usage: ./scripts/mutation-test.sh <nofence|naiveclaim>" >&2
  exit 1
fi

MUTANT="$1"

if ! command -v docker >/dev/null 2>&1; then
  export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin"
fi

command -v docker >/dev/null 2>&1 || {
  echo "Error: docker is required." >&2
  exit 1
}

docker compose version >/dev/null 2>&1 || {
  echo "Error: docker compose (v2) is required." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "Error: node is required." >&2
  exit 1
}

ORIG_DIR="$(pwd)"
PATCH_FILE="${ORIG_DIR}/mutants/${MUTANT}.patch"

if [ ! -f "$PATCH_FILE" ]; then
  echo "Error: patch file not found: $PATCH_FILE" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
MUTANT_PROJECT="tasksoup_mutant_${MUTANT}_$(od -vAn -N4 -tu4 < /dev/urandom 2>/dev/null | tr -d '[:space:]')"
if [ -z "$MUTANT_PROJECT" ]; then
  MUTANT_PROJECT="tasksoup_mutant_${MUTANT}_${RANDOM}"
fi

cleanup() {
  if [ -d "$TMP_DIR" ]; then
    (cd "$TMP_DIR" && docker compose -p "$MUTANT_PROJECT" down -v >/dev/null 2>&1 || true)
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

cp -R . "$TMP_DIR"
rm -f "$TMP_DIR/data/jobs.log"

(cd "$TMP_DIR" && git apply "$PATCH_FILE")

sed -i '' 's/"5433:5432"/"5435:5432"/' "$TMP_DIR/docker-compose.yml" 2>/dev/null || sed -i 's/"5433:5432"/"5435:5432"/' "$TMP_DIR/docker-compose.yml"
sed -i '' 's/"3000:3000"/"3001:3000"/' "$TMP_DIR/docker-compose.yml" 2>/dev/null || sed -i 's/"3000:3000"/"3001:3000"/' "$TMP_DIR/docker-compose.yml"

mkdir -p "${ORIG_DIR}/results/chaos"
RUN_NUM=1
while [ -f "${ORIG_DIR}/results/chaos/mutant-${MUTANT}-run${RUN_NUM}.txt" ]; do
  RUN_NUM=$((RUN_NUM + 1))
done
MUTANT_OUT="${ORIG_DIR}/results/chaos/mutant-${MUTANT}-run${RUN_NUM}.txt"

(cd "$TMP_DIR" && docker compose -p "$MUTANT_PROJECT" up -d --build --scale worker=8 >/dev/null 2>&1)

for i in $(seq 1 30); do
  if curl -s -f http://localhost:3001/health >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Error: mutant API failed to become healthy within 30s" >&2
    exit 2
  fi
  sleep 1
done

SEED=$(od -vAn -N4 -tu4 < /dev/urandom 2>/dev/null | tr -d '[:space:]')
if [ -z "$SEED" ]; then
  SEED=$RANDOM
fi

CHAOS_EXIT=0
(cd "$TMP_DIR" && \
  COMPOSE_PROJECT_NAME="$MUTANT_PROJECT" \
  CHAOS_SEED="$SEED" \
  JOB_COUNT="${JOB_COUNT:-1000}" \
  FREEZE_ENABLED=1 \
  DB_PORT=5435 \
  API_URL="http://localhost:3001" \
  node scripts/chaos.js 2>&1 | tee "$MUTANT_OUT") || CHAOS_EXIT=$?

if [ "$CHAOS_EXIT" -ne 0 ]; then
  echo "Mutation detected: harness caught the defect in '${MUTANT}' (exit code ${CHAOS_EXIT})."
  exit 0
else
  echo "Mutation NOT detected: mutant '${MUTANT}' passed all invariant checks (exit code 0)."
  exit 1
fi

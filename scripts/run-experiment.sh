#!/usr/bin/env bash

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./scripts/run-experiment.sh <label> <jobCount>"
  exit 1
fi

LABEL="$1"
JOB_COUNT="$2"

mkdir -p results

OUTPUT_FILE="results/${LABEL}.txt"
if [ -f "$OUTPUT_FILE" ]; then
  SUFFIX=1
  while [ -f "results/${LABEL}-${SUFFIX}.txt" ]; do
    SUFFIX=$((SUFFIX + 1))
  done
  OUTPUT_FILE="results/${LABEL}-${SUFFIX}.txt"
fi

docker compose down -v
docker compose up -d --build

while true; do
  STATUS_OK=$(curl -s http://localhost:3000/health 2>/dev/null | grep -o '"ok":true' || true)
  if [ "$STATUS_OK" = '"ok":true' ]; then
    break
  fi
  sleep 1
done

rm -f data/jobs.log

node scripts/seed.js "$JOB_COUNT"

START_TIME=$(date +%s)
TIMEOUT=120

while true; do
  ACTIVE_JOBS=$(docker compose exec -T postgres psql -U postgres -d jobs_db -t -A -c "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running');" 2>/dev/null | tr -d '[:space:]')
  if [ "$ACTIVE_JOBS" = "0" ]; then
    break
  fi

  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    break
  fi

  sleep 1
done

REPORT_LABEL="$LABEL" EXPECTED_JOBS="$JOB_COUNT" node scripts/report.js 2>&1 | tee "$OUTPUT_FILE"
REPORT_EXIT_CODE="${PIPESTATUS[0]}"

exit "$REPORT_EXIT_CODE"

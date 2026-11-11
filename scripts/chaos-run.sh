#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  echo "Usage: ./scripts/chaos-run.sh <label> <runs>"
  exit 1
fi

LABEL="$1"
TOTAL_RUNS="$2"

if ! command -v docker >/dev/null 2>&1; then
  export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin"
fi

export DB_PORT="${DB_PORT:-5433}"

mkdir -p results/chaos

SUMMARY_FILE="results/chaos/${LABEL}-summary.txt"

TABLE_ROWS=()

for ((N=1; N<=TOTAL_RUNS; N++)); do
  docker compose down -v
  docker compose up -d --build --scale worker=8

  while true; do
    STATUS_OK=$(curl -s http://localhost:3000/health 2>/dev/null | grep -o '"ok":true' || true)
    if [ "$STATUS_OK" = '"ok":true' ]; then
      break
    fi
    sleep 1
  done

  rm -f data/jobs.log

  OUTPUT_FILE="results/chaos/${LABEL}-run${N}.txt"
  WORKER_LOG_FILE="results/chaos/${LABEL}-run${N}-workers.log"

  if [ -f "$OUTPUT_FILE" ]; then
    SUFFIX=1
    while [ -f "results/chaos/${LABEL}-run${N}-${SUFFIX}.txt" ]; do
      SUFFIX=$((SUFFIX + 1))
    done
    OUTPUT_FILE="results/chaos/${LABEL}-run${N}-${SUFFIX}.txt"
    WORKER_LOG_FILE="results/chaos/${LABEL}-run${N}-${SUFFIX}-workers.log"
  fi

  SEED=$(od -vAn -N4 -tu4 < /dev/urandom 2>/dev/null | tr -d '[:space:]')
  if [ -z "$SEED" ]; then
    SEED=$RANDOM
  fi

  CHAOS_SEED="$SEED" DB_PORT="${DB_PORT}" node scripts/chaos.js 2>&1 | tee "$OUTPUT_FILE" || true
  RUN_EXIT="${PIPESTATUS[0]}"

  docker compose logs worker > "$WORKER_LOG_FILE" 2>/dev/null || true

  RUN_SEED=$(grep -m 1 "^CHAOS_SEED: " "$OUTPUT_FILE" | cut -d' ' -f2 || true)
  if [ -z "$RUN_SEED" ]; then
    RUN_SEED="$SEED"
  fi

  KILLS_LINE=$(grep "^Kills: " "$OUTPUT_FILE" || true)
  TOTAL_KILLS=$(echo "$KILLS_LINE" | sed -n 's/.*total=\([0-9]*\).*/\1/p')
  HIT_RUNNING=$(echo "$KILLS_LINE" | sed -n 's/.*landed_on_running=\([0-9]*\).*/\1/p')

  DURATION_LINE=$(grep "^Duration: " "$OUTPUT_FILE" || true)
  DURATION=$(echo "$DURATION_LINE" | sed -n 's/Duration: \([^,]*\),.*/\1/p')

  TABLE_ROWS+=("$N|$RUN_SEED|$RUN_EXIT|${TOTAL_KILLS:-0}|${HIT_RUNNING:-0}|${DURATION:-0s}")
done

printf "\n%-5s | %-12s | %-9s | %-7s | %-15s | %-10s\n" "Run" "Seed" "Exit Code" "Kills" "Hit Running Job" "Duration"
printf "%s\n" "-----------------------------------------------------------------------------"
{
  printf "\n%-5s | %-12s | %-9s | %-7s | %-15s | %-10s\n" "Run" "Seed" "Exit Code" "Kills" "Hit Running Job" "Duration"
  printf "%s\n" "-----------------------------------------------------------------------------"
} >> "$SUMMARY_FILE"

for row in "${TABLE_ROWS[@]}"; do
  IFS='|' read -r r_num r_seed r_exit r_kills r_hit r_dur <<< "$row"
  LINE=$(printf "%-5s | %-12s | %-9s | %-7s | %-15s | %-10s" "$r_num" "$r_seed" "$r_exit" "$r_kills" "$r_hit" "$r_dur")
  echo "$LINE"
  echo "$LINE" >> "$SUMMARY_FILE"
done
chmod 644 "$SUMMARY_FILE" 2>/dev/null || true

#!/usr/bin/env bash

if [ -z "$1" ]; then
  echo "Usage: ./scripts/freeze-worker.sh <seconds>"
  exit 1
fi

FREEZE_SECONDS="$1"

CONTAINERS=($(docker compose ps -q worker))

if [ ${#CONTAINERS[@]} -eq 0 ]; then
  echo "No worker containers found"
  exit 1
fi

INDEX=$((RANDOM % ${#CONTAINERS[@]}))
TARGET_ID="${CONTAINERS[$INDEX]}"
CONTAINER_NAME=$(docker inspect --format '{{.Name}}' "$TARGET_ID" 2>/dev/null | sed 's/^\///')

if [ -z "$CONTAINER_NAME" ]; then
  CONTAINER_NAME="$TARGET_ID"
fi

echo "Freezing worker: $CONTAINER_NAME for ${FREEZE_SECONDS}s"
docker pause "$TARGET_ID"
sleep "$FREEZE_SECONDS"
docker unpause "$TARGET_ID"
echo "Unpaused worker: $CONTAINER_NAME"

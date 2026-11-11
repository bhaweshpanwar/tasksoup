#!/usr/bin/env bash

CONTAINERS=($(docker compose ps -q worker))

if [ ${#CONTAINERS[@]} -eq 0 ]; then
  echo "No worker containers found"
  exit 1
fi

INDEX=$((RANDOM % ${#CONTAINERS[@]}))
TARGET="${CONTAINERS[$INDEX]}"

docker kill --signal=SIGKILL "$TARGET"
echo "Killed worker container: $TARGET"

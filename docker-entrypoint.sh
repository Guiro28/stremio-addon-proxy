#!/bin/sh
set -e

mkdir -p "$DATA_DIR"
chown node:node "$DATA_DIR"
for file in config.json play.key; do
  if [ -e "$DATA_DIR/$file" ]; then chown node:node "$DATA_DIR/$file"; fi
done

exec su-exec node "$@"

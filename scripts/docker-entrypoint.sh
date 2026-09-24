#!/bin/sh
# Claude Code refuses bypassPermissions as root, so the service runs as `node`. The /data volume may be
# mounted root-owned (and earlier root-run versions left files there), so fix ownership first, then drop.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  find "${DATA_DIR:-/data}" \! -user node -exec chown -h node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node "$@"
fi
exec "$@"

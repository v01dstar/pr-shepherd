#!/usr/bin/env bash
# systemd entry point on an instabox box. Loads the org Secrets (placeholders: the outbound proxy swaps in the real
# values, so neither the bot nor its agents can read them), then the same environment the Dockerfile sets.
set -euo pipefail

SECRETS=/run/instabox/secrets/env
# The guest agent writes this file shortly after boot.
for _ in $(seq 1 60); do [[ -s "$SECRETS" ]] && break; sleep 1; done
set -a
# shellcheck disable=SC1090
source "$SECRETS"
set +a

DATA=/data/shepherd
export DATA_DIR="$DATA" \
  CONFIG_PATH="$DATA/config.yaml" \
  CLAUDE_CONFIG_DIR="$DATA/claude" \
  XDG_CACHE_HOME="$DATA/cache" \
  GOCACHE="$DATA/cache/go-build" \
  GOMODCACHE="$DATA/cache/go-mod" \
  npm_config_cache="$DATA/cache/npm" \
  TMPDIR="$DATA/tmp" \
  NODE_ENV=production \
  DATABASE_URL='postgresql:///pr_shepherd?host=/var/run/postgresql'
[[ -s "$DATA/register-token.sha256" ]] && PR_SHEPHERD_REGISTER_TOKEN_SHA256=$(cat "$DATA/register-token.sha256") && export PR_SHEPHERD_REGISTER_TOKEN_SHA256
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME"

exec node dist/index.js

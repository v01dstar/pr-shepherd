#!/usr/bin/env bash
# Push changed credentials or config to a running deployment, without rebuilding.
# Values come from deploy.env / config.yaml and go to `insta secrets set` on stdin, so they never land in
# argv or shell history. insta restarts the service with the new values.
# Usage: scripts/update-secret.sh <NAME|config>... [--branch <name>] [--env-file <file>] [--config <file>]
#   NAME    GH_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (from the env file)
#   config  the config file, validated and stored as PR_SHEPHERD_CONFIG
#   e.g.    scripts/update-secret.sh GH_TOKEN      scripts/update-secret.sh config
#           scripts/update-secret.sh SLACK_BOT_TOKEN SLACK_APP_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."

SVC=compute/pr-shepherd # fixed by insta.template.yaml (and by deploy.sh --from-source)
ENV_FILE=deploy.env
CONFIG=config.yaml
B=()
NAMES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) B=(--branch "${2:?}"); shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --config) CONFIG="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) NAMES+=("$1"); shift ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[[ ${#NAMES[@]} -gt 0 ]] || { sed -n '5,9p' "$0" >&2; exit 2; }
for name in "${NAMES[@]}"; do # check every name before changing anything
  case "$name" in config|GH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY) ;;
    *) die "unknown name: $name (see --help)" ;; esac
done
[[ -f .insta/project.json ]] || die "this checkout isn't linked to an InstaCloud project (deploy first: scripts/deploy.sh)"

for name in "${NAMES[@]}"; do
  if [[ "$name" == config ]]; then
    [[ -f "$CONFIG" ]] || die "$CONFIG not found"
    # Same validation and one-line JSON form as deploy.sh.
    json=$(CONFIG_PATH="$CONFIG" npx --no-install tsx -e "
      import { loadConfig } from './src/config.ts';
      console.log(JSON.stringify(loadConfig(process.env.CONFIG_PATH, {})));
    ") || die "$CONFIG is invalid (see the error above)"
    printf '%s' "$json" | insta secrets set PR_SHEPHERD_CONFIG --service "$SVC" ${B[@]+"${B[@]}"} >/dev/null
    echo "updated PR_SHEPHERD_CONFIG from $CONFIG"
    continue
  fi
  case "$name" in
    GH_TOKEN) prefix=github_pat_ ;;
    SLACK_BOT_TOKEN) prefix=xoxb- ;;
    SLACK_APP_TOKEN) prefix=xapp- ;;
    CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY) prefix="" ;;
  esac
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"
  # A subshell per value, so nothing else from the env file leaks into this script.
  value=$(set -a; source "$ENV_FILE"; printf '%s' "${!name:-}")
  [[ -n "$value" ]] || die "$name is empty in $ENV_FILE"
  [[ "$value" == "$prefix"* ]] || die "$name in $ENV_FILE must start with $prefix"
  printf '%s' "$value" | insta secrets set "$name" --service "$SVC" ${B[@]+"${B[@]}"} >/dev/null
  unset value
  echo "updated $name from $ENV_FILE"
  case "$name" in
    CLAUDE_CODE_OAUTH_TOKEN) other=ANTHROPIC_API_KEY ;;
    ANTHROPIC_API_KEY) other=CLAUDE_CODE_OAUTH_TOKEN ;;
    *) other="" ;;
  esac
  [[ -z "$other" ]] || echo "note: if the deployment still has $other, remove it: insta secrets unset $other --service $SVC ${B[*]:-}"
done
echo "insta restarts $SVC with the new values; check /healthz in a minute."

#!/usr/bin/env bash
# Deploy pr-shepherd to InstaCloud from this checkout with the template (DESIGN §11.1).
# Credentials come from deploy.env, the bot config from config.yaml (the pr-shepherd-setup skill writes it).
# Values are passed from variables, so they never land in your shell history.
# Usage: scripts/deploy.sh [--project <name>] [--branch <name>] [--region <slug>] [--env-file <file>] [--config <file>]
#                          [--from-source] [--no-local-install]
#   --project      InstaCloud project to create when this checkout isn't linked yet
#                  (default: INSTA_PROJECT from the env file, else bot.name)
#   --from-source  build the bot from this checkout instead of running the template's published image.
#                  Automatic when that image can't be pulled anonymously (not released yet, or GHCR package private).
#   --no-local-install  don't install the pr-shepherd-ship skill on this machine afterwards (scripts/install-local.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=deploy.env
CONFIG=config.yaml
PROJECT=""
FROM_SOURCE=""
LOCAL_INSTALL=1
EXTRA=()
BRANCH=()
REGION=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --config) CONFIG="${2:?}"; shift 2 ;;
    --project) PROJECT="${2:?}"; shift 2 ;;
    --branch) EXTRA+=("$1" "${2:?}"); BRANCH=("$1" "$2"); shift 2 ;;
    --region) EXTRA+=("$1" "${2:?}"); REGION=("$1" "$2"); shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --no-local-install) LOCAL_INSTALL=""; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }

command -v insta >/dev/null || die "insta CLI not found: curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh"
command -v node >/dev/null || die "Node 22+ is required"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found: cp deploy.env.example deploy.env and fill it in"
[[ -f "$CONFIG" ]] || die "$CONFIG not found: run the pr-shepherd-setup skill, or cp config.example.yaml config.yaml"
[[ -d node_modules/yaml ]] || npm ci --silent

set -a; source "$ENV_FILE"; set +a
PROJECT="${PROJECT:-${INSTA_PROJECT:-}}"
for v in GH_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN; do
  [[ -n "${!v:-}" ]] || die "$v is empty in $ENV_FILE"
done
[[ "$GH_TOKEN" == github_pat_* ]] || die "GH_TOKEN must be a fine-grained PAT (github_pat_…)"
[[ "$SLACK_BOT_TOKEN" == xoxb-* ]] || die "SLACK_BOT_TOKEN must start with xoxb-"
[[ "$SLACK_APP_TOKEN" == xapp-* ]] || die "SLACK_APP_TOKEN must start with xapp-"
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -n "${ANTHROPIC_API_KEY:-}" ]] || [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]]; then
  die "set exactly one of CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in $ENV_FILE"
fi

# Validate with the service's own schema, then pass it as one-line JSON (a template variable is one line).
CONFIG_JSON=$(CONFIG_PATH="$CONFIG" npx --no-install tsx -e "
  import { loadConfig } from './src/config.ts';
  console.log(JSON.stringify(loadConfig(process.env.CONFIG_PATH, {})));
") || die "$CONFIG is invalid (see the error above)"
BOT_NAME=$(node -e 'console.log(JSON.parse(process.argv[1]).bot.name)' "$CONFIG_JSON")

# The bot refuses to start with a GitHub token that is rejected or belongs to someone else; catch it before
# a build. gh reads GH_TOKEN from the environment (exported by the env file above), so it is never on argv.
if command -v gh >/dev/null; then
  OWNER_GITHUB=$(node -e 'console.log(JSON.parse(process.argv[1]).owner.github)' "$CONFIG_JSON")
  TOKEN_LOGIN=$(env -u GITHUB_TOKEN GH_HOST=github.com gh api user --jq .login 2>/dev/null) \
    || die "GitHub rejects GH_TOKEN in $ENV_FILE (bad credentials: mistyped, expired, revoked, or not yet approved by the org)"
  lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
  [[ "$(lower "$TOKEN_LOGIN")" == "$(lower "$OWNER_GITHUB")" ]] \
    || die "GH_TOKEN belongs to @$TOKEN_LOGIN, but owner.github in $CONFIG is @$OWNER_GITHUB; the token must be the owner's"
fi

# Template deploys only run prebuilt images, and they pull anonymously. Without a public image for this
# version, the services are created directly and the bot is built from this checkout (see below).
IMAGE=$(node -e "
  const t = require('yaml').parse(require('fs').readFileSync('insta.template.yaml', 'utf8'));
  console.log(t.services['pr-shepherd'].image);
")
if [[ -z "$FROM_SOURCE" ]] && ! node scripts/image-pullable.mjs "$IMAGE"; then
  echo "note: $IMAGE can't be pulled anonymously (not released, or the GHCR package is private); building from this checkout" >&2
  FROM_SOURCE=1
fi

# A link to a project that was deleted since: drop it and create a new one.
if [[ -f .insta/project.json ]] && ! out=$(insta service list --json 2>&1); then
  grep -q "project not found" <<<"$out" || die "insta service list failed: $out"
  echo "note: the linked InstaCloud project no longer exists; moving .insta/project.json to .insta/project.json.stale" >&2
  mv .insta/project.json .insta/project.json.stale
fi

if [[ -f .insta/project.json ]]; then
  [[ -z "$PROJECT" ]] || echo "note: this checkout is already linked to an InstaCloud project; --project $PROJECT is ignored" >&2
else
  PROJECT="${PROJECT:-$BOT_NAME}"
  echo "==> creating InstaCloud project $PROJECT"
  # `project create` installs InstaCloud's agent skills and appends `.claude/skills/` to .gitignore, which
  # would hide this repo's own skills there; .gitignore already covers the installed ones, so undo it.
  GITIGNORE_CLEAN=""; git diff --quiet -- .gitignore 2>/dev/null && GITIGNORE_CLEAN=1
  insta project create "$PROJECT"
  [[ -z "$GITIGNORE_CLEAN" ]] || git checkout -- .gitignore 2>/dev/null || true
fi
if [[ ${#BRANCH[@]} -gt 0 ]] && ! insta branch list --json | grep -q "\"${BRANCH[1]}\""; then
  echo "==> creating branch ${BRANCH[1]}"
  insta branch create "${BRANCH[1]}"
fi

ARGS=(--set GH_TOKEN="$GH_TOKEN" --set SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" --set SLACK_APP_TOKEN="$SLACK_APP_TOKEN"
      --set PR_SHEPHERD_CONFIG="$CONFIG_JSON")
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then ARGS+=(--set CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
else ARGS+=(--set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"); fi

if [[ -z "$FROM_SOURCE" ]]; then
  echo "==> deploying $BOT_NAME (template ./insta.template.yaml)"
  insta template deploy ./ "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"} -y
else
  # Same services as the template (db, pr-shepherd with a /data volume), created directly: a source deploy
  # into a template-created service whose image failed is refused (409, service already exists).
  # DATA_DIR and CLAUDE_CONFIG_DIR default to what the template sets. Values go in on stdin, never argv.
  SVC=compute/pr-shepherd
  B=(${BRANCH[@]+"${BRANCH[@]}"})
  echo "==> creating services for $BOT_NAME (building from this checkout)"
  services=$(insta service list ${B[@]+"${B[@]}"} --json)
  grep -q '"db"' <<<"$services" || insta service add postgres db ${B[@]+"${B[@]}"} ${REGION[@]+"${REGION[@]}"}
  grep -q '"pr-shepherd"' <<<"$services" \
    || insta service add compute pr-shepherd --port 8080 --volume 10 --mount-path /data ${B[@]+"${B[@]}"} ${REGION[@]+"${REGION[@]}"}
  insta secrets bindings --target "$SVC" ${B[@]+"${B[@]}"} --json | grep -q DATABASE_URL \
    || insta secrets bind DATABASE_URL postgres/db --to "$SVC" ${B[@]+"${B[@]}"}
  CLAUDE_VAR=CLAUDE_CODE_OAUTH_TOKEN; [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] || CLAUDE_VAR=ANTHROPIC_API_KEY
  export PR_SHEPHERD_CONFIG="$CONFIG_JSON"
  for v in GH_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN PR_SHEPHERD_CONFIG "$CLAUDE_VAR"; do
    printf '%s' "${!v}" | insta secrets set "$v" --service "$SVC" ${B[@]+"${B[@]}"} >/dev/null
    echo "  set $v"
  done
  echo "==> building and deploying $BOT_NAME from this checkout"
  insta deploy . --group pr-shepherd --port 8080 ${B[@]+"${B[@]}"}
fi

ORG=$(node -e 'console.log(JSON.parse(process.argv[1]).org)' "$CONFIG_JSON")
URL=$(scripts/deployment-url.sh ${BRANCH[@]+"${BRANCH[@]}"} || true)
if [[ -z "$URL" ]]; then
  cat <<MSG

Deployed, but the bot's URL couldn't be looked up (insta service list). When it shows up:
  1. https://<url>/healthz → 200 with db, credentials and disk ok.
  2. On each machine you code on:  scripts/install-local.sh --url https://<url> --org $ORG
  3. In Slack: /invite @$BOT_NAME to the review channel, then @$BOT_NAME help
MSG
  exit 0
fi

echo "==> waiting for $URL/healthz"
healthy=""
for _ in $(seq 1 36); do
  if curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 5
done
if [[ -z "$healthy" ]]; then
  echo "warning: $URL/healthz is not healthy after 3 minutes:" >&2
  curl -sS -m 10 "$URL/healthz" >&2 || true; echo >&2
  echo "  logs: insta compute logs pr-shepherd --since 15m ${BRANCH[*]:-}" >&2
else
  echo "  healthy"
fi

if [[ -n "$LOCAL_INSTALL" ]]; then
  echo "==> installing the pr-shepherd-ship skill on this machine"
  scripts/install-local.sh --url "$URL" --org "$ORG"
fi

cat <<MSG

$BOT_NAME is at $URL
Next:
  1. In Slack: /invite @$BOT_NAME to the review channel, then @$BOT_NAME help
  2. On other machines you code on:  scripts/install-local.sh --url $URL --org $ORG
MSG

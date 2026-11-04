#!/usr/bin/env bash
# Deploy pr-shepherd to an instabox box (DESIGN §12): push this checkout's tracked files and config.yaml, build on
# the box, restart the systemd service, publish the HTTP port, and point this machine's skills at it.
# The box must exist and never pause, in the org that holds the Secrets:
#   instabox create --name pr-shepherd --org <org> --no-vault --secrets none --auto-suspend 0 --max-run-minutes -1
#   instabox secrets set GH_TOKEN --org <org> --host api.github.com --host github.com
#   instabox secrets set SLACK_BOT_TOKEN --org <org> --host slack.com
#   instabox secrets set SLACK_APP_TOKEN --org <org> --host slack.com
#   instabox secrets set CLAUDE_CODE_OAUTH_TOKEN --org <org> --ai anthropic
#   instabox secrets select pr-shepherd --secrets GH_TOKEN,SLACK_BOT_TOKEN,SLACK_APP_TOKEN,CLAUDE_CODE_OAUTH_TOKEN
# Usage: scripts/deploy-instabox.sh [--box <name>] [--no-start] [--force]
#   --no-start  install everything but leave the service stopped (only one bot may hold the Slack connection)
#   --force     deploy even though a shepherd run is live (a deploy interrupts it)
set -euo pipefail

cd "$(dirname "$0")/.."
BOX=pr-shepherd START=1 FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --box) BOX="${2:?--box needs a value}"; shift 2 ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
export INSTABOX_NO_UPDATE_CHECK=1
[[ -s config.yaml ]] || die "config.yaml not found"
ib() { instabox exec "$BOX" --timeout 600 -- "$@"; }

HOME_DIR=$(ib 'printf %s "$HOME"')
LIVE="$HOME_DIR/pr-shepherd" RELEASE="$HOME_DIR/pr-shepherd.new"

if [[ $START -eq 1 ]]; then
  need=(GH_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN CLAUDE_CODE_OAUTH_TOKEN)
  for v in "${need[@]}"; do
    ib "grep -q 'export $v=' /run/instabox/secrets/env" || die "Secret $v is not selected on $BOX (see the header of this script)"
  done
fi

if [[ $FORCE -eq 0 ]]; then
  live=$(ib "command -v psql >/dev/null && psql -tA 'postgresql:///pr_shepherd?host=/var/run/postgresql' -c \"select count(*) from runs where status = 'running'\" 2>/dev/null || echo 0")
  [[ "${live:-0}" == 0 ]] || die "$live shepherd run(s) are live; a deploy interrupts them. Retry later, or pass --force"
fi

echo "==> pushing to $BOX"
ib "rm -rf '$RELEASE' && mkdir -p /data/shepherd"
instabox push "$BOX" ./ "$RELEASE"
instabox push "$BOX" config.yaml /data/shepherd/config.yaml
ib "chmod 600 /data/shepherd/config.yaml"

instabox ssh "$BOX" -- "bash '$RELEASE/scripts/instabox-provision.sh' '$RELEASE' '$LIVE'"

if [[ $START -eq 0 ]]; then
  echo "installed on $BOX, service stopped. Start it with: scripts/deploy-instabox.sh --box $BOX"
  exit 0
fi

# The registration token: the box keeps only its hash, this machine the value (via install-local.sh).
token=$(sed -n 's/^PR_SHEPHERD_TOKEN=//p' "$HOME/.config/pr-shepherd/config" 2>/dev/null | head -1)
[[ -n "$token" ]] || token=$(openssl rand -hex 32)
hash=$(printf %s "$token" | shasum -a 256 | cut -d' ' -f1)
ib "printf %s $hash > /data/shepherd/register-token.sha256"

ib "sudo systemctl enable pr-shepherd && sudo systemctl restart pr-shepherd"
URL=$(instabox port publish "$BOX" 8080 | grep -oE 'https://[^ ]+' | head -1)
[[ -n "$URL" ]] || die "could not read the published URL: instabox port ls $BOX"

echo "==> waiting for $URL/healthz"
healthy=""
for _ in $(seq 1 36); do
  if curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 5
done
if [[ -z "$healthy" ]]; then
  curl -sS -m 10 "$URL/healthz" >&2 || true; echo >&2
  die "$URL/healthz is not healthy after 3 minutes. Logs: instabox exec $BOX -- 'journalctl -u pr-shepherd -n 80 --no-pager'"
fi
echo "  healthy"

PR_SHEPHERD_TOKEN="$token" scripts/install-local.sh --url "$URL"

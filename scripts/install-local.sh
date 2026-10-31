#!/usr/bin/env bash
# Install the pr-shepherd local skills for Claude Code and Codex (DESIGN §8). Idempotent; re-run to update.
#   - symlinks local-skills/pr-shepherd-ship and pr-shepherd-slack into ~/.claude/skills and ~/.codex/skills
#   - writes ~/.config/pr-shepherd/config (PR_SHEPHERD_URL, PR_SHEPHERD_ORG, PR_SHEPHERD_SLACK_BOT)
#   - Claude Code: a PreToolUse(Bash) hook running guard.sh, so PRs in the org always go through the skill
#   - Codex: the same rule as a managed block in ~/.codex/AGENTS.md
# Usage: scripts/install-local.sh [--url https://<your-bot>] [--org <github-org>] [--slack-bot <bot user id>]
#        scripts/install-local.sh --uninstall
# scripts/deploy.sh runs it for you. Without --url / --org / --slack-bot it uses, in order: the deployment this
# checkout is linked to (scripts/deployment-url.sh), the org in config.yaml and the bot user behind
# SLACK_BOT_TOKEN in deploy.env, then the values already installed.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SKILLS=(pr-shepherd-ship pr-shepherd-slack)
CONF_DIR="$HOME/.config/pr-shepherd"
CONF="$CONF_DIR/config"
SETTINGS="$HOME/.claude/settings.json"
AGENTS="$HOME/.codex/AGENTS.md"
HOOK_CMD='"$HOME/.claude/skills/pr-shepherd-ship/guard.sh"'
BEGIN='<!-- pr-shepherd:begin -->'
END='<!-- pr-shepherd:end -->'

URL="" ORG="" SLACK_BOT="" UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --org) ORG="${2:?--org needs a value}"; shift 2 ;;
    --slack-bot) SLACK_BOT="${2:?--slack-bot needs a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [[ $UNINSTALL -eq 0 ]]; then
  [[ -n "$URL" ]] || URL=$("$REPO/scripts/deployment-url.sh" 2>/dev/null || true)
  if [[ -z "$ORG" && -s "$REPO/config.yaml" ]] && command -v node >/dev/null; then
    ORG=$(cd "$REPO" && node -e 'process.stdout.write(String(require("yaml").parse(require("fs").readFileSync("config.yaml", "utf8"))?.org ?? ""))' 2>/dev/null || true)
  fi
  # The bot's Slack user id, for pr-shepherd-slack. The token goes to curl on stdin, never on the command line.
  tok=$(sed -n 's/^SLACK_BOT_TOKEN=//p' "$REPO/deploy.env" 2>/dev/null | head -1 | tr -d "\"'")
  if [[ -z "$SLACK_BOT" && -n "$tok" ]]; then
    SLACK_BOT=$(printf 'Authorization: Bearer %s\n' "$tok" | curl -fsS -m 10 -H @- https://slack.com/api/auth.test 2>/dev/null | jq -r '.user_id // empty' || true)
  fi
  unset tok
fi
# Existing values survive a partial re-run (e.g. only --url).
if [[ -f "$CONF" ]]; then
  [[ -n "$URL" ]] || URL=$(sed -n 's/^PR_SHEPHERD_URL=//p' "$CONF")
  [[ -n "$ORG" ]] || ORG=$(sed -n 's/^PR_SHEPHERD_ORG=//p' "$CONF")
  [[ -n "$SLACK_BOT" ]] || SLACK_BOT=$(sed -n 's/^PR_SHEPHERD_SLACK_BOT=//p' "$CONF")
fi
if [[ $UNINSTALL -eq 0 && ( -z "$URL" || -z "$ORG" ) ]]; then
  echo "usage: $0 --url https://<your-bot> --org <github-org>" >&2; exit 2
fi

step() { printf '==> %s\n' "$*"; }

step "skill links"
for tool in "$HOME/.claude" "$HOME/.codex"; do
  [[ -d "$tool" ]] || continue
  mkdir -p "$tool/skills"
  for s in "${SKILLS[@]}"; do
    [[ -L "$tool/skills/$s" ]] && rm "$tool/skills/$s"
    if [[ $UNINSTALL -eq 0 ]]; then ln -s "$REPO/local-skills/$s" "$tool/skills/$s"; echo "  $tool/skills/$s"; fi
  done
done

step "config"
if [[ $UNINSTALL -eq 0 ]]; then
  mkdir -p "$CONF_DIR"
  printf 'PR_SHEPHERD_URL=%s\nPR_SHEPHERD_ORG=%s\n' "${URL%/}" "$ORG" > "$CONF"
  [[ -n "$SLACK_BOT" ]] && printf 'PR_SHEPHERD_SLACK_BOT=%s\n' "$SLACK_BOT" >> "$CONF"
  echo "  $CONF"
  [[ -n "$SLACK_BOT" ]] || echo "  (no PR_SHEPHERD_SLACK_BOT: pass --slack-bot <bot user id> so pr-shepherd-slack can find the bot)"
else
  rm -f "$CONF"
fi

step "Claude Code hook"
if [[ -d "$HOME/.claude" ]]; then
  [[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
  cp "$SETTINGS" "$SETTINGS.bak-pr-shepherd"
  tmp=$(mktemp)
  # Drop any previous guard, then add one if installing.
  jq --arg cmd "$HOOK_CMD" --argjson add "$([[ $UNINSTALL -eq 0 ]] && echo true || echo false)" '
    .hooks //= {} | .hooks.PreToolUse //= []
    | .hooks.PreToolUse |= (map(.hooks |= map(select((.command // "") | test("pr-shepherd-ship/guard\\.sh") | not)))
                            | map(select((.hooks | length) > 0)))
    | if $add then .hooks.PreToolUse += [{matcher: "Bash", hooks: [{type: "command", command: $cmd, timeout: 10}]}] else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  echo "  $SETTINGS (backup: $SETTINGS.bak-pr-shepherd)"
fi

step "Codex rule"
if [[ -d "$HOME/.codex" ]]; then
  touch "$AGENTS"
  tmp=$(mktemp)
  # Remove our managed block, keep everything else.
  awk -v b="$BEGIN" -v e="$END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    { print }
  ' "$AGENTS" | cat -s | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$tmp"
  if [[ $UNINSTALL -eq 0 ]]; then
    {
      cat "$tmp"
      [[ -s "$tmp" ]] && echo
      echo "$BEGIN"
      echo "- Opening a pull request in any $ORG/* GitHub repository: always use the \`pr-shepherd-ship\` skill (it writes"
      echo "  the handoff block and registers the PR with pr-shepherd). Never run a plain \`gh pr create\` there; the skill"
      echo "  runs \`PR_SHEPHERD_SHIP=1 gh pr create\`."
      echo "- Checking or steering what pr-shepherd does with the owner's PRs (status, tell, set, merge, pause): use the"
      echo "  \`pr-shepherd-slack\` skill."
      echo "$END"
    } > "$AGENTS"
  else
    mv "$tmp" "$AGENTS"
  fi
  echo "  $AGENTS"
fi

if [[ $UNINSTALL -eq 0 ]]; then
  echo "Done. Restart Claude Code / Codex to load the skills. PRs in $ORG/* now go through pr-shepherd-ship."
else
  echo "Uninstalled."
fi

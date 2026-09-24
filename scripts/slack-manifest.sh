#!/usr/bin/env bash
# Generate the Slack app manifest (from slack-manifest.yaml) for this deployment: app name and bot display
# name = the bot's name, description mentions the owner. Used by the pr-shepherd-setup skill.
# Usage: scripts/slack-manifest.sh [bot-name] [--owner <name>] [-o <file>] [--link]
#   bot-name  default: bot.name from the local config file (CONFIG_FILE, default config.yaml), else pr-shepherd
#   --owner   owner's display name for the description (default: owner.name / owner.github from the config)
#   -o FILE   write the manifest to FILE instead of stdout (e.g. slack-app-manifest.yaml, gitignored)
#   --link    also print a https://api.slack.com/apps?new_app=1&manifest_yaml=… link that opens
#             "Create New App" with this manifest already filled in (pick the workspace, then Create)
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG_FILE="${CONFIG_FILE:-config.yaml}"

NAME="" OWNER="" OUT="" LINK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="${2:?--owner needs a name}"; shift 2 ;;
    -o) OUT="${2:?-o needs a file}"; shift 2 ;;
    --link) LINK=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) NAME="$1"; shift ;;
  esac
done

read_config() { # $1 = JS expression over the parsed config `c`
  [[ -s "$CONFIG_FILE" ]] && command -v node >/dev/null || return 0
  node -e 'const c = require("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8")) ?? {}; const v = eval(process.argv[2]); if (v) process.stdout.write(String(v))' \
    "$CONFIG_FILE" "$1" 2>/dev/null || true
}
[[ -n "$NAME" ]] || NAME="$(read_config 'c.bot?.name')"
NAME="${NAME:-pr-shepherd}"
[[ -n "$OWNER" ]] || OWNER="$(read_config 'c.owner?.name ?? c.owner?.github')"
# Slack: app name ≤ 35 chars; bot display names allow lowercase letters, digits, . - _ only.
[[ "$NAME" =~ ^[a-z0-9._-]{1,35}$ ]] || { echo "bot name must match [a-z0-9._-]{1,35}, got: $NAME" >&2; exit 2; }
WHOSE="your"
[[ -n "$OWNER" ]] && WHOSE="${OWNER}'s"
DESC="Shepherds ${WHOSE} PRs through reviewer bots to merge; reviews or approves when tagged."

manifest=$(sed -E \
  -e "s/^(  name: ).*/\1${NAME}/" \
  -e "s/^(    display_name: ).*/\1${NAME}/" \
  -e "s|^(  description: ).*|\1${DESC//|/\\|}|" \
  -e '/^#/d' slack-manifest.yaml)

if [[ -n "$OUT" ]]; then
  printf '%s\n' "$manifest" > "$OUT"
  echo "wrote $OUT" >&2
else
  printf '%s\n' "$manifest"
fi

if [[ $LINK -eq 1 ]]; then
  encoded=$(printf '%s\n' "$manifest" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(encodeURIComponent(s)))')
  echo "https://api.slack.com/apps?new_app=1&manifest_yaml=${encoded}" >&2
fi

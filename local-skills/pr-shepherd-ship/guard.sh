#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) hook: in the org's repos a PR must be opened through the pr-shepherd-ship skill
# (it writes the handoff block and registers the PR with the pr-shepherd bot). The skill runs
# `PR_SHEPHERD_SHIP=1 gh pr create`; a plain `gh pr create` there is denied with a
# pointer to the skill. The org comes from the line `PR_SHEPHERD_ORG=<org>` in ~/.config/pr-shepherd/config;
# with no org configured the guard allows everything. Everything else passes through untouched.
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
[[ "$cmd" == *"gh pr create"* ]] || exit 0
[[ "$cmd" == *"PR_SHEPHERD_SHIP=1"* ]] && exit 0

org=$(sed -n 's/^PR_SHEPHERD_ORG=//p' "$HOME/.config/pr-shepherd/config" 2>/dev/null | head -1 | tr -d '[:space:]"'"'" | tr '[:upper:]' '[:lower:]')
[[ -n "$org" ]] || exit 0

cwd=$(jq -r '.cwd // empty' <<<"$input"); cwd=${cwd:-$PWD}
repo=$(grep -oE -- '(--repo|-R)[ =]*[^ ]+' <<<"$cmd" | head -1 | sed -E 's/^(--repo|-R)[ =]*//')
if [[ -z "$repo" ]]; then
  repo=$(git -C "$cwd" remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
fi
owner=$(tr '[:upper:]' '[:lower:]' <<<"${repo%%/*}")
[[ "$owner" == "$org" ]] || exit 0

jq -n --arg repo "$repo" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason: ("PRs in this org'"'"'s repos (" + $repo + ") must be opened with the pr-shepherd-ship skill, which writes the pr-shepherd handoff block and registers the PR with the bot. Invoke that skill now instead of running gh pr create directly.")}}'

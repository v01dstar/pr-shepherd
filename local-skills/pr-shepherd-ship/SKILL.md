---
name: pr-shepherd-ship
description: Open a pull request in a repository of the org that pr-shepherd watches and hand it to the owner's pr-shepherd bot for review, fixes and merge. ALWAYS use this whenever a PR is about to be created in one of the org's repos — whether the owner says "ship", "open a PR", "create a PR", "send it for review", or the task simply ends with a PR — instead of running `gh pr create` directly. Works in any coding agent (Claude Code, Codex, ...).
---

# pr-shepherd-ship

Turn the current local work into a PR and register it with the owner's pr-shepherd bot, which then requests
reviews, handles comments, rebases and merges (DESIGN §8). Run every step; do not skip registration.

"The owner" is the person you are working for (the bot only accepts their PRs); "the org" is the GitHub
organization the bot watches (`PR_SHEPHERD_ORG` in `~/.config/pr-shepherd/config`).

## 1. Check

Run the repo's own checks (see its README / CLAUDE.md / AGENTS.md / package scripts / Makefile): format,
lint, typecheck, tests. Fix failures. If something cannot pass, stop and tell the owner.

## 2. Commit and push

- Commit remaining changes with clear messages. Do not commit secrets, `.env`, build output.
- Never touch `.github/workflows/**` unless the owner asked (the bot's token cannot push them later).
- `git push -u origin HEAD`. Never push to the default branch; create a branch first if on it.

## 3. Write the handoff block

Append this to the PR body, filled from this session. ≤ 15 lines. Only what the code and diff do not
show. Empty fields are `-`. Reviewers will see it; that is intended.

```
<!-- pr-shepherd:handoff v1
agent: <claude-code | codex | ...>
session: <this session's id if you know it, else omit the line>
-->
### Handoff
**Intent**: what this solves and the overall approach (1–3 lines)
**Rejected**: approaches considered and dropped, and why (1 line each)
**Constraints**: things that must not change / behaviour that must be kept (1 line each)
**Known gaps**: known leftovers, work deliberately left for follow-up PRs
<!-- /pr-shepherd:handoff -->
```

The bot treats **Constraints** and **Rejected** as hard rules: a reviewer asking to violate them gets
escalated to the owner instead of "fixed". Be precise.

## 4. Open the PR

`PR_SHEPHERD_SHIP=1 gh pr create ...` — **not** a draft. Keep the `PR_SHEPHERD_SHIP=1` prefix: a local hook
blocks a plain `gh pr create` in the org's repos so that every PR goes through this skill. Title in the repo's
style; body = what/why, how it was tested, then the handoff block. If a PR for this branch already exists,
update its body instead (`gh pr edit --body-file`) and keep going: re-registering signals the bot that new
commits were pushed.

## 5. Register with the bot

Resolve `PR_SHEPHERD_URL`: the environment variable, else the line `PR_SHEPHERD_URL=https://...` in
`~/.config/pr-shepherd/config`.

If none is set, **stop and ask the owner** for the URL. Do not skip registration.

```bash
PR_SHEPHERD_URL="${PR_SHEPHERD_URL:-$(sed -n 's/^PR_SHEPHERD_URL=//p' ~/.config/pr-shepherd/config 2>/dev/null | head -1)}"
PR_SHEPHERD_URL="${PR_SHEPHERD_URL%/}"
curl -fsS --max-time 15 -X POST "$PR_SHEPHERD_URL/prs" \
  -H "Authorization: Bearer $(gh auth token)" -H "Content-Type: application/json" \
  -d '{"url":"<PR URL>"}'
```

Never print, log or save the token; always pass it inline via `$(gh auth token)` as above.

| Response | Meaning |
|---|---|
| 202 | registered (or already registered → the bot re-checks the new commits) |
| 401 | the gh token is not the owner's account (`gh auth status`) |
| 403 | repo not in the org / excluded, or the PR author is not the owner |
| 409 | PR is draft, merged or closed (`gh pr ready` for drafts, then retry) |
| timeout / 5xx | bot down or deploying |

## 6. Report

Tell the owner: the PR URL, and either "registered with pr-shepherd" or, on failure, clearly
**"NOT registered with pr-shepherd"** with the reason. The PR stays open either way. Remediation: fix the
cause and re-run the curl above, or in Slack `@<bot> track <PR URL>` (the bot's Slack name).

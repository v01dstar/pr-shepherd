---
name: pr-shepherd-setup
description: Set up a new pr-shepherd deployment from this repository — walk the user through the Slack app, credentials and bot config, write config.yaml, check deploy.env, and finish with the exact deploy command. Use when the user says "set up pr-shepherd", "configure the bot", "deploy my own pr-shepherd", or opens this repo and asks how to get started.
---

# pr-shepherd-setup

Goal: a valid `config.yaml` and a filled `deploy.env` in the repo root, ending with **one command** the
user runs to deploy (`scripts/deploy.sh`). Work in the repo root. Keep it conversational: ask a few
things at a time, propose defaults, confirm before writing files.

**Credentials rule.** Never ask the user to paste a token into the chat, never read, print, grep or
`cat` `deploy.env`, and never put a token in a command. Tokens go into `deploy.env` by the user's own
hand; you only check *which* variables are set (step 6).

## 1. Prerequisites

Check, and tell the user how to fix what is missing:

- `insta` CLI: `command -v insta` → install `curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh`,
  then `insta login` (opens the browser). `insta status` must show a user.
- Node 22+ (`node -v`) and dependencies (`npm ci` if `node_modules/` is missing).
- `gh auth status` (used to read the owner's login; also needed later by the local ship skill).
- `jq` (`command -v jq`; the deploy installs a Claude Code hook with it): `brew install jq` or the distro package.

## 2. Owner and org

- Owner GitHub login: `gh api user --jq .login` — confirm with the user. The GitHub token in step 6
  must belong to this same account (the bot pushes and merges as the owner).
- Org: list `gh api user/orgs --jq '.[].login'` and ask which org's repos the bot works on.
- Owner display name (optional, defaults to the login).

## 3. Slack

- **Bot name** (`bot.name`, default `pr-shepherd`): lowercase letters, digits, `-`, `_`, `.`. It is the
  Slack app's name, so pick it before creating the app.
- **Slack app manifest** — generate it for the user (skip if they already have the app):
  ```bash
  scripts/slack-manifest.sh <bot-name> --owner "<owner name>" -o slack-app-manifest.yaml --link
  ```
  This writes `slack-app-manifest.yaml` (gitignored) with the app name, bot display name and a description
  naming the owner, and prints a `https://api.slack.com/apps?new_app=1&manifest_yaml=…` link on stderr. Show
  the user the file, then give them the link: it opens *Create New App* with the manifest filled in — they
  pick the workspace and click **Create**. If the link does not prefill (or is too long for their browser),
  they choose *From a manifest* and paste the file (`pbcopy < slack-app-manifest.yaml` on macOS copies it).
- **Install and tokens** (in the browser, by the user): **Install to Workspace** → *OAuth & Permissions* →
  Bot User OAuth Token (`xoxb-…`); *Basic Information* → **App-Level Tokens** → generate one with scope
  `connections:write` (`xapp-…`). Both go into `deploy.env` in step 6, never into the chat. One Slack app
  can serve only one running deployment; a second one (e.g. dev) needs its own app, e.g. `<bot-name>-dev`.
- **InstaCloud project name** (default: the bot name): the project `scripts/deploy.sh` creates if this checkout
  isn't linked to one yet. It is set by `INSTA_PROJECT` in `deploy.env` (the user fills it in step 6 with the
  tokens) or `--project` on the command line. Inside it the services are always `db` and `pr-shepherd` (fixed by the template).
- **Owner's Slack member ID**: Slack → click own avatar → Profile → ⋮ → Copy member ID (`U…`).
- **Review channel**: the channel (name without `#`) where reviewer bots are asked for reviews. Remind
  them to `/invite @<bot-name>` there after deploying.

If a Slack tool is available in this session, you may offer to look IDs up with it (ask first).

## 4. Reviewer bots

pr-shepherd asks other bots for reviews by posting a message in the review channel, then waits for their
reply in that thread. Ask whether teammates run their own pr-shepherd instances: those are the natural
reviewers and approvers (templates `<@{slack}> review {url}` / `<@{slack}> approve {url}`; their replies
always carry the review link). For each reviewer bot collect:

- `name`: a label used in logs and `status`, e.g. `review-bot`.
- `slack`: the bot's member ID (open the bot's profile → Copy member ID).
- `request`: the message that asks it for a first review. Placeholders: `{slack}` (its member ID, write
  `<@{slack}>` to mention it), `{url}` (the PR URL), `{summary}` (the round summary), `{mentions}`
  (every bot in the same batch that shares this exact template — they then get one combined message).
  Ask the user what the bot understands, e.g. `<@{slack}> review {url}`.
- `rerequest`: the message for later rounds (often the same, or `{mentions} please re-review: {url}\n{summary}`).
  If a template has no `{summary}`, the bot posts the summary as a PR comment instead.

Check with the user that each reviewer bot's **final reply contains a link to its GitHub review**
(`…/pull/N#pullrequestreview-…`): that link is how pr-shepherd knows the review is done. A reply starting
with `:x:` or `:warning:` counts as an error; anything else is progress. If a bot never posts the link,
say so plainly — reviews from it will only be noticed through timeouts.

Also ask for the **approvers** — one or more bots or people who can approve the owner's PRs (GitHub does
not allow approving your own PR). For each: `name`, `slack`, `request` (e.g. `<@{slack}> approve {url}`;
approvers sharing a `{mentions}` template get one combined message). All of them are asked at once and the
first approval wins; write them as a list under `approvers:`.

Tell the user plainly: **every PR tags all reviewers in the list** (re-review rounds go only to the bots
whose comments were handled). There is no per-PR selection by default, so list only the bots that should
review every PR. (The owner can still narrow a single PR later with `@<bot-name> set <pr> reviewers=…`.)

## 5. Optional settings

Offer defaults and change only what they ask for: `limits.maxRounds` (4 rounds per reviewer),
`limits.maxRunsPerPr` (30), `timing.reportAt` (`09:00`) and `timing.timezone` (default
`America/Los_Angeles` — ask for theirs), `excludeRepos` (none), and the agent's model and reasoning effort
(`agent.model`, `agent.effort`: low | medium | high | xhigh | max; unset = Claude Code default; `agent.review`
can use a cheaper model/effort for reviewing others' PRs). See `config.example.yaml` for the rest.

## 6. Write and check

1. Show the full `config.yaml` you are about to write (YAML, commented like `config.example.yaml`) and get a yes.
   It is gitignored; if one already exists, show a diff and ask before overwriting.
2. Validate: `npm run check-config` (uses the service's own schema). Fix and repeat until it passes.
3. Credentials: if `deploy.env` is missing, run `cp deploy.env.example deploy.env && chmod 600 deploy.env` and ask
   the user to open it and fill in `GH_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and exactly one of
   `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) / `ANTHROPIC_API_KEY`, plus `INSTA_PROJECT` if the project
   name differs from the bot name. For the GitHub token, give them
   the fine-grained PAT settings from `deploy.env.example` (resource owner = the org from step 2,
   Workflows: no access).
4. Check which are filled — names only, never values:
   ```bash
   bash -c 'set -a; source deploy.env; for v in GH_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY INSTA_PROJECT; do [ -n "${!v}" ] && echo "$v: set" || echo "$v: empty"; done'
   ```

## 7. Final output

End with exactly this, filled in:

> Everything is ready. Deploy with:
>
> ```bash
> scripts/deploy.sh
> ```
>
> It creates the InstaCloud project `<project-name>` if this checkout isn't linked to one yet, then a Postgres
> service and the bot (built from this checkout if the published image isn't available), waits until
> `/healthz` is healthy, installs the `pr-shepherd-ship` skill on this machine, and prints the bot's URL. Then:
> 1. In Slack: `/invite @<bot-name>` to `#<reviewChannel>`, then `@<bot-name> help`.
> 2. On any other machine you code on: `scripts/install-local.sh --url <the printed URL> --org <org>`.

Also mention that their bot's review behaviour lives in `skills/review/SKILL.md` (and the shepherd's in
`skills/shepherd/SKILL.md`): they can enrich it with team conventions, architecture notes and checklists,
then deploy from the checkout with `insta deploy . --group pr-shepherd --port 8080`.

Mention `--region <slug>` (from `insta config regions`) if they care where it runs. Do not run
`scripts/deploy.sh` yourself unless the user asks you to. If the user deployed and the local install was skipped
or failed, offer to run `scripts/install-local.sh` (no arguments needed in this checkout); it edits
`~/.claude/settings.json` and `~/.codex/AGENTS.md`, so ask first.

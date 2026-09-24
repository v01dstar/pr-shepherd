# pr-shepherd

A Slack PR-lifecycle bot built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript).
You write code locally with any coding agent; once it becomes a PR, your pr-shepherd instance takes over: it
asks your team's reviewer bots for review in Slack, fixes what they find, asks for approval, and squash-merges.
It also reviews and approves other people's PRs when tagged. Each deployment works for one owner (you) in
one GitHub org, and its Slack name is whatever you give it. The examples here use `@pr-shepherd`.

```
local agent ──ship──▶ PR ──▶ pr-shepherd ──Slack──▶ reviewer bots
                                  ▲                     │ verdict
                                  └──── agent fixes ◀───┘   … ──▶ approve ──▶ squash merge
```

- **Ship**: a local skill (`pr-shepherd-ship`) opens the PR with a short handoff block (intent, rejected
  approaches, constraints) and registers it with your bot.
- **Shepherd**: the bot requests reviews, turns each verdict into fixes, replies and resolved threads,
  re-requests only the reviewers whose comments it handled, rebases when needed, and merges once approved.
- **Review on request**: `@pr-shepherd review|approve <pr>` in Slack. Reviews and approvals are posted as the owner.

## A team of pr-shepherds

The intended setup is **one instance per person**, all in the same review channel, reviewing each other:

```
 alice's PR ──▶ @alice-shepherd ──"review"──▶ @bob-shepherd, @carol-shepherd ──verdicts──▶ fixes … ──▶ merge
 bob's PR   ──▶ @bob-shepherd   ──"review"──▶ @alice-shepherd, @carol-shepherd ─────────────▶ …
```

- Each instance shepherds its owner's PRs and, when tagged, reviews or approves teammates' PRs as its own
  owner (`review` / `approve` in Slack).
- Each instance has **its own review skill** (`skills/review/SKILL.md`), so every reviewer brings a different
  lens — one security-minded, one focused on the API contract, one on tests.
- Wiring is just config: list your teammates' bots as `reviewers` and `approvers` with the plain templates
  `<@{slack}> review {url}` / `<@{slack}> approve {url}`. An instance's review verdict always carries the
  GitHub review link, which is exactly what the reply classifier looks for, so instances understand each
  other out of the box. Other reviewer bots (Codex, in-house bots) mix in the same way.

### Make the review skill yours

`skills/review/SKILL.md` is a starting point, not a fixed checklist. Enrich it with what your reviews
should catch: your team's conventions, the architecture and its invariants, security and performance
checklists, how to run each repo's tests, past incidents worth guarding against. You can also add more
files under `skills/review/` and reference them from the skill. The same goes for `skills/shepherd/SKILL.md`
if you want your PRs handled differently.

Review sessions deliberately do not load the reviewed repo's own `.claude/` settings (the code under review
is untrusted), so knowledge the reviewer needs belongs in your skill. Skills are baked into the image, so
after editing them deploy from your checkout instead of the published image:

```bash
insta deploy . --group pr-shepherd --port 8080
```

Design: [DESIGN.md](DESIGN.md) is the source of truth. Code comments cite its sections (`DESIGN §5.3`).

## Quick start

pr-shepherd runs on [InstaCloud](https://instacloud.com): one always-on container plus a managed Postgres,
deployed from the template in this repo. Setup takes about 15 minutes. Most of it is done by an agent skill
that ships with the repo.

### 0. InstaCloud

1. Install the CLI and sign in (the login opens your browser; any email, GitHub or Google account works):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
   ```
   ```bash
   insta login
   ```
2. `insta status` should show your user. Billing is by actual usage (CPU and memory the bot really uses,
   plus storage). `insta billing` shows where you stand.

You also need Node 22+, `gh auth login`, and Claude Code or Codex.

### 1. Clone and open the repo in your coding agent

```bash
git clone https://github.com/v01dstar/pr-shepherd && cd pr-shepherd && npm ci
```

Open it in Claude Code or Codex and say **"set up pr-shepherd"**. The `pr-shepherd-setup` skill (shipped in
`.claude/skills` and `.agents/skills`) walks you through the rest:

- the Slack app: it generates `slack-app-manifest.yaml` (your bot's name, a description naming you) and a
  link that opens Slack's *Create New App* with that manifest already filled in; you pick the workspace,
  install it and copy two tokens (Slack has no API for creating apps, so those clicks stay manual);
- your GitHub org and login, your Slack member ID, the review channel, and your team's reviewer bots
  with the messages they understand;
- it writes and validates `config.yaml` (gitignored) and ends with the one command that deploys.

It never asks for tokens in the chat: credentials go into a file you edit yourself (next step).

### 2. Credentials in `deploy.env`

```bash
cp deploy.env.example deploy.env && chmod 600 deploy.env
```

Fill it in with your editor. The file is gitignored, and `scripts/deploy.sh` reads it, so no token ever
appears in your shell history.

| Variable | Where it comes from |
|---|---|
| `GH_TOKEN` | A [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) on your account. **Resource owner**: your org. **Repository permissions**: Contents, Pull requests, Issues read and write; Commit statuses, Actions read-only; **Workflows: no access**, so GitHub rejects any push to `.github/workflows/**`. Up to one year; the bot warns you before it expires. |
| `SLACK_BOT_TOKEN` | The Slack app's *OAuth & Permissions* → Bot User OAuth Token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | *Basic Information* → App-Level Tokens → one with `connections:write` (`xapp-…`). |
| `CLAUDE_CODE_OAUTH_TOKEN` **or** `ANTHROPIC_API_KEY` | `claude setup-token` (subscription, one year), or an Anthropic API key. Set exactly one. |
| `INSTA_PROJECT` (optional) | Name of the InstaCloud project to create; default: the bot name. Not a secret. |

### 3. Deploy

The setup skill finishes with this command:

```bash
scripts/deploy.sh
```

It checks `deploy.env`, validates `config.yaml` with the service's own schema, creates an InstaCloud project
if this checkout is not linked to one, and runs `insta template deploy ./` with everything passed as
variables. The template creates a Postgres service (`db`) and the bot service (`pr-shepherd`, image
`ghcr.io/v01dstar/pr-shepherd:<version>`, port 8080, a volume at `/data`, platform healthcheck `/livez`),
then prints its URL. Template deploys only run published images, so when that image can't be pulled
anonymously (no release yet, or the GHCR package is still private) the script creates the same two services
directly, stores the variables on the bot service and builds it from this checkout (`insta deploy .`);
`--from-source` forces that. If the linked project was deleted, the script creates a new one. The project is named after the bot unless `INSTA_PROJECT` is set in `deploy.env` (or `--project <name>` is passed); inside it the
services are always `db` and `pr-shepherd`. Add `--region <slug>` to choose a region (`insta config regions`).

Prefer doing it by hand? Copy `config.example.yaml` to `config.yaml`, fill it in, and check it with
`npm run check-config`. Or skip the script and pass variables yourself:
`insta template deploy https://github.com/v01dstar/pr-shepherd --set NAME=value …` (config as one-line JSON).

### 4. Check it and invite the bot

- `https://<your-deployment>/healthz` returns `200` with `db`, `credentials` (github, slack, claude) and
  `diskFreePct` ok within a minute. `/livez` only says the process and database are up.
- In Slack: `/invite @<bot-name>` into the review channel, then `@<bot-name> help`.

### 5. Install the local ship skill

On each machine you code on (needs `gh auth login`, and `jq` for the hook):

```bash
scripts/install-local.sh --url https://<your-deployment> --org your-org
```

This symlinks `pr-shepherd-ship` into `~/.claude/skills` and `~/.codex/skills` and writes
`~/.config/pr-shepherd/config` (`PR_SHEPHERD_URL=…`, `PR_SHEPHERD_ORG=…`). It also adds a Claude Code
`PreToolUse` hook (`guard.sh`) that denies a plain `gh pr create` in the org's repos and points the agent
at the skill, and a matching rule block in `~/.codex/AGENTS.md`. It is idempotent. `--uninstall` removes
everything it added.

From now on, "open a PR" in any of the org's repos goes through your bot. Registration authenticates with
your local `gh` login (the bot checks it is the configured owner), so there is no extra token to manage.

## How it works

The service is a thin, deterministic **harness** around Claude **agents**. The harness never reads
review content, and the agent never talks to Slack.

| Harness (TypeScript) | Agent (Claude Agent SDK + skills) |
|---|---|
| Collects events: PR registration, reviewer replies in Slack, timers | Reads the PR, handoff block, reviews, comments and CI |
| Schedules runs: one long-lived session per PR, debounce, steering new events into a live run, concurrency pools | Fixes code, runs tests, commits, pushes, replies, resolves threads |
| Executes the agent's `next` action: Slack review / approve requests, timers, merge (pinned to a SHA), escalation to the owner | Rebases and resolves conflicts |
| Budgets (rounds per reviewer, runs per PR), restart recovery, workspace cleanup, daily report | Returns a structured result: what it handled and what to do next |

Key ideas:

- **Two interfaces only.** Events go in as short `[event] …` messages, each followed by a `[policy]` line
  (budget, auto-merge) and a `[context]` line (`bot=… owner=… (@login) org=…`). Results come out as
  schema-validated JSON via the SDK's `outputFormat`. The shepherd agent gets no custom tools.
- **Generic skills.** The server skills `pr-shepherd:shepherd` and `pr-shepherd:review` talk about
  "the owner", "the org" and "the bot" and take the actual values from `[context]`, so one image serves
  any deployment.
- **Bot-agnostic reply detection.** A reviewer reply containing a GitHub review link means "done".
  A leading `:x:` / `:warning:` means "error". Anything else is progress. No per-bot parsing.
- **Crash-safe.** All state is in Postgres and a `/data` volume. Outputs are recorded before side effects
  are applied, so a restart re-applies exactly once, and interrupted runs resume the same session.
- **Least privilege.** The GitHub credential is a fine-grained PAT scoped to one org with no Workflows
  permission. Review sessions for other people's PRs run with no secrets besides the Claude credential
  and read GitHub only through a read-only, org-scoped `gh_read` tool.

The handoff block the ship skill writes is delimited by `<!-- pr-shepherd:handoff v1 … -->` and
`<!-- /pr-shepherd:handoff -->`. The bot strips it from the squash-merge body.

## Configuration reference

The config holds everything that is not a secret. It is read from `PR_SHEPHERD_CONFIG` (YAML text, or a
one-line JSON object) if set, otherwise from the file at `CONFIG_PATH` (default `config.yaml`). Invalid
config fails startup.
[config.example.yaml](config.example.yaml) is the full template.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `bot.name` | no | `pr-shepherd` | This deployment's display name: Slack messages, PR comments, commit trailer, daily report |
| `org` | yes | | The GitHub org. Only PRs in its repos are accepted |
| `owner.github`, `owner.slack` | yes | | Your GitHub login and Slack user id |
| `owner.name` | no | `owner.github` | How the agent refers to you |
| `reviewChannel` | yes | | Slack channel for review requests |
| `reviewers[]` | yes | | `{name, slack, request, rerequest}`. **Every PR tags all of them** (re-review rounds only the ones whose comments were handled; `set <pr> reviewers=…` narrows one PR), so list only bots that should review every PR. Templates use `{url}`, `{summary}`, `<@{slack}>` (own message per bot) or `{mentions}` (bots sharing one message) |
| `approvers` | yes | | list of `{name, slack, request}`: the bots or people who can approve your PRs (GitHub forbids approving your own). All are asked at once unless the agent names a subset; the first approval wins. |
| `excludeRepos` | no | `[]` | `owner/repo` entries to refuse |
| `agent` | no | Claude Code defaults | `{model, effort, fallbackModel, shepherd: {model, effort}, review: {model, effort}}`: model and reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`) for agent runs; `shepherd` (your PRs) and `review` (others' PRs) override the shared values |
| `limits` | no | `maxRounds 4, maxRunsPerPr 30, maxTurns 60, shepherdConcurrency 1, reviewConcurrency 2` | Budgets and pools |
| `timing` | no | `debounceSec 30, ackTimeoutMin 15, replyTimeoutMin 120, sweepMin 30, reviewIdleDays 7, reportAt "09:00", timezone America/Los_Angeles` | Timers and the daily report |

Environment overrides (non-empty values win over the config text):

| Variable | Overrides |
|---|---|
| `PR_SHEPHERD_BOT_NAME` | `bot.name` |
| `PR_SHEPHERD_ORG` | `org` |
| `PR_SHEPHERD_OWNER_GITHUB` · `PR_SHEPHERD_OWNER_SLACK` · `PR_SHEPHERD_OWNER_NAME` | `owner.*` |
| `PR_SHEPHERD_REVIEW_CHANNEL` | `reviewChannel` |
| `PR_SHEPHERD_MODEL` | `agent.model` |
| `PR_SHEPHERD_EFFORT` | `agent.effort` |

Secrets:

| Variable | What |
|---|---|
| `PR_SHEPHERD_CONFIG` | The config (YAML, or one-line JSON) |
| `DATABASE_URL` | Postgres connection string (bound automatically on InstaCloud) |
| `GH_TOKEN` | Fine-grained PAT (see Quick start step 2) |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Claude credential |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Bot token (`xoxb-…`) and app-level token with `connections:write` (`xapp-…`) |

Other environment: `PORT` (8080), `DATA_DIR` (`/data`), `CLAUDE_CONFIG_DIR` (`/data/claude`), `LOG_LEVEL`.

HTTP: `POST /prs` (register a PR, used by the ship skill), `GET /livez` (process + database; the platform
healthcheck), `GET /healthz` (full readiness: database, credentials with `expiresAt`, disk).

## Usage

Open a PR from your coding agent ("open a PR", "ship it"). The skill registers it and the bot takes it
from there. You can also register an existing PR in Slack: `@pr-shepherd track <pr>`.

Slack commands (`<pr>` = a PR URL or `owner/repo#N`; owner-only commands also work in a DM):

| Command | Who | |
|---|---|---|
| `review <pr>` · `approve <pr>` (also `review this`, `please review:`, `please approve <pr> - …`) | anyone | review / approve someone else's PR |
| `status [pr]` | anyone | shepherded PRs and what each is waiting on |
| `track <pr>` · `untrack <pr>` | owner | start / stop shepherding (untrack cleans up the workspace) |
| `tell <pr> <text>` | owner | say something to the PR's agent (replying in a request thread works too) |
| `set <pr> rounds=6 reviewers=A,B auto_merge=off` | owner | per-PR policy |
| `merge <pr>` | owner | release a merge that is waiting for confirmation (`auto_merge=off`) |
| `pause` · `resume` `<pr>\|all` | owner | pause one PR, or everything (emergency stop) |
| `report` · `help` | owner · anyone | daily report now / command list |

Every command is `@pr-shepherd <command>`, using your bot's Slack name. The owner gets a DM whenever a PR
needs them (escalation, budget exhausted, credential failure) and a short daily report.

## Operations on InstaCloud

The template names the bot's service `pr-shepherd`; commands below assume you run them in the linked
checkout (add `--branch <name>` if you deployed to a branch).

| Task | Command |
|---|---|
| Logs (pino JSON) | `insta compute logs pr-shepherd --since 1h` |
| Health | `curl https://<deployment>/healthz` |
| Update the config | edit `config.yaml`, then `scripts/update-secret.sh config` (validated; the service restarts with it) |
| Replace a credential | edit `deploy.env`, then e.g. `scripts/update-secret.sh GH_TOKEN` (or `SLACK_BOT_TOKEN SLACK_APP_TOKEN`); values go over stdin, no rebuild |
| Upgrade to a new release | `insta deploy --image ghcr.io/v01dstar/pr-shepherd:<version> --group pr-shepherd --port 8080` |
| Stop / start | `insta compute stop pr-shepherd` / `insta compute start pr-shepherd` |
| Usage and cost | `insta billing usage` |

- **Emergency stop:** `@<bot-name> pause all` in Slack (runs stop, timers freeze; `resume all` undoes it).
  Stopping the service or revoking the PAT also works.
- **Expiry reminders:** credentials are checked at startup and every 6 h; a failure DMs the owner with the fix.
  Advance warnings arrive 30/14/7/3/1 days before the GitHub PAT expires, and before the Claude token's
  one-year life ends (counted from the day the deployment first saw it). `/healthz` shows each `expiresAt`.
- **One Slack app, one running deployment.** Socket Mode splits events across connections, so a second
  deployment (e.g. dev) needs its own Slack app.
- **State:** Postgres tables `prs`, `events`, `runs` (including each agent output), `review_requests`, `jobs`,
  `timers`, `workspaces`, `credential_expiry`. On the volume: per-PR worktrees (with the agent's notes in
  `.pr-shepherd/notes.md`), bare mirrors, and Claude session transcripts. Workspaces are removed when a PR
  merges or closes, and a sweep catches PRs merged elsewhere. Migrations are forward-only, so rolling back
  the image never requires rolling back the database.

## Build from source / maintainers

**Deploy from the working tree** (unreleased changes, a customized review skill, a dev environment):

```bash
scripts/deploy.sh --from-source                                  # the linked project's main branch
scripts/deploy.sh --from-source --branch dev --config config.dev.yaml --env-file deploy.dev.env
```

The same script as the template path, minus the template: it creates the services (`db`, `pr-shepherd`),
binds `DATABASE_URL`, sets the variables from the env file on stdin, then builds and deploys the checkout.
It is idempotent. A second environment needs its own Slack app (and so its own env file). After a deploy,
`scripts/update-secret.sh <NAME|config> [--branch <name>]` replaces single values without a rebuild.

**Image build args:** `GO_VERSION` (empty skips Go) and `EXTRA_APT_PACKAGES` add toolchains the target
repositories' tests need. Node 22, git, gh, jq and python3 are always included.

**Releases:**

```bash
scripts/release.sh 0.2.0     # bumps package.json and the template's image tag, commits, tags v0.2.0
git push --follow-tags
```

The `v*` tag triggers `.github/workflows/release.yml`, which builds a multi-arch image and pushes
`ghcr.io/<owner>/pr-shepherd:<version>` and `:latest`. `.github/workflows/ci.yml` runs typecheck and tests.
After the first release, make the GHCR package public (package settings → visibility) so template deploys can
pull it.

## Development

```bash
npm install
npm run typecheck && npm test        # vitest, no network: fakes + in-memory Postgres (pglite)
npm run dev                          # needs DATABASE_URL and the secrets above
npm run build && npm start
```

With InstaCloud, `insta run --branch dev -- npm run dev` runs locally against the dev database.

`npm run fake-reviewer` starts a stand-in reviewer bot (a second Slack app) that answers in the real reply
formats: approve, request changes, queue, stay silent, or error. Use it for end-to-end tests without real
reviewers.

Repository layout:

```
src/
  index.ts        wiring, startup recovery, graceful shutdown
  http.ts         POST /prs, GET /livez, GET /healthz
  control.ts      Slack commands, timer loop, recovery
  inbox.ts        events and reviewer-reply classification
  scheduler.ts    sessions, debounce, steering, pools, budgets; [policy] / [context] lines
  agent.ts        the only Agent SDK entry point
  actuator.ts     executes `next` (requests, merge, timers, escalation)
  output.ts       zod schemas for agent output (→ JSON schema for the SDK)
  g3.ts           review / approve other people's PRs
  github.ts slack.ts repos.ts store.ts janitor.ts report.ts credentials.ts config.ts
skills/           server-side skills, loaded as the local plugin `pr-shepherd`
  shepherd/         pr-shepherd:shepherd, shepherd one of the owner's PRs to merge
  review/           pr-shepherd:review, review someone else's PR
local-skills/
  pr-shepherd-ship/ local skill: open a PR and register it (+ guard.sh hook)
migrations/       forward-only SQL
scripts/          deploy.sh update-secret.sh release.sh slack-manifest.sh install-local.sh docker-entrypoint.sh fake-reviewer.ts
.github/workflows/ ci.yml, release.yml
insta.template.yaml  InstaCloud template (pr-shepherd)
test/             vitest; fixtures in the reply formats of real reviewer bots (synthetic content)
```

## Security notes

- The shepherd agent runs with `bypassPermissions` and a write-capable GitHub token. Keep the PAT scoped to
  one org, keep Workflows off, and protect default branches (no force push, required approvals, dismiss
  stale approvals). Merges are executed by the harness and pinned to the head SHA the agent examined.
- Review-on-request runs other people's code. Those sessions carry no secrets except the Claude credential,
  run only for org members' PRs (external contributors get a static review), and use separate git mirrors.
- `approve` is open to anyone who can mention the bot in Slack, by design. Every request is logged with who asked.
- A Claude subscription token is meant for your own use. Each person runs their own deployment with their
  own credential. Use an API key if a deployment serves anything beyond that.
- `/healthz` and `/livez` expose no PR data or secret values.

## License

MIT, see [LICENSE](LICENSE).

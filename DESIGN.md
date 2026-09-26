# pr-shepherd — Design

> Status: v0.7 · "the owner" throughout is the deployment's configured owner (`config.owner`); "the bot" is this deployment, named by `config.bot.name`
> Stack: TypeScript + Claude Agent SDK (the owner's subscription or API key) + `gh` CLI
> Deployment: InstaCloud template `pr-shepherd` (compute, single instance + postgres); any container host with Postgres and a volume works

## 1. Goals

The owner writes code locally (Claude Code, Codex, or any other agent). Once the code becomes a PR, the bot takes over until it is squash-merged or needs the owner.

- **G1 Local-first.** The local agent opens the PR with the `pr-shepherd-ship` skill and registers it with the bot (`POST /prs`). The bot never scans for PRs on its own.
- **G2 Managed lifecycle.** Request reviewer bots in Slack → the agent handles comments → re-request review only from the relevant bots → request approval → squash merge. If the branch falls behind or conflicts, the agent rebases. The whole loop converges within a budget.
- **G3 Work when tagged.** `@<bot> review|approve <PR>` (`<bot>` is the Slack name the deployment was given, e.g. `@pr-shepherd`), in the same format as review-bot. Anyone in Slack can use it.

Non-goals: managing the lifecycle of other people's PRs; multi-instance deployment. Each deployment serves exactly one owner in one GitHub org; a team runs one deployment per person.

## 2. Design principles

1. **The agent makes judgments; the harness does deterministic work.** Anything that requires understanding content (comments, reviews, CI, whether to resend, whether to merge) goes to the agent. Deterministic work (identity and metadata checks, sending Slack requests, merging, counting, timers, cleanup) goes to the harness.
2. **The harness has three verbs: receive (inbox), run (scheduler), act (actuator).**
   - Receive: events from HTTP, Slack, and timers all go into the `events` table.
   - Run: decides when to run the agent and with which session. A PR has at most one run at a time.
   - Act: executes `next` from the agent's structured output, after policy and budget checks.
3. **The agent–harness interface has exactly two parts**: event messages go in, structured output comes out (SDK `outputFormat`). Managed sessions get no harness tools.
4. **The harness reads only metadata from GitHub** (state, author, draft). It writes to GitHub for only three things: merging, and G3 reviews and approvals. The agent reads all comment and review content itself.
5. **All state lives in postgres or on the `/data` volume**, so the process can be killed and restarted at any time. Every action with external side effects is recorded before it is executed, so re-executing it is safe.

| harness | agent (skills) |
|---|---|
| Registration, metadata checks, PR ↔ session mapping | Read the PR, handoff block, reviews, comments, CI; decide what to do now |
| Request review / re-review / approval in Slack from templates | Handle each comment: fix / reply / escalate / ignore |
| Recognize reviewer replies (generic rule, §5.3), wake the agent | Edit code, test, commit, push, reply, resolve threads |
| Schedule runs: debounce, steer, concurrency pools, quota | Rebase and resolve conflicts |
| Execute `next`: requests, timers, merge, escalation; rounds and budget | Emit structured output: what was handled, what comes next |
| Persistence, restart reconciliation, workspace cleanup, daily report | G3: review other people's PRs and produce the review content |
| G3: post reviews and approvals (owner's account) | |

Skills (`/app` is a local plugin named `pr-shepherd`, §5.4): `pr-shepherd:shepherd` (`skills/shepherd`) manages the owner's PRs; `pr-shepherd:review` (`skills/review`) does G3 reviews; `pr-shepherd-ship` is installed locally (`local-skills/pr-shepherd-ship`, not part of the server plugin). Skills are generic: they say "the owner", "the org" and "the bot", and every message names them in a `[context]` line (§5.1). Changing the workflow means changing a skill.

## 3. Architecture

```
Local (any agent)                                InstaCloud compute (always on, single instance, /data volume)
┌──────────────────────────┐                  ┌──────────────────────────────────────────────────┐
│ pr-shepherd-ship skill   │── POST /prs ────▶│ inbox ◀── HTTP / Slack (Socket Mode) / timers    │
│   gh pr create ──────────┼──▶ GitHub ◀──────┤   │                                              │
└──────────────────────────┘        ▲         │   ▼                                              │
                                    │         │ scheduler ── one long-lived session per PR ─┐    │
Slack #pr-review ◀──────────────────┼────────▶│   ▲                                         │    │
  review-bot / codex-bot / …        │         │   │ structured_output          event msgs ▼    │
                                    │         │ actuator ◀──────────────────────── Agent SDK     │
                                    └─────────┤   Slack requests / merge / timers    gh · git    │
                                              └───────────────────────┬──────────────────────────┘
                                                                      │ postgres
```

A typical round:

```
pr-shepherd-ship ─POST /prs─▶ harness: check metadata → start agent
agent: read handoff block, write summary ─▶ next: request_review [review-bot, codex-bot]
harness ─Slack─▶ <@review-bot> review <url>      <@codex-bot> review <url>      (one top-level message each)
codex-bot ─thread─▶ …verdict… review: <…#pullrequestreview-1>  ─▶ harness wakes agent
review-bot ─thread─▶ …verdict… review: <…#pullrequestreview-2>  ─▶ steered into the same run
agent: handle both reviews together, push, reply, resolve ─▶ next: request_review [review-bot, codex-bot]
…
agent: all approved ─▶ next: request_approve
review-bot ─thread─▶ approved as reviewer-account (<…#pullrequestreview-3>)  ─▶ wake agent
agent: CI green, CLEAN ─▶ next: merge sha=abc1234
harness: gh pr merge --squash --match-head-commit abc1234 ─▶ merged ─▶ clean up workspace
```

## 4. Identity and credentials

| Party | Method |
|---|---|
| GitHub | A **fine-grained PAT** `GH_TOKEN` on the owner's own account. Resource owner is the configured org (`config.org`), so it can only access that org's repositories. Permissions: Contents / Pull requests / Issues read-write; Commit statuses / Actions read-only (fine-grained tokens have no Checks permission); **Workflows not granted**. GitHub therefore rejects pushes that touch `.github/workflows/**` and any operation on repositories outside the org. At startup, run `gh auth setup-git`; the git commit author is the owner. (gh's OAuth login is not used: the same OAuth app inherits the `workflow` scope the account has already granted, and it cannot be removed.) |
| Claude | The owner's subscription token `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, valid for one year), for the owner's personal use only (§13.2); or `ANTHROPIC_API_KEY`. |
| Slack | One Slack app per deployment, named after `bot.name` (`scripts/slack-manifest.sh <name> [--owner <name>] [-o <file>] [--link]` generates the manifest and a prefilled *Create New App* link), Socket Mode; scopes in `slack-manifest.yaml`. One app serves one running deployment. |

- The owner's PRs are approved by review-bot (GitHub does not allow approving your own PR).
- G3 reviews and approvals are posted from the owner's GitHub account.
- Commits carry the trailer `Co-Authored-By: <bot.name> <<bot.name>@users.noreply.github.com>` (the agent takes the name from `[context]`). All user-visible text (Slack, PR comments, report) uses `bot.name`.
- How credentials are written: see §11.1. No InstaCloud console login is needed.

## 5. Harness

### 5.1 Events

| Event | Source |
|---|---|
| `registered` | `POST /prs` or `track`, new PR |
| `updated` | An already registered PR is registered again (another local push) |
| `review_done` | A reviewer replied in the request thread with a message containing a review link (§5.3) |
| `approve_done` | One of the approvers replied with a message containing a review link |
| `reviewer_error` | A reviewer / approver replied with an error message |
| `reviewer_stalled` | A reviewer / approver did not respond in time (§5.3) |
| `owner` | The owner replied in any request thread of the PR or in the PR's DM thread (§5.6), or used `tell` |
| `timer` | A time the agent scheduled with `next: wait` has arrived |
| `merge_failed` | The harness failed to merge |
| `continue` | The previous run used up `maxTurns` |
| `restarted` | The previous run was interrupted by a restart |

Each event has a `dedupe_key` (`channel:ts` for Slack messages, `timer:<id>` for timers). Duplicates are recorded once.

Messages delivered to the agent share one short format and state only what happened. Reviewer replies include the first line of the original message:

```
[event] review_done reviewer=codex-bot review=https://github.com/…/pull/528#pullrequestreview-1000000001
        first_line=":octagonal_sign: verdict: *request_changes*"
[event] reviewer_stalled reviewer=review-bot stage=no_ack waited=15m resends=0
[event] owner text="hold off on the Suggestions for now"
[policy] auto_merge=on rounds review-bot=2/4 codex-bot=1/4 runs=7/30
[context] bot=pr-shepherd owner=Owner (@owner-login) org=your-org
```

Every message ends with a `[policy]` line so the agent knows the current policy and budget (the harness still enforces them), followed by a `[context]` line naming this deployment's bot, owner (`owner.name` and GitHub login) and org. The skills refer only to "the bot", "the owner" and "the org" and resolve them from this line.

### 5.2 Registration `POST /prs`

```
POST <PR_SHEPHERD_URL>/prs
Authorization: Bearer <local gh auth token>
{ "url": "https://github.com/example-org/example-cli/pull/271" }
```

- Authentication: call GitHub `GET /user` once with the token; allow only if the login equals `config.owner.github`. The token is never written to disk or logged; the result is cached by hash for 1 hour.
- Checks (one `gh api` call): the repository belongs to `config.org` and is not in `excludeRepos`; the PR is open; the author is the owner; it is not a draft.
- Responses: `202` (registered, or already exists → `updated`), `401`, `403` (wrong repository or author), `409` (draft / merged / closed).
- HTTPS only.

### 5.3 Slack rounds

Follows the `#pr-review` convention: **each request is a new top-level message**, and the bot replies in its thread. The harness maps replies to the PR and bot via `review_requests.request_ts`.

**Every PR tags every configured reviewer** (the owner can narrow one PR with `set <pr> reviewers=…`); re-review rounds go only to the bots whose findings led to a code change, and are skipped when every reviewer approved and the push only applies their suggestions or small corrections (the approvers then see the final head). There is no default subset: list only the bots that should review every PR.

**Sending requests**: each reviewer has two templates in config, `request` (first time) and `rerequest` (re-review). Bots whose templates use `{mentions}` are combined into one message (for example summary-bot-a + summary-bot-b); bots whose templates use `<@{slack}>` each get their own message. For templates without `{summary}`, the agent's summary is posted as a PR comment, which the bot reads during review.

| bot | request / rerequest |
|---|---|
| review-bot `UREVIEWBOT` | `<@review-bot> review {url}` / same (it tracks rounds itself) |
| codex-bot `UCODEXBOT` | `<@codex-bot> review {url}` / same |
| summary-bot-a `USUMMARYA`, summary-bot-b `USUMMARYB` | `{mentions} please review: {url}\n{summary}` / `{mentions} pushed fixes, please re-review: {url}\n{summary}` |
| review-bot (approve) | `<@review-bot> approve {url}` |

**Recognizing replies**: no per-bot regexes, just one generic rule. Only messages from the tagged bot inside the request thread count:

1. Contains a GitHub review link (`/pull/\d+#pullrequestreview-\d+`) → `review_done` / `approve_done`;
2. Otherwise, starts with `:x:` or `:warning:` → `reviewer_error`;
3. Otherwise → progress message; recorded as an ack and refreshes the last-activity time.

Reviewer bot reply formats (examples):

| bot | example reply | rule |
|---|---|---|
| review-bot | `:octagonal_sign: review verdict: *request_changes*` … `review: <…#pullrequestreview-N>` | 1 |
| codex-bot | `:white_check_mark: verdict: *approved*` … `review: <…#pullrequestreview-N>` | 1 |
| summary-bot-a / summary-bot-b | `… Full review: <…#pullrequestreview-N>` | 1 |
| summary-bot-a / summary-bot-b | `:x: Reviewed … changes requested … <…#pullrequestreview-N>` | 1 (starts with `:x:` but has a link) |
| review-bot (approve) | `:white_check_mark: <url> — approved as reviewer-account (<…#pullrequestreview-N>)` | 1 |
| any | `:x: <url> — failed (<reason>)` | 2 |
| any | `:mag: starting code review on <url> …` | 3 |

The rule covers all 17 samples in `test/fixtures/slack/`. Whether a verdict approves or requests changes is decided by the agent reading the GitHub review; the harness does not parse it.

**Timeouts** (based only on Slack, independent of the bot):

- No message at all within `ackTimeoutMin` (default 15) after sending → `reviewer_stalled stage=no_ack`;
- After an ack, no review link within `replyTimeoutMin` (default 120; review-bot's queue often exceeds 1 hour) of the last activity → `reviewer_stalled stage=no_reply`.

The agent decides whether to resend after a timeout (it first checks GitHub for a review the bot already posted whose Slack reply was lost). A resend is a new top-level request; the old request is marked `superseded`. Late replies in the old thread still count; the first to arrive wins.

**Triggering**: every `review_done` wakes the agent without waiting for other reviewers. Verdicts arriving at nearly the same time are merged by debounce (§5.4).

### 5.4 Scheduling and sessions

- Each managed PR has one long-lived session (`prs.session_id`). Each G3 review uses a temporary session.
- **Run**: one `query()` call. `prompt` is a pushable queue implemented by the harness; `outputFormat` is the §5.5 schema.

| PR state | When a new event arrives |
|---|---|
| No session | Create a session: the event + "take over per `pr-shepherd:shepherd`" |
| Running | Push into the queue immediately (steer); the agent sees it after the current step |
| Idle | Wait `debounceSec` (default 30) to collect follow-up events, merge them into one message, and start a new run with `resume` |
| `needs_human` / `paused` | Events stay in the inbox, undelivered; on resume they are delivered at once, with a first line explaining why |
| Terminal | Discard |

- A run ends when the result's `queued_turn_count` is 0 and the inbox has no new events for the PR; the queue is then closed. If there are several results, the last one wins.
- Concurrency: managed pool 1, G3 review pool 2; when full, jobs queue FIFO. Steering does not take a slot.
- Options: `permissionMode: 'bypassPermissions'`; `maxTurns: 60`; `model` / `effort` / `fallbackModel` from `config.agent` (per-role override for shepherd vs review runs; unset = Claude Code default); `settingSources: ['project']` (loads the target repository's `CLAUDE.md`); `plugins: [{ type: 'local', path: '/app' }]` (loads our skills); `CLAUDE_CONFIG_DIR=/data/claude`.
- Working directories: one bare mirror per repository at `/data/repos/<owner>/<repo>.git`, one worktree per PR at `/data/worktrees/<owner>-<repo>-<n>`. **Paths must be stable**: session records are stored per cwd, so a changed path cannot be resumed.
- **Agent notes** live in the worktree at `.pr-shepherd/notes.md` (added to `.git/info/exclude`): the last comment handled in each thread, per-round summaries, rebase records. They share the worktree's lifetime, survive session compaction or rebuild, and need no extra tools.
- **S0 findings** (SDK 0.3.281):
  - Steered events join the current turn; `structured_output` covers all of them;
  - `outputFormat` still applies after resume;
  - Skills load via the plugin;
  - After `interrupt()`, the result is `error_during_execution` and the iterator then throws `process_exited_nonzero`. When the harness itself initiated the interrupt, it treats this as a normal end.

### 5.5 Structured output

The schema is defined with zod in `src/output.ts`. `z.toJSONSchema()` produces the schema passed to the SDK, and the result is parsed with the same zod schema.

```jsonc
{
  "handled": [                                // every review handled in this run (including steered ones)
    { "reviewer": "review-bot", "review_url": "…#pullrequestreview-123",
      "items": [ { "url": "…#discussion_r456", "severity": "Critical", "action": "fix", "commit": "def5678", "note": "…" } ] }
  ],
  "rebase": { "onto": "main@9a8b7c6", "conflicts": ["src/foo.ts"], "note": "…" },   // null when none
  "status_line": "waiting for review-bot re-review; CI green",   // one line for the status command and daily report
  "next": { "action": "request_review", "reviewers": ["review-bot"], "summary": "…", "resend": false }
}
```

`next` is one of the following; the harness executes it per the table:

| `next` | Harness executes | Pre-execution check |
|---|---|---|
| `request_review {reviewers, summary, resend}` | Send requests per §5.3; for non-resends, each bot's round +1 | Reviewer is in the PR's reviewer set; the bot has no open, non-timed-out request; rounds do not exceed `max_rounds` |
| `request_approve {approvers?}` | Ask the configured approvers (all of them, or the named subset) to approve; `{mentions}` templates merge into one message; the first approval wins | Names must be configured approvers; an approver with a live, non-stalled request is skipped; at most 2 requests per approver per head SHA; nothing sendable → rejected with the reason |
| `merge {sha, title}` | `gh pr merge --squash --delete-branch --match-head-commit <sha>`, body = PR body minus the handoff block | `auto_merge` is on and not paused; when off, wait for the owner's confirmation (in the PR's DM thread; `merge <pr>` releases it) |
| `wait {minutes, reason}` | Timer; delivers `timer` when due | `minutes` ≤ 60 |
| `escalate {reason}` | Tell the owner (PR's DM thread, §5.6) the reason and the escalated items in `handled`; move to `needs_human` | — |
| `done {reason}` | The PR has been closed or no longer needs management: enter a terminal state | Harness checks state once to confirm it is closed / merged |

- **Record before executing**: the output is first written to `runs.output`; after execution `runs.applied_at` is set. On restart, output that was never applied is applied once; Slack requests are deduplicated by `run_id`.
- **Failure handling**:
  - Result is `error_max_structured_output_retries`, or a pre-execution check fails → resume once, telling the agent why; if it fails again → `needs_human`;
  - `error_max_turns` → deliver `continue` automatically;
  - Merge failure → deliver `merge_failed` with gh's error message.

### 5.6 State and budget

`prs.status` has only five values: `active`, `needs_human`, `paused`, `merged`, `closed`.
"What it is waiting for" is not stored separately; it is derived from data: an open request → waiting for review or approval; a timer → waiting for time; a run in progress → processing; a pending merge → waiting for the owner's confirmation.

| Budget | When exceeded |
|---|---|
| Rounds per bot, `max_rounds` (default 4) | Reject the re-review request, move to `needs_human` |
| Runs per PR, `maxRunsPerPr` (default 30, including wait, continue, resend) | Move to `needs_human` |
| Subscription quota | Pause all pools until the reset time, then resume; DM the owner |

- **One DM thread per PR, only when needed.** The owner is DMed about a PR only when it needs them: entering `needs_human` (the reason) or a merge waiting for confirmation. The first such DM starts the PR's thread (`prs.dm_channel` / `prs.dm_ts`); later ones reply in it, broadcast so they also show in the DM. The database guarantees one thread: the thread is recorded with a compare-and-set (`… where dm_ts is null`), so when two notices race on a PR that has none, both DM, one wins, and the loser deletes its DM (`chat.delete`) and replies in the winner's thread. Informational notices (merged, a run retried once, closed outside the bot) are not DMed; the daily report covers them.
- Ways out of `needs_human`: **a reply in the PR's DM thread** (delivered as an `owner` event; the PR goes back to `active` and the harness reacts `:eyes:`; a reply while the PR is active is steered the same way, like `tell`), a reply in a request thread, `tell`, or `resume`; if the reason was rounds, raising them with `set rounds=` resumes automatically. `resume` resets the run count. In a DM thread, text that parses as a command (`merge <pr>`, `status`, `resume <pr>`, …) is still a command.
- Global emergency stop: `pause all` interrupts all runs and freezes all timers; `resume all` resumes.

### 5.7 Restart and shutdown

- Runs as a single instance.
- SIGTERM: stop accepting new runs, interrupt running sessions, wait at most 30 seconds, mark them `interrupted`.
- On startup:
  1. Apply runs that have output but were not applied;
  2. Deliver `restarted` for runs that are `running` / `interrupted`;
  3. Re-read the Slack threads of all open requests (messages sent while disconnected are lost);
  4. Fire overdue timers immediately.
- On `restarted`, the agent reconciles first: `git status`, any half-finished rebase (`git rebase --abort` and redo), unpushed commits, notes.

### 5.8 Workspace cleanup

Workspace = worktree (including dependencies and build output) + the matching local branch in the mirror + `/data/tmp/<kind>-<owner>-<repo>-<n>`. The harness performs cleanup.

| Trigger | When |
|---|---|
| The owner's PR is merged, closed, or `untrack`ed | Immediately |
| G3: the owner approved someone else's PR | Immediately |
| **Sweep** (every 30 minutes, one batched GraphQL query for the state of every PR with a workspace) | Merged / closed → clean up; the owner's PRs also move to a terminal state (e.g. the owner merged by hand). G3 workspaces with no new request for 7 days are also cleaned up |

- Steps: stop the session, delete timers → record a `git status` summary (no push) → `git worktree remove --force` + `worktree prune` → delete the local branch → delete tmp → set `workspaces.cleaned_at`.
- Only directories registered in the `workspaces` table and located under `/data/worktrees/` or `/data/review-worktrees/` are deleted. Running ones are skipped; failures retry on the next sweep.
- Daily janitor: delete Claude session records older than 30 days; weekly `git gc` on mirrors; delete mirrors that have had no workspace for 30 days. A mirror's idle start is recorded in a `pr-shepherd-idle-since` file inside the bare repository.

### 5.9 Daily report

Every day at 09:00 (`timing.timezone`), DM the owner one message, built only from the database:

```
<bot.name> · 09-24
G3: review 5 (✅3 ⛔2) · approve 4
Owner PRs: comments handled 12 (fix 9 · reply 2 · escalate 1) · merged 2
Open 3:
• example-api#530 needs owner: two reviewers disagree
• example-cli#271 waiting for review-bot re-review (r2)
• example-console#540 waiting for CI
```

- "Open" has one line per PR, taken from the `status_line` of the latest output; `needs_human` comes first.
- Empty sections are omitted; if there is nothing, nothing is sent. The `report` command triggers it at any time.

## 6. `pr-shepherd:shepherd` (manages the owner's PRs)

### 6.1 Handoff block

The local agent and the bot pass context only through the handoff block in the PR body:

```
<!-- pr-shepherd:handoff v1
agent: claude-code | codex | ...
session: <local session ID, optional>
-->
### Handoff
**Intent**: what this solves and the overall approach (1–3 lines)
**Rejected**: approaches rejected and why (1 line each)
**Constraints**: things that must not change, behavior that must be preserved (1 line each)
**Known gaps**: known leftovers, work deliberately deferred to later PRs
<!-- /pr-shepherd:handoff -->
```

- Writer (`pr-shepherd-ship`): at most 15 lines; only information not visible in the code or diff; empty fields are `-`. It is visible to reviewers, on purpose.
- Reader: **Constraints** and **Rejected** are hard constraints. Comments that would violate them must be escalated, and conflict resolution must not violate them either. `session` is used only when escalating: give the owner a ready-to-paste `claude --resume <session> "…"`. A PR without a handoff block is still managed. When merging, the harness strips the block from the squash body.

### 6.2 Each run

1. Read notes; on `restarted`, reconcile first.
2. Use `gh` to see the PR's current state: head, base, `mergeStateStatus`, checks, all reviews, and unresolved threads. Commits the owner pushed by hand and comments left by humans on GitHub are discovered here.
3. Handle events:
   - `registered`: read the handoff block, write a summary → `request_review` (all reviewers, summary = Intent + 1–2 Worth checking);
   - `review_done`: read the review; handle inline comments and findings in the body (§6.3). Even for approvals, check whether Suggestions are worth fixing along the way;
   - `reviewer_stalled` / `reviewer_error`: first look on GitHub for a review from that bot posted after the request; if found, handle it as `review_done`. Otherwise `request_review` with `resend: true`. If 2 resends still fail, `escalate` and suggest removing the bot from the reviewers;
   - `approve_done`: go to §6.5;
   - `timer`: check whether what was awaited (CI, new comments) has progressed;
   - `owner`: do what the owner says; highest priority;
   - `merge_failed`: check the cause; usually a rebase is needed or CI is not done.
4. Decide `next`:
   - Changes made or conflicts resolved in this run → `request_review`, reviewers = bots whose reviews were handled in this run (all of them when conflicts were resolved);
   - Every reviewer's latest review approves, no unresolved threads, CI green → `request_approve`;
   - Approved, no new push since approval, required checks green, `CLEAN` → `merge`;
   - Waiting for CI or other reviewers → `wait` (≤ 30 minutes; a reviewer reply wakes it early);
   - Needs the owner → `escalate`.
5. Update notes and emit structured output.

### 6.3 Handling comments

- Per thread, pick one of four: **fix** (change code), **reply** (explain, e.g. a misreading, or Suggestion / Information level), **escalate** (design disagreement, unclear requirements, out of scope, violates handoff constraints, two reviewers conflict, or a change needed in another repository), **ignore** (pure agreement, outdated).
- **Work outside this repository** (an e2e test in a separate test repo, a companion change in another service, docs, infra): the agent pushes only to the PR branch, so it replies on the thread that the change was handed to the owner, leaves it unresolved, and escalates naming the repo and exactly what to add. When the owner answers (§5.6), it checks the linked PR or commit, replies on the thread with the link, resolves it, and continues (re-review for that reviewer if it requested changes). A test in the PR's own repository is a normal fix.
- Flow: change code, run tests → commit (never amend pushed commits) → `git fetch`; if the remote has moved, rebase onto the remote branch first → push → reply to each thread (fixes link the commit) → resolve fixed threads.
- Changes are limited to responding to comments and resolving conflicts.
- Multiple reviews at once: change together, push once; if two reviews point at the same spot, change it once; if two reviews conflict, escalate both; for comments on an old SHA, first confirm the issue still exists.
- Before pushing, check the threads being handled again: skip deleted ones, use the new content of edited ones, don't repeat work on threads someone else resolved.
- Notes record the last comment id replied to in each thread; later replies are new items.
- Summaries follow the channel's style: one paragraph of plain prose explaining how each finding was fixed and in which commit, with reasons for any not accepted; add a sentence if there was a rebase. At most 5 lines.

### 6.4 Rebase

- Only when needed: `DIRTY`; `BEHIND` and the repository requires up-to-date branches; a reviewer's comment depends on new changes in base.
- `git rebase origin/<base>` → resolve conflicts after understanding both sides' intent → run the full test suite → `git push --force-with-lease=<branch>:<remote SHA before rebase>` → explain on the PR what it was rebased onto and how conflicts were resolved.
- Use only `--force-with-lease`, and only after a rebase. If the lease fails, start over once; if it fails again, escalate.
- Escalate when: conflicts involve semantic trade-offs, the two sides' intents contradict, tests fail, or more than 10 files conflict.
- A rebase may dismiss approvals; re-check before merging and `request_approve` if needed.

### 6.5 Merge

- The agent only decides whether the PR can be merged and outputs `merge {sha}`; the harness executes it (§5.5). `--match-head-commit` guarantees that the merged commit is the one the agent examined.
- `BEHIND` / `DIRTY` → rebase first, `wait` for CI, and `request_approve` again if the approval was dismissed.

## 7. G3: review / approve other people's PRs

### 7.1 Commands

Compatible with the phrasings used in the channel: `review <pr>`, `review this <pr>`, `please review: <pr>`, `(pushed fixes,) please re-review: <pr>`; `approve <pr>`, `approve this <pr>`, `please approve <pr> - <note>`. `<pr>` may be `<url>`, `<url|repo#N>`, or `owner/repo#N`; text after the link is passed to the agent as context.

### 7.2 Harness

- Checks: the PR belongs to `config.org`, is open, and its author is not the owner (if it is, reply "use G2").
- **review**:
  - Reply `:mag: starting code review on <url> …`, or when full `:hourglass_flowing_sand: all review slots are busy — queued, will start as soon as one frees up…`; add `:eyes:` to the parent message;
  - Duplicate requests for the same PR while queued are merged;
  - The working directory is the PR's review worktree `/data/review-worktrees/<owner>-<repo>-<n>`, reused across rounds; the harness fetches the latest head before each start;
  - **Isolation**: reviews run other people's code, so the session environment has no secrets other than Claude authentication. The agent can read GitHub only through a single tool, `gh_read(args)`: the harness runs `gh` on its behalf, allows only read-only commands, and only for repositories under `config.org`. It can be used to cross-check companion PRs in related repositories (the command must name the repository: `--repo`, a link, or `api repos/<org>/...`; searches must be scoped to the org). Reviews use a separate mirror (`/data/review-repos`), not shared with the managed mirrors;
  - The agent outputs a structured review (§7.3), **which the harness posts**: a GitHub review from the owner's account (`COMMENT`, with inline comments), then the verdict in the thread, and `:white_check_mark:` / `:no_entry:` on the parent message.
- **approve**: no agent needed. The harness `APPROVE`s from the owner's account (body `LGTM`), replies `:white_check_mark: <url> — approved as <login> (<review link>)`, then cleans up the PR's review workspace. On failure it replies `:x: <url> — failed (<reason>)`.
- Unrecognized commands get `Unsupported. I can: *review* or *approve* a PR, *status*, *help*.`

### 7.3 `pr-shepherd:review`

1. Use `gh_read` to see its own previous reviews on this PR; if any, look only at the diff since the last reviewed SHA.
2. Check correctness, security, performance, and engineering quality against the PR description and linked issues. Verify key fixes in reverse (temporarily revert the fix, confirm tests go red, restore). Report honestly what was run, what was not, and why. PRs from external contributors get a static review only; their code is not run.
3. Output:

```jsonc
{
  "round": 2, "head_sha": "5efeec6",
  "verdict": "approved",                  // approved | request_changes (any Critical means the latter)
  "counts": { "critical": 0, "suggestion": 2, "information": 3 },
  "summary": "…", "verified": "…",
  "comments": [ { "path": "src/a.ts", "line": 42, "severity": "Suggestion", "body": "…" } ]
}
```

The harness posts it in a fixed format. The GitHub review body is `## Verdict: … — N Critical · N Suggestion · N Information` + summary + `### Verified` + `### Findings`; inline comments carry a prefix such as `**[Critical]**`. In Slack:

```
:white_check_mark: review verdict: *approved*          (request_changes uses :octagonal_sign:)
review: <review link>
Round K on <repo>#N (<title>) at <short SHA> — COMMENT/approved, 0 Critical, 2 Suggestion, 3 Information. <summary>
```

## 8. `pr-shepherd-ship` (local)

Every PR in a repository of the configured org goes through this skill. The skill description tells the agent to use it whenever a PR is opened; Claude Code also has a PreToolUse hook (`guard.sh`) that blocks `gh pr create` without the `PR_SHEPHERD_SHIP=1` prefix, but only in repositories owned by `PR_SHEPHERD_ORG` from `~/.config/pr-shepherd/config` (no org configured → it allows everything); for Codex the same rule is written in `~/.codex/AGENTS.md`. `scripts/install-local.sh --url <bot-url> --org <org>` sets all of this up (§12).

1. Run the repository's checks; 2. commit, push; 3. write the handoff block; 4. `gh pr create` (not draft); 5. register:

```bash
curl -fsS --max-time 15 -X POST "$PR_SHEPHERD_URL/prs" \
  -H "Authorization: Bearer $(gh auth token)" -H "Content-Type: application/json" \
  -d '{"url":"<PR link>"}'
```

- `PR_SHEPHERD_URL` is read from the environment or the `PR_SHEPHERD_URL=` line of `~/.config/pr-shepherd/config`; if missing, stop and ask the owner. Registration must not be skipped.
- Registration failure: keep the PR, say clearly that it is "not registered" and why; the fix is to rerun or `@<bot> track <PR>`.
- Running pr-shepherd-ship again on a registered PR triggers `updated`.

## 9. Slack commands

`<pr>` is a link or `owner/repo#N`. Owner-only commands also work in DMs. The bot adds `:eyes:` on receiving a command.

| Command | Who | Effect |
|---|---|---|
| `review` / `approve …` (§7.1) | anyone | G3 |
| `status [pr]` | anyone | Managed PRs with their `status_line` and rounds; with a pr, also the latest `handled` summary |
| `track <pr>` / `untrack <pr>` | owner | Register / stop managing and clean up |
| `tell <pr> <text>` | owner | Steer a message to the agent; replying directly in a request thread or in the PR's DM thread has the same effect |
| `set <pr> rounds=6 reviewers=review-bot,codex-bot auto_merge=off` | owner | Change this PR's policy; any subset of fields |
| `merge <pr>` | owner | Release a merge waiting for the owner's confirmation |
| `pause` / `resume [<pr>\|all]` | owner | Pause / resume; `all` is the global emergency stop |
| `report` / `help` | owner / anyone | Send the report now / list commands |

## 10. Data

`migrations/` is authoritative. Below is 001; 002 adds `review_requests.head_sha` (approve requests are counted per head SHA) and `prs.tracked_at` (re-tracking restarts the round count); 003 adds `credential_expiry`; 004 adds `prs.dm_channel` / `prs.dm_ts` (the PR's DM thread with the owner, §5.6).

```sql
create table prs (
  id bigserial primary key, repo text not null, number int not null,
  status text not null,                    -- active|needs_human|paused|merged|closed
  reason text,                             -- reason for needs_human
  session_id text,
  reviewers text[] not null,
  max_rounds int not null default 4,
  auto_merge bool not null default true,
  pending_merge jsonb,                     -- {sha, title} awaiting owner confirmation when auto_merge=off
  run_count int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closed_at timestamptz,
  unique (repo, number)
);

create table review_requests (             -- each request to each bot
  id bigserial primary key, pr_id bigint not null references prs, run_id bigint,
  kind text not null,                      -- review|approve
  bot text not null, round int not null, resend bool not null default false,
  channel text not null, request_ts text not null,
  sent_at timestamptz not null default now(), last_activity_at timestamptz, acked bool not null default false,
  done_at timestamptz, review_url text, first_line text,
  superseded bool not null default false,
  unique (run_id, bot)                     -- dedupe when re-applying
);
create index on review_requests (channel, request_ts);

create table events (                      -- inbox
  id bigserial primary key, pr_id bigint references prs, kind text not null,
  payload jsonb not null default '{}', dedupe_key text unique,
  created_at timestamptz not null default now(), run_id bigint   -- run it was delivered to; null = pending
);

create table runs (
  id bigserial primary key, pr_id bigint references prs, job_id bigint,
  session_id text, status text not null,   -- running|ok|interrupted|error|max_turns|bad_output|quota
  turns int, usage jsonb, output jsonb,
  started_at timestamptz not null default now(), ended_at timestamptz, applied_at timestamptz
);

create table jobs (                        -- G3
  id bigserial primary key, kind text not null, repo text not null, number int not null,
  requested_by text not null, channel text not null, thread_ts text not null,
  status text not null default 'queued',   -- queued|running|done|failed
  verdict text,                            -- review: approved|request_changes; approve: approved|failed
  created_at timestamptz not null default now(), ended_at timestamptz
);

create table timers (
  id bigserial primary key, pr_id bigint not null references prs,
  kind text not null,                      -- wait|ack_timeout|reply_timeout
  ref_id bigint,                           -- review_requests.id for timeouts
  fire_at timestamptz not null, fired_at timestamptz, note text
);

create table workspaces (
  id bigserial primary key, kind text not null,   -- shepherd|review
  repo text not null, number int not null, path text not null unique,
  last_used_at timestamptz not null default now(), cleaned_at timestamptz,
  unique (kind, repo, number)
);
```

## 11. Configuration and deployment

Config (no secrets). The real config is **not committed**. Sources, first match wins: the `PR_SHEPHERD_CONFIG` environment variable (a secret; YAML text or a one-line JSON object — YAML is a JSON superset), else the file at `CONFIG_PATH` (default `config.yaml`, gitignored). `config.example.yaml` is the committed template. Invalid config fails startup.

```yaml
bot: { name: pr-shepherd }                     # optional; this deployment's display name (Slack, PR comments, commit trailer, report)
org: your-org                                  # required; the only GitHub org the bot works in
owner: { github: owner-login, slack: UOWNER, name: Owner }   # required github + slack; name defaults to github
reviewChannel: pr-review                       # required
reviewers:                                     # required, ≥ 1
  - { name: review-bot,    slack: UREVIEWBOT, request: "<@{slack}> review {url}", rerequest: "<@{slack}> review {url}" }
  - { name: codex-bot,     slack: UCODEXBOT,  request: "<@{slack}> review {url}", rerequest: "<@{slack}> review {url}" }
approvers:                                                                                # required, one or more
  - { name: review-bot, slack: UREVIEWBOT, request: "<@{slack}> approve {url}" }
  - { name: codex-bot,  slack: UCODEXBOT,  request: "<@{slack}> approve {url}" }
# Optional; the values shown are the defaults.
excludeRepos: []
agent: { model: claude-opus-5-5 }   # optional (unset = Claude Code default); per-role overrides under shepherd / review
limits: { maxRounds: 4, maxRunsPerPr: 30, maxTurns: 60, shepherdConcurrency: 1, reviewConcurrency: 2 }
timing: { debounceSec: 30, ackTimeoutMin: 15, replyTimeoutMin: 120, sweepMin: 30, reviewIdleDays: 7, reportAt: "09:00", timezone: America/Los_Angeles }
```

Partial `limits` / `timing` objects are filled from the defaults. **Environment overrides** (non-empty values win over the config text; meant for template deploys, where a few identity fields are easier to set as plain variables):

| Variable | Config path |
|---|---|
| `PR_SHEPHERD_BOT_NAME` | `bot.name` |
| `PR_SHEPHERD_ORG` | `org` |
| `PR_SHEPHERD_OWNER_GITHUB` / `PR_SHEPHERD_OWNER_SLACK` / `PR_SHEPHERD_OWNER_NAME` | `owner.github` / `owner.slack` / `owner.name` |
| `PR_SHEPHERD_REVIEW_CHANNEL` | `reviewChannel` |
| `PR_SHEPHERD_MODEL` | `agent.model` |
| `PR_SHEPHERD_EFFORT` | `agent.effort` |

A secret value is one line, so for deployment the YAML is usually converted to one-line JSON: `yq -o json -I0 config.yaml`, or `node -e 'console.log(JSON.stringify(require("yaml").parse(require("fs").readFileSync("config.yaml","utf8"))))'`.

Environment variables: `PORT` (8080), `DATA_DIR=/data`, `CLAUDE_CONFIG_DIR=/data/claude`, `LOG_LEVEL`. Secrets: `DATABASE_URL` (bound), `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PR_SHEPHERD_CONFIG`.

Deployment: always on, single instance, a volume mounted at `/data` (10Gi); the image includes Node 22, git, gh, jq, python3 and Go (Dockerfile build args: `GO_VERSION`, empty skips Go; `EXTRA_APT_PACKAGES` for whatever the target repositories' test suites need). The HTTP surface is `POST /prs` (§5.2), `GET /livez` and `GET /healthz`, with no business data:

- `/livez`: the process is up and the database answers. This is the platform healthcheck; it does not wait for the asynchronous credential checks, so a bad token never causes a restart loop.
- `/healthz`: full readiness — database, each credential (GitHub, Slack, Claude) with `checkedAt` and `expiresAt`, free disk on `/data` (≥ 20%). Details say only what failed, never secret values.

**Primary path — InstaCloud template.** `insta.template.yaml` (template code `pr-shepherd`) defines two services: `db` (postgres, `DATABASE_URL` bound) and `web` (image `ghcr.io/v01dstar/pr-shepherd:<version>`, port 8080, healthcheck `/livez`, volume `/data`). Required variables: `GH_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PR_SHEPHERD_CONFIG`, and one of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; optional: the `PR_SHEPHERD_*` overrides above and `LOG_LEVEL`.

```bash
insta template deploy https://github.com/v01dstar/pr-shepherd            # prompts for each variable
insta template deploy https://github.com/v01dstar/pr-shepherd \
  --set GH_TOKEN=… --set SLACK_BOT_TOKEN=… --set SLACK_APP_TOKEN=… --set CLAUDE_CODE_OAUTH_TOKEN=… \
  --set PR_SHEPHERD_CONFIG="$(yq -o json -I0 config.yaml)"
```

**Release pipeline.** `scripts/release.sh <x.y.z>` bumps `package.json` and the template's image tag, commits and tags `v<x.y.z>`. The tag triggers `.github/workflows/release.yml`, which builds a multi-arch image and pushes `ghcr.io/<owner>/pr-shepherd:<version>` and `:latest`; `.github/workflows/ci.yml` runs typecheck and tests on pushes and PRs. The GHCR package must be made public once so template deploys can pull it.

**Source path** (maintainers, dev environments, unreleased versions): `scripts/deploy.sh --from-source [--branch <name>]` builds from the working tree and deploys with `insta deploy`; §11.1.

### 11.1 Credentials: one local file, no console login

**Template path (for anyone):** the `pr-shepherd-setup` agent skill (in `local-skills/`, linked from `.claude/skills` and `.agents/skills` so Claude Code and Codex find it in a fresh clone) guides the user through the Slack app, owner/org, reviewer bots and optional settings, writes and validates `config.yaml` (`npm run check-config`), and ends with the deploy command. Credentials never pass through the agent: the user writes them into `deploy.env` (gitignored, from `deploy.env.example`), and the skill only checks which variables are set. `scripts/deploy.sh` validates both files, creates/links the InstaCloud project, and runs `insta template deploy ./` with every value passed from variables (never typed on the command line), the config as one-line JSON. When the template's image can't be pulled anonymously (`scripts/image-pullable.mjs`: not released yet, or the GHCR package is private), with `--from-source`, or when the project already has the `pr-shepherd` service (a redeploy: `insta template deploy` only creates, so into an existing project it would add a second `db-2` / `pr-shepherd-2` set and a second bot on the same Slack app), the script skips the template and creates the same services itself when missing (`db`, `pr-shepherd` with a `/data` volume, `DATABASE_URL` bound, variables set on stdin), then deploys the template's image with `insta deploy --image <image> --group pr-shepherd`, or builds the bot from the checkout with `insta deploy . --group pr-shepherd` (unreleased image or `--from-source`). A redeploy therefore updates the existing service in place and keeps its database and `/data`. (Going through the template first does not work: a source deploy into a template-created service whose image failed is refused with 409.) A link to a deleted project is moved aside and a new project created. It also undoes the `.claude/skills/` line `insta project create` appends to `.gitignore`, which would hide the repo's own skills.

`deploy.env` is the single source of the credentials and `config.yaml` of the config; `scripts/deploy.sh` is idempotent, so re-running it redeploys with both. With the template, secrets are the template variables above; on the source path they are set with `insta secrets set <NAME>`, which reads the value from stdin, so it never appears on the command line or in history. The compute service is always `pr-shepherd`.

| secret | Source | What the owner does |
|---|---|---|
| `DATABASE_URL` | `insta secrets bind` (template: bound automatically) | nothing |
| `GH_TOKEN` | fine-grained PAT (permissions listed in `deploy.env.example`); revocable on its own | Create it once on GitHub's website (max one year); if the org requires approval, an org owner must approve |
| `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) | `claude setup-token` | Authorize once, put it in `deploy.env` |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Create the app on Slack's website from `scripts/slack-manifest.sh <bot-name>` | The only web step; put both in `deploy.env` |
| `PR_SHEPHERD_CONFIG` | `config.yaml`, validated, as one-line JSON | `scripts/deploy.sh` or `scripts/update-secret.sh config` uploads it |

- All secrets are scoped to the deployment's compute service (`--service compute/pr-shepherd`), so only it can see them.
- Rotation: edit `deploy.env` (or `config.yaml`), then `scripts/update-secret.sh <NAME|config>... [--branch <name>]` pushes just those values over stdin, without a rebuild. The service redeploys automatically after a write.
- Validated at startup and every 6 hours: `GH_TOKEN` is a fine-grained PAT and `gh api user` is the owner; Slack `auth.test`; one minimal Claude call. On failure, DM the owner with the matching `update-secret.sh` command.
- Expiry warnings before a token dies (table `credential_expiry`): the GitHub PAT's expiry comes from the `github-authentication-token-expiration` response header; the Claude token has no expiry API, so its one-year life is counted from the first time the deployment saw it (a new token resets the count). The owner gets a DM at 30, 14, 7, 3 and 1 days left — each threshold once per token — with the rotate command. `/healthz` shows each `expiresAt`, and the daily report lists tokens expiring within 30 days. Slack tokens do not expire (token rotation is off in the manifest), so they are only covered by the failure check.

## 12. Layout and milestones

```
pr-shepherd/
├── DESIGN.md  README.md  LICENSE  config.example.yaml  deploy.env.example  Dockerfile  slack-manifest.yaml  insta.template.yaml
├── .claude-plugin/plugin.json   skills/{shepherd,review}/SKILL.md   local-skills/{pr-shepherd-ship/{SKILL.md,guard.sh},pr-shepherd-setup/SKILL.md}
├── .github/workflows/{ci,release}.yml
├── migrations/   test/fixtures/slack/
├── scripts/
│   ├── deploy.sh  check-config.ts     # template deploy from deploy.env + config.yaml; config validation (§11.1)
│   ├── image-pullable.mjs             # can the template's image be pulled anonymously? (deploy.sh falls back to source)
│   ├── update-secret.sh               # push changed credentials / config to the deployment (§11.1)
│   ├── release.sh                     # version bump + tag → release workflow (§11)
│   ├── slack-manifest.sh              # Slack manifest for this deployment (+ prefilled create link)
│   ├── install-local.sh               # local ship skill, config, Claude Code hook, Codex rule (§8)
│   ├── deployment-url.sh              # the linked deployment's URL (deploy.sh, install-local.sh)
│   └── docker-entrypoint.sh  fake-reviewer.ts
└── src/
    ├── index.ts          # startup, shutdown, restart reconciliation
    ├── inbox.ts          # event ingestion and dedupe; Slack reply classification (§5.3)
    ├── scheduler.ts      # debounce, steer, concurrency pools, sessions; [policy]/[context] lines
    ├── actuator.ts       # execute next: Slack requests, merge, timers, escalation; budget
    ├── output.ts         # zod schemas (managed + G3)
    ├── slack.ts  github.ts  repos.ts  janitor.ts  report.ts  g3.ts
    └── config.ts  db.ts  http.ts  credentials.ts
```

`scripts/install-local.sh --url <bot-url> --org <org>` (run by `scripts/deploy.sh` on the deploying machine, which also waits for `/healthz`; both flags default to the linked deployment and `config.yaml`) symlinks `pr-shepherd-ship` into `~/.claude/skills` and `~/.codex/skills`, writes `~/.config/pr-shepherd/config` (`PR_SHEPHERD_URL=` and `PR_SHEPHERD_ORG=` lines), adds the Claude Code `PreToolUse` Bash hook running `guard.sh` (idempotent), and a managed rule block in `~/.codex/AGENTS.md`. `--uninstall` reverses it.

| Milestone | Scope | Acceptance |
|---|---|---|
| M0 | Skeleton, migrations, `/livez` + `/healthz`, template and source deployment | Deployed without console login; `/healthz` 200, all three credential types validate; `GH_TOKEN` is a fine-grained PAT scoped to the configured org only, without Workflows permission |
| M1 | Register → first request → recognize replies → wake agent | All fixtures classified correctly; after a curl registration the agent outputs `request_review` and each bot receives its templated request; a bot reply wakes the agent |
| M2 | Comment-handling loop, steer, timeouts, budget, restart | After request changes the agent edits, pushes, replies, resolves, and the harness re-requests only the relevant bots; two verdicts arriving one after another land in the same run; round 5 is rejected; a silent bot triggers stalled → resend → escalate; a redeploy mid-run continues |
| M3 | Rebase | Artificial conflict: rebase, resolve, lease push, explanation, re-request all reviewers; a failed lease retries |
| M4 | Approve, merge, cleanup | A clean PR is squash-merged by the harness with no handoff block in the body; with `auto_merge=off` it waits for `merge`; the workspace is cleaned up after merge; a hand-merged PR is detected by the sweep |
| M5 | G3 | All §7.1 phrasings recognized; output format matches review-bot and is recognized by the §5.3 rule; queueing is correct; the review session has no write credentials; the workspace is cleaned up after approve |
| M6 | Ship, report | One local command opens and registers a PR and it completes the full flow; the report arrives daily |

## 13. Risks

1. **The agent holds the owner's gh credentials, has no tool allowlist, and can force push.** Already tightened: the fine-grained PAT can only access the configured org's repositories, has no Workflows permission, and can be revoked on its own; only PRs in `config.org` are accepted; merges are executed by the harness and pinned to a SHA. The PAT expires after at most one year; the bot DMs reminders before it expires and when it becomes invalid. Each repository's main branch should be protected: no force push, approval required, dismiss stale approvals.
2. **Subscription auth**: used only by the owner personally, so the owner's own subscription is used (the Agent SDK docs restrict third-party developers offering products to others). Switching to an API key remains possible by changing only an environment variable.
3. **G3 runs other people's code**, and the SDK subprocess environment must contain the Claude token, so a malicious test in a PR could in theory read it. Mitigation: run code only for PRs from org members. A sandbox is deferred for now.
4. **Reviewer output formats change**: the generic rule depends only on "contains a review link", which is more stable than per-bot regexes. If a format does change, timeouts still wake the agent to check GitHub. Unrecognized bot messages are logged.
5. **The harness does not read comment content**, so human comments on GitHub are discovered by the agent on each run. The worst-case delay is the agent's chosen `wait` interval (≤ 30 minutes).
6. **Rebase rewrites history**: commit links in earlier replies may break; the inter-round diff reviewers see includes base changes, which the summary must mention.
7. **review-bot approves as reviewer-account**: if reviewer-account is not a valid approver in some repository, branch protection blocks the merge; after `merge_failed` the agent escalates.
8. **G3 approve has no allowlist** by deliberate choice; every request records the requester in the `jobs` table.

---
name: review
description: Review someone else's PR for pr-shepherd's G3 flow and return a structured verdict. Use when the bot asks you to review a PR in a review worktree (a "@<bot> review <pr>" request, "Use the pr-shepherd:review skill"). The harness posts everything; you only produce the review output.
---

# review

You are reviewing a PR someone else wrote. The worktree (cwd) is already checked out at the PR's latest
head. DESIGN §7.3 is the source of truth.

The request carries a `[context]` line: `[context] bot=<bot name> owner=<owner name> (@<owner GitHub login>) org=<GitHub org>`.
"The org" and "the bot" below mean those values; the review is posted to GitHub as the owner.

## Rules of the environment

- **GitHub only through the `gh_read` tool.** There is no `gh` auth in this environment; `gh` and `git push`
  will fail. `gh_read(args)` runs read-only `gh` commands for you, e.g.
  `["pr", "view", "<n>", "-R", "<repo>", "--json", "title,body,headRefOid,baseRefName,files"]`,
  `["pr", "diff", "<n>", "-R", "<repo>"]`, `["api", "repos/<repo>/pulls/<n>/reviews"]`,
  `["api", "repos/<repo>/pulls/<n>/comments"]`, `["issue", "view", "<n>", "-R", "<repo>"]`.
  Any repo in the org is readable, so check companion PRs and code in related repos (e.g. an e2e PR against the
  platform PR it depends on). Always name the repo (`-R`, a URL, or `api repos/<org>/...`); scope searches with
  `--owner <org>`. Repos outside the org are refused.
- **Do not post anything.** No reviews, comments, Slack messages. The harness posts your output to GitHub
  (as a COMMENT review with inline comments) and the verdict to Slack.
- **Never push, commit to the remote, or modify the PR.** Local edits for verification must be undone.
- If the request context contains `external contributor: static review only, do not run code`, do **not**
  run tests, builds, installs, scripts or any code from the PR. Read only.

## Procedure

1. **Prior rounds.** With `gh_read`, list reviews on this PR and find earlier rounds by the bot (body starts
   with `## Verdict:`). If there are N, this is round N+1: take the `commit_id` of the latest one and review mainly the diff since then
   (`git diff <old>..HEAD`), and check whether earlier findings were addressed. Otherwise round 1, full diff.
2. **Understand intent.** Read the PR description, linked issues, and any context the requester gave.
   Judge the change against what it claims to do.
3. **Review on four dimensions:**
   - Correctness: logic, edge cases, error paths, concurrency, migrations, backward compatibility.
   - Security: authz, injection, secrets, untrusted input, SSRF, unsafe defaults.
   - Performance: hot paths, N+1, unbounded work, memory.
   - Engineering quality: tests for the change, readability, dead code, consistency with the codebase.
4. **Reverse verification** (org members only): for key fixes, temporarily revert the fix, confirm the
   relevant test goes red, then restore and confirm green. Leave the worktree as you found it
   (`git status` clean, `git checkout -- .`).
5. **Be honest in `verified`:** what you ran and the results; what you could not run and why (static-only,
   missing services, too slow). Never claim a run you did not do.

## Severity

- **Critical**: must fix before merge (bugs, security holes, data loss, broken contract).
- **Suggestion**: worth changing, not blocking.
- **Information**: FYI, questions, praise-worthy notes worth recording.

Any Critical → `verdict: request_changes`; otherwise `approved`.

## Output (structured, required)

- `round`: 1-based round number (step 1).
- `head_sha`: the SHA you reviewed (`git rev-parse HEAD`, full SHA preferred).
- `verdict`: `approved` | `request_changes`.
- `counts`: `{critical, suggestion, information}`, consistent with `comments`.
- `summary`: 2–5 sentences: what the PR does, the overall judgement, the key findings; on round >1, what
  changed since the last round.
- `verified`: see step 5.
- `comments`: one per finding, `{path, line, severity, body}`. `path` relative to repo root, `line` a line
  in the PR's new version that is part of the diff. Body: the problem, why it matters, a concrete fix.
  Findings without a sensible line: anchor to the most relevant changed line.

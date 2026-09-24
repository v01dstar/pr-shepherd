---
name: shepherd
description: Shepherd one of the owner's own PRs from registration to squash merge inside a pr-shepherd managed session. Use when a message starts with "[event]" lines (registered, updated, review_done, approve_done, reviewer_error, reviewer_stalled, owner, timer, merge_failed, continue, restarted) or when told to take over a PR with "the pr-shepherd:shepherd skill". Not for reviewing other people's PRs (that is pr-shepherd:review).
---

# shepherd

You own one PR (the current worktree) until it is merged or the owner is needed. The harness (the bot) sends
you events; you read GitHub, change code, reply to reviewers, and tell the harness what to do next.
DESIGN §6 is the source of truth.

## Who is who

Every event message carries a `[context]` line:
`[context] bot=<bot name> owner=<owner name> (@<owner GitHub login>) org=<GitHub org>`.

- **the owner**: the person whose PR this is and who deployed the bot. Owner-only instructions arrive as
  `owner` events; escalations go to them.
- **the bot**: this deployment's name, used in the commit trailer below.
- **the org**: the GitHub organization the PR lives in.

Take these values from the latest `[context]` line; never guess them.

## How you talk to the harness

- Your **structured output is the only channel** back to the harness. There are no harness tools.
- **Never post to Slack.** Review / approve requests to reviewer bots are sent by the harness when you
  output `next: request_review` / `request_approve`.
- **Never run `gh pr merge`.** Output `next: merge` with the head SHA; the harness merges with
  `--match-head-commit`.
- Every event message has a `[policy]` line (auto_merge, rounds per bot, runs) followed by the `[context]`
  line. Respect the policy, but the harness enforces it; a rejected `next` comes back to you with the reason.
- Events can be steered into a running turn. Your final output must cover **all** events you received.

## Handoff block

The PR body may contain, written by the local agent:

```
<!-- pr-shepherd:handoff v1
agent: claude-code | codex | ...
session: <local session id, optional>
-->
### Handoff
**Intent**: ...  **Rejected**: ...  **Constraints**: ...  **Known gaps**: ...
<!-- /pr-shepherd:handoff -->
```

- **Constraints** and **Rejected** are hard rules. A comment asking to violate them → `escalate`. Never
  violate them when resolving conflicts either.
- **Known gaps** are intentional; reply that they are out of scope for this PR.
- `session` is only used in escalations: give the owner a paste-ready `claude --resume <session> "…"`.
- No handoff block → shepherd normally.

## Notes file

`.pr-shepherd/notes.md` in the worktree (git-excluded, survives session compaction/rebuild). Keep:
per thread the last comment id you handled, per round a summary, every rebase (onto, conflicts, how).
Read it first on every run, update it last.

## Each run

1. Read `.pr-shepherd/notes.md`. If the event is `restarted`, reconcile first (below).
2. Look at the PR as it is now with `gh`: head, base, `mergeStateStatus`, checks, every review, every
   unresolved thread. The owner's manual pushes and human comments on GitHub are discovered here.
3. Handle the events:
   - `registered`: read the handoff block, write the summary → `request_review` with all reviewers,
     summary = Intent + 1–2 "worth checking" points.
   - `updated`: the owner pushed again locally. Re-read the diff and handoff; if reviewers have not seen the
     new commits → `request_review` (reviewers whose last review predates them).
   - `review_done`: read that review; handle its inline comments and body findings (§ Comments). On
     `approved`, still consider whether any Suggestion is worth a quick fix.
   - `reviewer_stalled` / `reviewer_error`: first look on GitHub for a review by that bot after the
     request; if found treat it as `review_done`. Otherwise `request_review` for that bot with
     `resend: true`. After 2 resends, `escalate` and suggest removing the bot from reviewers.
   - `approve_done`: go to § Merge.
   - `timer`: check whether what you waited for (CI, comments) moved.
   - `owner`: the owner speaking. Do what they say; highest priority, overrides everything below.
   - `merge_failed`: read the gh error; usually rebase needed or CI not done.
   - `continue`: you ran out of turns last time; pick up from the notes.
   - `restarted`: see below.
4. Decide `next`:
   - Re-review only when it adds something. Every reviewer's verdict is approved and your push only applies
     their Suggestions or small corrections (wording, comments, a local fix with no design change) → no new
     review round: post a short PR comment listing what changed since the approvals (`gh pr comment`), then
     `request_approve` once CI is green (`wait` for it first); the approvers look at the final head.
   - Otherwise, when you changed code → `request_review`; reviewers = only the bots whose findings led to the
     change (a bot you only replied to is not re-asked); `resend: false`. After resolving rebase conflicts
     → all reviewers.
   - Every reviewer's latest verdict approves (an approval followed only by small fixes, as above, counts),
     no unresolved threads, CI green → `request_approve` (asks every configured approver; pass
     `approvers: [...]` only to ask a subset, e.g. to re-ask one that stalled).
   - Approved, no push since the approval, required checks green, `CLEAN` → `merge`.
   - Waiting on CI or on another reviewer → `wait` (≤ 30 min; reviewer replies wake you early).
   - Anything needing the owner → `escalate` with a precise reason.
   - PR already closed/merged elsewhere → `done`.
5. Update the notes, then return the structured output.

## Restarted

The previous run was killed mid-way. Before anything else: `git status`; a half-done rebase →
`git rebase --abort` and redo it; unpushed commits → verify and push; re-read the notes to find what
was already replied to. Do not reply twice to the same comment.

## Comments

Per thread pick one action:

- **fix**: change code. Only to answer a comment or resolve a conflict; no drive-by changes.
- **reply**: explain (misreading, Suggestion/Information you decline, already handled).
- **escalate**: design disagreement, unclear requirement, out of scope, violates the handoff,
  two reviewers contradict each other (escalate both).
- **ignore**: pure agreement, obsolete.

Procedure: edit → run the tests → commit (never amend pushed commits) → `git fetch`; if the remote branch
moved, rebase onto it first → push → reply per thread (fixes link the commit) → resolve fixed threads.

- Several reviews at once: fix together, push once; two comments on the same spot → fix once.
- Comments on an old SHA: confirm the problem still exists first.
- Right before pushing, re-check the threads you are handling: deleted → skip; edited → use the new
  text; resolved by someone else → do not repeat.
- New replies after the last comment id in your notes are new items.
- Commit trailer on every commit, with `<bot>` = the `bot=` value from the `[context]` line:
  `Co-Authored-By: <bot> <<bot>@users.noreply.github.com>`
- Never edit `.github/workflows/**` (the token cannot push it; escalate if a fix needs it).

### Round summary (`next.summary`)

One paragraph in the channel's style, ≤ 5 lines: for each finding how it was fixed and in which commit;
for each one not accepted, why. Mention a rebase if there was one (the inter-round diff includes base
changes). No headings, no bullet lists of everything you read.

## Rebase

Only when needed: `DIRTY`; `BEHIND` and the repo requires up-to-date branches; or a reviewer's point
depends on new base changes.

1. Record the remote head SHA before rebasing.
2. `git fetch && git rebase origin/<base>`; understand both sides' intent, resolve conflicts.
3. Run the full test suite.
4. `git push --force-with-lease=<branch>:<remote SHA before rebase>`.
5. Comment on the PR: onto what, which conflicts, how resolved. Fill `rebase` in the output.

- `--force-with-lease` only, and only after a rebase. Never plain `--force`.
- Lease fails → start over once; fails again → `escalate`.
- Escalate instead of guessing when: the conflict is a semantic trade-off, the two sides' intents
  contradict, tests fail, or more than 10 files conflict.
- A rebase may dismiss approvals; re-check before merging and `request_approve` if needed.

## Merge

You judge, the harness executes. Output `next: {action: "merge", sha: <full head SHA>, title: <PR title>}`
only when all hold:

- an approval exists on the current head (no push after it);
- all required checks green;
- `mergeStateStatus` is `CLEAN`.

`BEHIND` / `DIRTY` → rebase first, `wait` for CI, `request_approve` again if the approval was dismissed.
If `auto_merge=off` the harness asks the owner; that is not your concern.

## Output

- `handled`: one entry per review you processed (including steered ones), every item with url,
  severity (`-` for human comments without one), action, commit (fix only), note.
- `rebase`: `{onto: "main@<sha>", conflicts: [...], note}` or `null`.
- `status_line`: one line for `status` and the daily report, e.g. "waiting on review-bot r2; CI green".
- `next`: exactly one action.

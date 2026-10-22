// Executes a shepherd run's `next` with policy/budget checks (DESIGN §5.5, §5.6), and turns fired timers
// into inbox events (§5.3 timeouts). Idempotent: book-keeping first. A request row (placeholder ts) is written
// before its Slack post, so a re-apply finishes unposted rows instead of posting twice.
import type { Config } from './config.js';
import type { Actuator, GithubPort, Pr, Repos, ReviewRequest, Run, SlackPort, Store, Timer } from './contracts.js';
import { stripHandoff } from './github.js';
import { log } from './log.js';
import { createNotifyPr } from './notify.js';
import type { Next, ShepherdOutput } from './output.js';

type Deps = {
  config: Config;
  // requestsForPr is provided by createStore (StoreExtras); without it only open requests are visible.
  store: Store & { requestsForPr?(prId: number): Promise<ReviewRequest[]> };
  slack: SlackPort;
  github: GithubPort;
  repos: Repos;
  now?: () => Date;
};

type Bot = { name: string; slack: string; request: string; rerequest?: string };
type Outcome = { rejected: string } | { ok: true };
// What the owner hears after an apply: facts only the harness knows, appended to the agent's owner_update, and
// the merge/close summary.
type Notes = { facts: string[]; summary?: string };
const OK: Outcome = { ok: true };
const MAX_APPROVES_PER_HEAD = 2;
// request_ts of a row whose Slack message has not been posted yet.
export const PENDING_TS = 'pending:';
const isPending = (r: ReviewRequest) => r.requestTs.startsWith(PENDING_TS);
// The bot replied :x:/:warning: (inbox records its first line without a review link): the request is over.
const isErrored = (r: ReviewRequest) => !r.doneAt && !r.reviewUrl && r.firstLine != null;

const prUrl = (pr: Pr) => `https://github.com/${pr.repo}/pull/${pr.number}`;
const prName = (pr: Pr) => `${pr.repo}#${pr.number}`;
const minutes = (ms: number) => Math.round(ms / 60_000);

function render(template: string, bots: Bot[], url: string, summary: string): string {
  return template
    .replaceAll('{mentions}', bots.map((b) => `<@${b.slack}>`).join(' '))
    .replaceAll('{slack}', bots[0]!.slack)
    .replaceAll('{url}', url)
    .replaceAll('{summary}', summary)
    .trim();
}

export type ActuatorHandle = Actuator & {
  policyLine(pr: Pr): Promise<string>;
  // Owner's `merge <pr>`: executes the stored pendingMerge (DESIGN §5.5 merge row). skipCleanup when a run is live
  // on the PR: its worktree must not vanish under it; the janitor cleans the merged PR later (DESIGN §5.8).
  releaseMerge(pr: Pr, opts?: { skipCleanup?: boolean }): Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }>;
  closedOnGithub(pr: Pr, state: 'MERGED' | 'CLOSED'): Promise<void>;
};

export function createActuator(deps: Deps): ActuatorHandle {
  const { config, store, slack, github, repos } = deps;
  const now = deps.now ?? (() => new Date());
  const later = (min: number) => new Date(now().getTime() + min * 60_000);
  const notify = createNotifyPr({ config, store, slack });
  const reviewChannel = () => slack.channelId(config.reviewChannel);
  const allRequests = (prId: number) => (store.requestsForPr ? store.requestsForPr(prId) : store.openRequests(prId));

  // An open request is stalled once its ack/reply window has passed (DESIGN §5.3), or it errored, or it was never
  // posted; stalled bots may be re-requested.
  function isStalled(r: ReviewRequest): boolean {
    if (isPending(r) || isErrored(r)) return true;
    const t = now().getTime();
    if (!r.acked) return r.sentAt.getTime() + config.timing.ackTimeoutMin * 60_000 <= t;
    return (r.lastActivityAt ?? r.sentAt).getTime() + config.timing.replyTimeoutMin * 60_000 <= t;
  }

  async function needsHuman(pr: Pr, reason: string, detail?: string) {
    await store.updatePr(pr.id, { status: 'needs_human', reason });
    await notify(pr, [`${prName(pr)} needs you: ${reason} ${prUrl(pr)}`, detail].filter(Boolean).join('\n'));
  }

  // A merge/close summary goes into `notes` when the caller posts one, else to the PR's DM thread if it has one.
  async function terminal(pr: Pr, status: 'merged' | 'closed', opts: { skipCleanup?: boolean; mergeSha?: string; notes?: Notes } = {}) {
    await store.updatePr(pr.id, { status, closedAt: now(), pendingMerge: null });
    await store.cancelTimers(pr.id);
    const summary = await summaryLine(pr, status, opts.mergeSha).catch(() => `${prName(pr)} ${status}`);
    if (opts.notes) opts.notes.summary = summary;
    else await notify(pr, summary, { update: true, ifThread: true }).catch((e: unknown) => log.warn({ err: e, pr: prName(pr) }, 'summary post failed'));
    if (opts.skipCleanup) return;
    await repos.cleanup('shepherd', pr).catch((e: unknown) => log.warn({ err: e, pr: prName(pr) }, 'cleanup failed; janitor retries'));
  }

  async function summaryLine(pr: Pr, status: 'merged' | 'closed', mergeSha?: string) {
    const rounds = await store.roundsByBot(pr.id);
    const r = pr.reviewers.map((b) => `${b}=${rounds[b] ?? 0}`).join(' ');
    const what = status === 'merged' ? (mergeSha ? `merged as ${mergeSha.slice(0, 7)}` : 'merged') : 'closed';
    return `${prName(pr)} ${what} · review rounds ${r || '-'} · runs ${pr.runCount}`;
  }

  async function tellOwner(pr: Pr, update: string | null | undefined, notes: Notes) {
    const text = update ? [update, ...notes.facts, notes.summary].filter(Boolean).join('\n') : notes.summary;
    if (!text) return;
    await notify(pr, text, { update: true, ifThread: !update }).catch((e: unknown) => log.warn({ err: e, pr: prName(pr) }, 'owner update failed'));
  }

  function botFor(kind: ReviewRequest['kind'], name: string): Bot | undefined {
    return kind === 'approve' ? config.approvers.find((a) => a.name === name) : config.reviewers.find((r) => r.name === name);
  }
  const templateFor = (kind: ReviewRequest['kind'], bot: Bot, round: number) =>
    kind === 'approve' ? bot.request : round > 1 ? (bot.rerequest ?? bot.request) : bot.request;

  // Records a request + ack timer per bot, then posts. The ack timer also covers a post that never succeeds.
  async function sendRequests(
    pr: Pr, run: Run, kind: ReviewRequest['kind'],
    items: { bot: Bot; round: number; resend: boolean }[], summary: string, headSha?: string,
  ) {
    const channel = await reviewChannel();
    for (const it of items) {
      const req = await store.addReviewRequest({
        prId: pr.id, runId: run.id, kind, bot: it.bot.name, round: it.round, resend: it.resend, channel,
        requestTs: `${PENDING_TS}${run.id}`, headSha: headSha ?? null,
      });
      if (req) await store.addTimer({ prId: pr.id, kind: 'ack_timeout', refId: req.id, fireAt: later(config.timing.ackTimeoutMin) });
    }
    await flushPending(pr, run, kind, summary);
  }

  // Posts this run's unposted requests: one Slack message per template group.
  async function flushPending(pr: Pr, run: Run, kind: ReviewRequest['kind'], summary: string) {
    const rows = (await allRequests(pr.id)).filter((r) => r.runId === run.id && r.kind === kind && isPending(r) && !r.superseded && !r.doneAt);
    const groups = new Map<string, { req: ReviewRequest; bot: Bot; template: string }[]>();
    for (const req of rows) {
      const bot = botFor(kind, req.bot);
      if (!bot) continue;
      const template = templateFor(kind, bot, req.round);
      // {mentions} templates merge into one message; per-bot templates ({slack}) are always separate.
      const key = template.includes('{mentions}') ? `m:${template}` : `b:${bot.name}`;
      groups.set(key, [...(groups.get(key) ?? []), { req, bot, template }]);
    }
    for (const group of groups.values()) {
      const text = render(group[0]!.template, group.map((g) => g.bot), prUrl(pr), summary);
      const { ts } = await slack.post(group[0]!.req.channel, text);
      for (const g of group) await store.updateRequest(g.req.id, { requestTs: ts });
    }
  }

  async function supersede(pr: Pr, r: ReviewRequest) {
    await store.updateRequest(r.id, { superseded: true });
    await store.cancelTimers(pr.id, 'ack_timeout', r.id);
    await store.cancelTimers(pr.id, 'reply_timeout', r.id);
  }

  async function requestReview(pr: Pr, run: Run, next: Extract<Next, { action: 'request_review' }>): Promise<Outcome> {
    const unknown = next.reviewers.filter((b) => !pr.reviewers.includes(b));
    if (unknown.length) return { rejected: `reviewers not on this PR: ${unknown.join(', ')} (allowed: ${pr.reviewers.join(', ')})` };
    const configured = new Map(config.reviewers.map((r) => [r.name, r]));
    const unconfigured = next.reviewers.filter((b) => !configured.has(b));
    if (unconfigured.length) return { rejected: `reviewers missing from config: ${unconfigured.join(', ')}` };

    const open = (await store.openRequests(pr.id)).filter((r) => r.kind === 'review');
    const thisRun = new Set((await allRequests(pr.id)).filter((r) => r.kind === 'review' && r.runId === run.id).map((r) => r.bot));
    const rounds = await store.roundsByBot(pr.id);
    const plan: { bot: Bot & { rerequest: string }; round: number; resend: boolean; previous: ReviewRequest[] }[] = [];
    const live: string[] = [];
    let alreadySent = false;
    for (const name of new Set(next.reviewers)) {
      const mine = open.filter((r) => r.bot === name);
      if (thisRun.has(name)) {
        alreadySent = true; // re-apply after a crash or a failed post
        continue;
      }
      if (mine.some((r) => !isStalled(r))) {
        live.push(name);
        continue;
      }
      const round = next.resend ? Math.max(rounds[name] ?? 1, 1) : (rounds[name] ?? 0) + 1;
      plan.push({ bot: configured.get(name)!, round, resend: next.resend, previous: mine });
    }

    const over = plan.filter((p) => !p.resend && p.round > pr.maxRounds);
    if (over.length) {
      await needsHuman(pr, 'max_rounds', `round limit ${pr.maxRounds} reached for ${over.map((p) => p.bot.name).join(', ')}; \`set ${prName(pr)} rounds=N\` to continue`);
      return OK;
    }
    if (!plan.length && !alreadySent) {
      // Nothing would be sent: tell the agent instead of silently doing nothing (DESIGN §5.5 pre-execution check).
      return { rejected: `request still open and not stalled for ${live.join(', ')}; wait for its reply (reviewer_stalled fires when it is overdue)` };
    }
    if (live.length) log.info({ pr: prName(pr), bots: live }, 'request_review: open request still live, skipping bots');

    const items = plan.map((p) => ({ bot: p.bot, round: p.round, resend: p.resend }));
    // Bots whose template has no {summary} read it from the PR instead (DESIGN §5.3); once per run.
    if (!alreadySent && plan.some((p) => !templateFor('review', p.bot, p.round).includes('{summary}'))) {
      const r = Math.max(...items.map((i) => i.round));
      await github.comment(pr, `**${config.bot.name} · r${r} summary**\n\n${next.summary}`);
    }
    for (const p of plan) for (const prev of p.previous) await supersede(pr, prev);
    await sendRequests(pr, run, 'review', items, next.summary);
    return OK;
  }

  // Asks every configured approver (or the agent's subset) at once; the first approval wins (DESIGN §5.5).
  // Per approver: skip one whose request is still live, and cap requests per head SHA.
  async function requestApprove(pr: Pr, run: Run, next: Extract<Next, { action: 'request_approve' }>): Promise<Outcome> {
    const wanted = [...new Set(next.approvers?.length ? next.approvers : config.approvers.map((a) => a.name))];
    const unknown = wanted.filter((n) => !config.approvers.some((a) => a.name === n));
    if (unknown.length) return { rejected: `unknown approvers: ${unknown.join(', ')} (configured: ${config.approvers.map((a) => a.name).join(', ')})` };
    const approves = (await allRequests(pr.id)).filter((r) => r.kind === 'approve');
    if (approves.some((r) => r.runId === run.id)) {
      await flushPending(pr, run, 'approve', '');
      return OK;
    }
    const head = (await github.prMeta(pr)).headSha;
    const items: { bot: Bot; round: number; resend: boolean }[] = [];
    const skipped: string[] = [];
    for (const name of wanted) {
      const bot = config.approvers.find((a) => a.name === name)!;
      const mine = approves.filter((r) => r.bot === name);
      if (mine.some((r) => !r.doneAt && !r.superseded && !isStalled(r))) {
        skipped.push(`${name}: request still open and not stalled`);
        continue;
      }
      const sameHead = mine.filter((r) => r.headSha === head);
      if (sameHead.length >= MAX_APPROVES_PER_HEAD) {
        skipped.push(`${name}: already asked ${sameHead.length} times for head ${head.slice(0, 7)}`);
        continue;
      }
      for (const r of mine) if (!r.doneAt && !r.superseded) await supersede(pr, r);
      items.push({ bot, round: 0, resend: sameHead.length > 0 });
    }
    if (!items.length) return { rejected: `no approver can be asked now (${skipped.join('; ')}); wait for a reply` };
    await sendRequests(pr, run, 'approve', items, '', head);
    return OK;
  }

  async function merge(pr: Pr, run: Run, next: Extract<Next, { action: 'merge' }>, notes: Notes): Promise<Outcome> {
    if (!pr.autoMerge || pr.status !== 'active') {
      await store.updatePr(pr.id, { pendingMerge: { sha: next.sha, title: next.title } });
      await notify(pr, `${prName(pr)} ready to merge @${next.sha.slice(0, 7)} — reply \`merge ${prName(pr)}\``);
      return OK;
    }
    await doMerge(pr, next.sha, next.title, `merge_failed:${run.id}`, { notes });
    return OK;
  }

  async function doMerge(
    pr: Pr, sha: string, title: string, dedupeKey: string, opts: { skipCleanup?: boolean; notes?: Notes } = {},
  ): Promise<'merged' | 'queued' | false> {
    const meta = await github.prMeta(pr);
    const failed = async (error: string) => {
      await store.addEvent({ prId: pr.id, kind: 'merge_failed', payload: { error }, dedupeKey });
      opts.notes?.facts.push(`:x: merge failed: ${error}`);
      return false as const;
    };
    // The async merge API merges every open PR below a stacked one, so only the bottom of a stack is merged here.
    const below = await github.openPrsWithHead(pr.repo, meta.baseRef);
    if (below.length) {
      return failed(
        `stacked on #${below.join(', #')} (base ${meta.baseRef}); merging would also merge ${below.length > 1 ? 'those' : 'it'}. ` +
          `Wait until it merges and GitHub retargets this PR, then rebase onto the new base and merge.`,
      );
    }
    const res = await github.merge(pr, sha, `${title} (#${pr.number})`, stripHandoff(meta.body), { head: meta.headRef, base: meta.baseRef });
    if (!res.ok) return failed(res.error);
    if (res.queued) {
      await store.updatePr(pr.id, { pendingMerge: null });
      opts.notes?.facts.push(`queued @${sha.slice(0, 7)} in the merge queue`);
      return 'queued';
    }
    await terminal(pr, 'merged', { skipCleanup: opts.skipCleanup, mergeSha: res.sha, notes: opts.notes });
    return 'merged';
  }

  async function escalate(pr: Pr, reason: string, output: ShepherdOutput) {
    const items = output.handled.flatMap((h) => h.items.filter((i) => i.action === 'escalate').map((i) => `• ${h.reviewer}: ${i.note} ${i.url}`));
    await needsHuman(pr, reason, items.join('\n') || undefined);
  }

  async function execute(pr: Pr, run: Run, output: ShepherdOutput, notes: Notes): Promise<Outcome> {
    const next = output.next;
    switch (next.action) {
      case 'request_review':
        return requestReview(pr, run, next);
      case 'request_approve':
        return requestApprove(pr, run, next);
      case 'merge':
        return merge(pr, run, next, notes);
      case 'wait':
        if (!Number.isInteger(next.minutes) || next.minutes < 1 || next.minutes > 60) return { rejected: `wait minutes must be 1..60, got ${next.minutes}` };
        await store.cancelTimers(pr.id, 'wait');
        await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: later(next.minutes), note: next.reason });
        return OK;
      case 'escalate':
        await escalate(pr, next.reason, output);
        return OK;
      case 'done': {
        const meta = await github.prMeta(pr);
        if (meta.state === 'OPEN') {
          await escalate(pr, `agent said done but the PR is still open: ${next.reason}`, output);
          return OK;
        }
        await terminal(pr, meta.state === 'MERGED' ? 'merged' : 'closed', { notes });
        return OK;
      }
    }
  }

  // Runs whose output failed a check are marked bad_output; two in a row escalate (DESIGN §5.5, failure handling).
  async function reject(pr: Pr, run: Run, reason: string) {
    log.warn({ pr: prName(pr), run: run.id, reason }, 'next rejected');
    const history = (await store.runsByStatus(['ok', 'bad_output'])).filter((r) => r.prId === pr.id && r.id < run.id);
    await store.updateRun(run.id, { status: 'bad_output' });
    if (history.at(-1)?.status === 'bad_output') {
      await needsHuman(pr, 'bad_output', `rejected twice in a row; last: ${reason}`);
      return;
    }
    await store.addEvent({ prId: pr.id, kind: 'continue', payload: { rejected: reason }, dedupeKey: `rejected:${run.id}` });
  }

  return {
    async apply(run) {
      if (run.appliedAt || run.prId == null || !run.output || !('next' in run.output)) return;
      const output = run.output;
      const pr = await store.getPr(run.prId);
      if (!pr) return;
      if (pr.status === 'merged' || pr.status === 'closed') {
        await store.updateRun(run.id, { appliedAt: now() });
        return;
      }
      const notes: Notes = { facts: [] };
      const outcome = await execute(pr, run, output, notes);
      if ('rejected' in outcome) {
        await reject(pr, run, outcome.rejected);
        notes.facts.push(`:warning: the next step was refused: ${outcome.rejected}`);
      }
      await store.updateRun(run.id, { appliedAt: now() });
      // After appliedAt: a retried apply never posts twice; a failed post is only logged.
      await tellOwner(pr, output.owner_update, notes);
    },

    async onTimer(timer: Timer) {
      const dedupeKey = `timer:${timer.id}`;
      if (timer.kind === 'wait') {
        await store.addEvent({ prId: timer.prId, kind: 'timer', payload: { reason: timer.note }, dedupeKey });
        await store.fireTimer(timer.id);
        return;
      }
      const all = await allRequests(timer.prId);
      const req = all.find((r) => r.id === timer.refId && !r.doneAt && !r.superseded);
      const stalled = async (stage: 'no_ack' | 'no_reply', since: Date) => {
        const resends = all.filter((r) => r.bot === req!.bot && r.kind === req!.kind && r.round === req!.round && r.resend).length;
        await store.addEvent({
          prId: timer.prId, kind: 'reviewer_stalled', dedupeKey,
          payload: { reviewer: req!.bot, stage, waited: `${minutes(now().getTime() - since.getTime())}m`, resends },
        });
      };
      let rearm: Date | null = null;
      if (req && timer.kind === 'ack_timeout') {
        if (!req.acked) await stalled('no_ack', req.sentAt);
        // Acked in time: hand over to the reply window.
        else rearm = new Date((req.lastActivityAt ?? req.sentAt).getTime() + config.timing.replyTimeoutMin * 60_000);
      } else if (req && timer.kind === 'reply_timeout') {
        const last = req.lastActivityAt ?? req.sentAt;
        const due = new Date(last.getTime() + config.timing.replyTimeoutMin * 60_000);
        if (due.getTime() <= now().getTime()) await stalled('no_reply', last);
        else rearm = due;
      }
      await store.fireTimer(timer.id);
      if (rearm && req) {
        await store.cancelTimers(timer.prId, 'reply_timeout', req.id);
        await store.addTimer({ prId: timer.prId, kind: 'reply_timeout', refId: req.id, fireAt: rearm });
      }
    },

    async releaseMerge(pr, opts = {}) {
      if (pr.status === 'merged' || pr.status === 'closed') return { ok: false, error: `PR is ${pr.status}` };
      if (!pr.pendingMerge) return { ok: false, error: 'no merge is waiting for confirmation' };
      const { sha, title } = pr.pendingMerge;
      let merged: Awaited<ReturnType<typeof doMerge>>;
      try {
        // Each release is its own attempt: the same SHA may be released again after a failure.
        merged = await doMerge(pr, sha, title, `merge_failed:release:${pr.id}:${sha}:${now().getTime()}`, { skipCleanup: opts.skipCleanup });
      } catch (e) {
        // pendingMerge is kept, so the owner can simply release again.
        return { ok: false, error: `merge not completed (${e instanceof Error ? e.message : String(e)}); still waiting for \`merge ${prName(pr)}\`` };
      }
      if (merged) return { ok: true, ...(merged === 'queued' ? { queued: true } : {}) };
      await store.updatePr(pr.id, { pendingMerge: null });
      return { ok: false, error: 'merge failed; the agent was told (merge_failed)' };
    },

    // The PR was merged or closed on GitHub (by hand, or by someone else) before a run started: record it and stop.
    async closedOnGithub(pr, state) {
      log.info({ pr: prName(pr), state }, 'PR already closed on GitHub; not starting a run');
      await terminal(pr, state === 'MERGED' ? 'merged' : 'closed');
    },

    async policyLine(pr) {
      const rounds = await store.roundsByBot(pr.id);
      const r = pr.reviewers.map((b) => `${b}=${rounds[b] ?? 0}/${pr.maxRounds}`).join(' ');
      return `[policy] auto_merge=${pr.autoMerge ? 'on' : 'off'} rounds ${r} runs=${pr.runCount}/${config.limits.maxRunsPerPr}`;
    },
  };
}

// Glue between intake and the harness: PR registration (DESIGN §5.2), Slack commands (§9), timer loop (§5.3),
// and boot reconciliation (§5.7). index.ts builds the real deps; tests pass fakes over a pglite store.
import { PENDING_TS, type ActuatorHandle } from './actuator.js';
import { helpText, ownerOnly } from './commands.js';
import type { Config } from './config.js';
import type { Command, GithubPort, Pr, PrRef, Repos, Scheduler, SlackMessage, SlackPort, Store } from './contracts.js';
import type { G3 } from './g3.js';
import { log } from './log.js';
import { buildReport } from './report.js';
import type { StoreExtras } from './store.js';

export const UNSUPPORTED = 'Unsupported. I can: *review* or *approve* a PR, *status*, *help*.';
export const OWNER_ONLY = 'only the owner can do that';
const TIMER_TICK_MS = 15_000;
const JOB_RECOVERY_DAYS = 7;

export type ControlDeps = {
  config: Config;
  store: Store & Partial<Pick<StoreExtras, 'lastRunWithOutput'>>;
  github: GithubPort;
  repos: Repos;
  slack: SlackPort;
  scheduler: Pick<Scheduler, 'poke' | 'isRunning'> & { start(): void; paused(): boolean; pauseAll(): void; resumeAll(): void };
  actuator: Pick<ActuatorHandle, 'apply' | 'onTimer' | 'releaseMerge'>;
  g3: Pick<G3, 'onReview' | 'onApprove'>;
  now?: () => Date;
};

export type RegisterResult = { code: 202 | 400 | 403 | 409; body: { status: 'registered' | 'updated'; prId: number } | { error: string } };

const name = (r: PrRef) => `${r.repo}#${r.number}`;
const url = (r: PrRef) => `https://github.com/${r.repo}/pull/${r.number}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createControl(deps: ControlDeps) {
  const { config, store, github, repos, slack, scheduler, actuator, g3 } = deps;
  const now = deps.now ?? (() => new Date());

  // DESIGN §5.2 checks, shared by POST /prs (after the token check) and `track`.
  async function register(ref: PrRef): Promise<RegisterResult> {
    const [org, repoName] = ref.repo.split('/');
    if (org?.toLowerCase() !== config.org.toLowerCase()) return { code: 403, body: { error: `repo is not in ${config.org}` } };
    const excluded = config.excludeRepos.some((x) => [ref.repo, repoName].some((r) => r?.toLowerCase() === x.toLowerCase()));
    if (excluded) return { code: 403, body: { error: `${ref.repo} is excluded` } };
    let meta;
    try {
      meta = await github.prMeta(ref);
    } catch (e) {
      return { code: 400, body: { error: `cannot read PR: ${errMsg(e)}` } };
    }
    if (meta.author.toLowerCase() !== config.owner.github.toLowerCase()) return { code: 403, body: { error: `author is ${meta.author}, not ${config.owner.github}` } };
    if (meta.state !== 'OPEN') return { code: 409, body: { error: `PR is ${meta.state.toLowerCase()}` } };
    if (meta.isDraft) return { code: 409, body: { error: 'PR is a draft' } };

    const { pr, created } = await store.upsertPr(ref, config.reviewers.map((r) => r.name), config.limits.maxRounds);
    await store.addEvent({ prId: pr.id, kind: created ? 'registered' : 'updated', payload: { url: url(ref), head: meta.headSha.slice(0, 7) } });
    scheduler.poke(pr.id);
    log.info({ pr: name(ref), prId: pr.id, created }, 'PR registered');
    return { code: 202, body: { status: created ? 'registered' : 'updated', prId: pr.id } };
  }

  // Leaving needs_human by tell / thread reply / resume (DESIGN §5.6). A run-budget stop also resets the count.
  async function wake(prId: number, opts: { resetRuns?: boolean } = {}): Promise<void> {
    const pr = await store.getPr(prId);
    if (!pr) return;
    if (pr.status === 'merged' || pr.status === 'closed') return;
    if (pr.status === 'needs_human' || opts.resetRuns) {
      const resetRuns = opts.resetRuns || pr.reason === 'max_runs';
      await store.updatePr(prId, { status: 'active', reason: null, ...(resetRuns ? { runCount: 0 } : {}) });
    }
    scheduler.poke(prId);
  }

  // ---------- commands ----------

  const reply = (msg: SlackMessage, text: string) =>
    slack.post(msg.channel, text, msg.channel.startsWith('D') ? undefined : (msg.threadTs ?? msg.ts)).then(() => undefined);

  async function tracked(ref: PrRef, msg: SlackMessage): Promise<Pr | null> {
    const pr = await store.getPrByRef(ref);
    if (pr && pr.status !== 'merged' && pr.status !== 'closed') return pr;
    await reply(msg, `${name(ref)} is not tracked`);
    return null;
  }

  async function statusLine(pr: Pr, detail: boolean): Promise<string> {
    // The status line comes from the latest run that produced output; lastRun only tells whether one is running.
    const run = await store.lastRun(pr.id);
    const withOutput = run?.output ? run : ((await store.lastRunWithOutput?.(pr.id)) ?? null);
    const out = withOutput?.output && 'status_line' in withOutput.output ? withOutput.output : null;
    const line = run?.status === 'running' ? `working${out ? ` (last: ${out.status_line})` : ''}` : (out?.status_line ?? '-');
    const rounds = await store.roundsByBot(pr.id);
    const r = pr.reviewers.map((b) => `${b}=${rounds[b] ?? 0}/${pr.maxRounds}`).join(' ');
    const state = pr.status === 'needs_human' ? `needs_human (${pr.reason ?? '-'})` : pr.status;
    const lines = [`${name(pr)} ${state} — ${line} · rounds ${r}`];
    if (detail) {
      const items = out?.handled.flatMap((h) => h.items) ?? [];
      if (items.length) {
        const count = (a: string) => items.filter((i) => i.action === a).length;
        lines.push(`last run: fix ${count('fix')} · reply ${count('reply')} · escalate ${count('escalate')} · ignore ${count('ignore')}`);
      }
      if (pr.pendingMerge) lines.push(`merge waiting for you @${pr.pendingMerge.sha.slice(0, 7)} — \`merge ${name(pr)}\``);
      lines.push(`auto_merge=${pr.autoMerge ? 'on' : 'off'} runs=${pr.runCount}/${config.limits.maxRunsPerPr}`);
    }
    return lines.join('\n');
  }

  async function status(cmd: Extract<Command, { kind: 'status' }>, msg: SlackMessage) {
    if (cmd.pr) {
      const pr = await tracked(cmd.pr, msg);
      if (pr) await reply(msg, await statusLine(pr, true));
      return;
    }
    const prs = await store.listPrs(['needs_human', 'active', 'paused']);
    const lines = await Promise.all(prs.map((p) => statusLine(p, false)));
    await reply(msg, lines.length ? lines.join('\n') : 'no PRs are tracked');
  }

  async function set(cmd: Extract<Command, { kind: 'set' }>, msg: SlackMessage) {
    const pr = await tracked(cmd.pr, msg);
    if (!pr) return;
    const patch: Partial<Pr> = {};
    if (cmd.reviewers) {
      const known = new Set(config.reviewers.map((r) => r.name));
      const bad = cmd.reviewers.filter((r) => !known.has(r));
      if (bad.length || !cmd.reviewers.length) {
        await reply(msg, `unknown reviewers: ${bad.join(', ') || '(none given)'}; known: ${[...known].join(', ')}`);
        return;
      }
      patch.reviewers = cmd.reviewers;
    }
    if (cmd.rounds !== undefined) patch.maxRounds = cmd.rounds;
    if (cmd.autoMerge !== undefined) patch.autoMerge = cmd.autoMerge;
    // Raising the round limit is one of the ways out of needs_human (DESIGN §5.6).
    const unblock = pr.status === 'needs_human' && pr.reason === 'max_rounds' && cmd.rounds !== undefined && cmd.rounds > pr.maxRounds;
    if (unblock) Object.assign(patch, { status: 'active', reason: null });
    const updated = await store.updatePr(pr.id, patch);
    if (unblock) {
      await store.addEvent({ prId: pr.id, kind: 'owner', payload: { text: `max_rounds raised to ${cmd.rounds}` } });
      scheduler.poke(pr.id);
    }
    await reply(msg, `${name(pr)}: rounds=${updated.maxRounds} reviewers=${updated.reviewers.join(',')} auto_merge=${updated.autoMerge ? 'on' : 'off'}${unblock ? ' — resumed' : ''}`);
  }

  async function untrack(ref: PrRef, msg: SlackMessage) {
    const pr = await tracked(ref, msg);
    if (!pr) return;
    await store.updatePr(pr.id, { status: 'closed', reason: 'untracked', closedAt: now(), pendingMerge: null });
    await store.cancelTimers(pr.id);
    // A live run keeps its worktree until it ends; the janitor sweep cleans closed PRs later.
    if (!scheduler.isRunning(pr.id)) {
      await repos.cleanup('shepherd', pr).catch((e) => log.warn({ err: errMsg(e), pr: name(pr) }, 'untrack: cleanup skipped'));
    }
    await reply(msg, `stopped tracking ${name(pr)}`);
  }

  async function pauseOrResume(cmd: Extract<Command, { kind: 'pause' | 'resume' }>, msg: SlackMessage) {
    if (cmd.pr === 'all') {
      if (cmd.kind === 'pause') scheduler.pauseAll(); // interrupts live runs and freezes the timer loop
      else scheduler.resumeAll();
      await reply(msg, cmd.kind === 'pause' ? 'paused everything: runs interrupted, timers frozen' : 'resumed everything');
      return;
    }
    const pr = await tracked(cmd.pr, msg);
    if (!pr) return;
    if (cmd.kind === 'pause') {
      await store.updatePr(pr.id, { status: 'paused' });
      await reply(msg, `paused ${name(pr)}`);
    } else {
      // A run only starts on pending events: say why the PR resumed (DESIGN §5.4), even when nothing else is waiting.
      const why = pr.status === 'needs_human' ? `needs_human (${pr.reason ?? '-'})` : pr.status;
      await store.addEvent({ prId: pr.id, kind: 'owner', payload: { text: `resumed by owner (was ${why})` }, dedupeKey: `slack:${msg.channel}:${msg.ts}` });
      await wake(pr.id, { resetRuns: true });
      await reply(msg, `resumed ${name(pr)}`);
    }
  }

  async function onCommand(cmd: Command, msg: SlackMessage): Promise<void> {
    if (ownerOnly(cmd) && msg.user !== config.owner.slack) {
      await reply(msg, OWNER_ONLY);
      return;
    }
    // g3 adds its own :eyes:; everything else gets it here (DESIGN §9).
    if (cmd.kind !== 'g3_review' && cmd.kind !== 'g3_approve') {
      await slack.react(msg.channel, msg.ts, 'eyes').catch((e) => log.warn({ err: errMsg(e) }, 'react failed'));
    }
    switch (cmd.kind) {
      case 'g3_review':
        return g3.onReview(cmd, msg);
      case 'g3_approve':
        return g3.onApprove(cmd, msg);
      case 'status':
        return status(cmd, msg);
      case 'track': {
        const r = await register(cmd.pr);
        const text = 'error' in r.body ? `:x: cannot track ${name(cmd.pr)}: ${r.body.error}` : `${r.body.status} ${url(cmd.pr)}`;
        return reply(msg, text);
      }
      case 'untrack':
        return untrack(cmd.pr, msg);
      case 'tell': {
        const pr = await tracked(cmd.pr, msg);
        if (!pr) return;
        await store.addEvent({ prId: pr.id, kind: 'owner', payload: { text: cmd.text }, dedupeKey: `slack:${msg.channel}:${msg.ts}` });
        await wake(pr.id);
        return reply(msg, `told ${name(pr)}`);
      }
      case 'set':
        return set(cmd, msg);
      case 'merge': {
        const pr = await tracked(cmd.pr, msg);
        if (!pr) return;
        const r = await actuator.releaseMerge(pr, { skipCleanup: scheduler.isRunning(pr.id) });
        if (!r.ok) {
          scheduler.poke(pr.id); // a merge_failed event may be waiting
          return reply(msg, `:x: ${name(pr)}: ${r.error}`);
        }
        return reply(msg, `merged ${name(pr)}`);
      }
      case 'pause':
      case 'resume':
        return pauseOrResume(cmd, msg);
      case 'report': {
        const text = await buildReport({ store, config }, now());
        await slack.dm(config.owner.slack, text ?? `${config.bot.name} · nothing to report`);
        return;
      }
      case 'help':
        return reply(msg, helpText(config.bot.name));
      case 'unknown':
        return reply(msg, UNSUPPORTED);
    }
  }

  // ---------- timers ----------

  let ticking = false;
  async function tickTimers(): Promise<void> {
    // `pause all` (and a usage-limit pause) freezes timers (DESIGN §5.6); due ones fire on resume.
    if (ticking || scheduler.paused()) return;
    ticking = true;
    try {
      const touched = new Set<number>();
      for (const t of await store.dueTimers(now())) {
        try {
          await actuator.onTimer(t);
          touched.add(t.prId);
        } catch (e) {
          log.error({ err: errMsg(e), timerId: t.id }, 'timer failed');
        }
      }
      for (const prId of touched) scheduler.poke(prId);
    } finally {
      ticking = false;
    }
  }

  function startTimers(): () => void {
    const h = setInterval(() => void tickTimers().catch((e) => log.error({ err: errMsg(e) }, 'timer loop failed')), TIMER_TICK_MS);
    return () => clearInterval(h);
  }

  // ---------- boot reconciliation (DESIGN §5.7) ----------

  async function recover(inbox: { onThreadReply(msg: SlackMessage): Promise<void> }): Promise<void> {
    // 1. Output recorded but not executed.
    for (const run of await store.unappliedRuns()) {
      await actuator.apply(run).catch((e) => log.error({ err: errMsg(e), runId: run.id }, 'recover: apply failed'));
    }
    // 2. Runs cut off by the restart. Dedupe `run:<id>` matches the scheduler's own restarted/continue events.
    for (const run of await store.runsByStatus(['running', 'interrupted'])) {
      if (run.status === 'running') await store.updateRun(run.id, { status: 'interrupted', endedAt: now() });
      if (run.prId != null) await store.addEvent({ prId: run.prId, kind: 'restarted', payload: {}, dedupeKey: `run:${run.id}` });
    }
    // G3 jobs live in an in-memory pool; ones cut off by the restart are failed and the requester is told.
    const since = new Date(now().getTime() - JOB_RECOVERY_DAYS * 86_400_000);
    for (const job of await store.jobsSince(since)) {
      if (job.status !== 'queued' && job.status !== 'running') continue;
      await store.updateJob(job.id, { status: 'failed', verdict: 'failed', endedAt: now() });
      await slack
        .post(job.channel, `:x: <${url(job)}> — ${job.kind} failed (${config.bot.name} restarted; please ask again)`, job.threadTs)
        .catch((e) => log.warn({ err: errMsg(e), jobId: job.id }, 'recover: job notice failed'));
    }
    // 3. Thread replies missed while disconnected. Event dedupe keys make the replay idempotent; progress
    // messages at or before the last recorded activity were already seen.
    const threads = new Map<string, { channel: string; ts: string; seen: number }>();
    for (const r of await store.openRequests()) {
      if (r.requestTs.startsWith(PENDING_TS)) continue; // never posted; the actuator finishes it
      const key = `${r.channel}:${r.requestTs}`;
      const seen = r.lastActivityAt?.getTime() ?? 0;
      const t = threads.get(key);
      threads.set(key, { channel: r.channel, ts: r.requestTs, seen: Math.max(seen, t?.seen ?? 0) });
    }
    for (const t of threads.values()) {
      try {
        const msgs = (await slack.replies(t.channel, t.ts)).filter((m) => Number(m.ts) * 1000 > t.seen);
        msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
        for (const m of msgs) await inbox.onThreadReply({ ...m, threadTs: m.threadTs ?? t.ts });
      } catch (e) {
        log.warn({ err: errMsg(e), channel: t.channel, ts: t.ts }, 'recover: thread backfill failed');
      }
    }
    // 4. Overdue timers, then 5. deliver everything pending.
    await tickTimers();
    scheduler.start();
  }

  return { register, wake, onCommand, tickTimers, startTimers, recover };
}

export type Control = ReturnType<typeof createControl>;

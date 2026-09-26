// Scheduler: when and in which session the agent runs (DESIGN §5.4); result handling (DESIGN §5.5, §5.6); G3 isolation (§7.2).
import { join } from 'node:path';
import { createSdkMcpServer, tool, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { InputQueue, sdkRunAgent, type AgentRun, type Options, type RunAgent, type SDKMessage } from './agent.js';
import { agentOptions, type Config } from './config.js';
import type {
  Actuator, GithubPort, InboxEvent, Job, Pr, Repos, Run, RunResult, RunStatus, Scheduler, SlackPort, Store,
} from './contracts.js';
import { checkGhScope } from './github.js';
import { log } from './log.js';
import { createNotifyPr } from './notify.js';
import { GIT_SAFE_ENV } from './repos.js';
import type { StoreExtras } from './store.js';
import { reviewJsonSchema, reviewOutputSchema, shepherdJsonSchema, shepherdOutputSchema, type ReviewOutput } from './output.js';

export type SchedulerDeps = {
  config: Config;
  store: Store & Partial<Pick<StoreExtras, 'unclaimEvents'>>;
  github: GithubPort;
  repos: Repos;
  actuator: Actuator & { policyLine(pr: Pr): Promise<string> };
  slack: SlackPort;
  dataDir: string;
  runAgent?: RunAgent;
  now?: () => Date;
  ghRead?: (args: string[]) => Promise<string>;
  appRoot?: string; // the local plugin with our skills; /app in the image
  // Ignore pokes until start(): boot reconciliation (DESIGN §5.7) must finish before any run starts.
  holdUntilStart?: boolean;
  retryBaseMs?: number; // first backoff step for failed starts / applies
};

export type SchedulerHandle = Scheduler & { start(): void; paused(): boolean; pauseAll(): void; resumeAll(): void };

const QUOTA_BACKOFF_MS = 15 * 60_000;
const SHUTDOWN_WAIT_MS = 30_000;
const LIMIT_TEXT = /usage limit|rate[ _-]?limit|limit reached|quota|out of (?:extra )?usage/i;
// Only these reach the G3 subprocess: it runs other people's code (DESIGN §7.2, §13.3).
// Claude auth is either the subscription token or an API key (DESIGN §4); nothing else reaches review sessions.
const REVIEW_ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
// The shepherd needs gh/git/Claude credentials, never the service's own Slack or database secrets.
const SHEPHERD_ENV_DENY = /^(?:SLACK_|DATABASE_URL$|PG)/;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30 * 60_000;
const MISSING_SESSION = /no conversation found|session .*not found/i;

type Live = {
  prId: number;
  runId: number;
  queue: InputQueue;
  run: AgentRun;
  closing: boolean;
  interrupted: 'shutdown' | 'paused' | null;
  // Steered messages the SDK has not provably read (seq = queue position); handed back to the inbox at run end.
  steered: { ids: number[]; seq: number }[];
  lock: Promise<unknown>; // serializes steer vs. end-of-turn decisions
  done: Promise<void>;
};

type Outcome = {
  sessionId: string | null;
  last: SDKResultMessage | null;
  turns: number;
  thrown: unknown;
  rateLimited: boolean;
  resetAt: Date | null;
};

type Verdict =
  | { status: 'ok'; output: unknown }
  | { status: Exclude<RunStatus, 'ok' | 'running'>; error?: string; resetAt?: Date };

// FIFO counting semaphore. Steering into a live run never takes a slot (DESIGN §5.4).
class Pool {
  private used = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly size: number) {}
  acquire(): Promise<void> {
    if (this.used < this.size) {
      this.used++;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.used--;
  }
}

export function prUrl(pr: { repo: string; number: number }): string {
  return `https://github.com/${pr.repo}/pull/${pr.number}`;
}

// Instance identity for the agent (skills say "the owner" / "the org" / "the bot"; this line names them).
export function contextLine(config: Pick<Config, 'bot' | 'owner' | 'org'>): string {
  return `[context] bot=${config.bot.name} owner=${config.owner.name} (@${config.owner.github}) org=${config.org}`;
}

// "[event] <kind> k=v ..." (DESIGN §5.1). Values with spaces, quotes or newlines are JSON-quoted to stay on one line.
export function formatEvents(events: InboxEvent[]): string {
  return events
    .map((e) => {
      const kv = Object.entries(e.payload).map(([k, v]) => `${k}=${formatValue(v)}`);
      return ['[event]', e.kind, ...kv].join(' ');
    })
    .join('\n');
}

// Slack escapes &, < and > in message text; the agent should read (and echo) the plain characters.
export function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') {
    const t = unescapeSlack(v);
    return t === '' || /[\s"'=]/.test(t) ? JSON.stringify(t) : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return JSON.stringify(v);
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { config, store, github, repos, actuator, slack, dataDir } = deps;
  const runAgent = deps.runAgent ?? sdkRunAgent;
  const now = deps.now ?? (() => new Date());
  const ghRead = deps.ghRead ?? ((args: string[]) => github.ghRead(args));
  const appRoot = deps.appRoot ?? process.cwd();
  const claudeConfigDir = join(dataDir, 'claude');

  const shepherdPool = new Pool(config.limits.shepherdConcurrency);
  const reviewPool = new Pool(config.limits.reviewConcurrency);
  const lives = new Map<number, Live>();
  const debounces = new Map<number, NodeJS.Timeout>();
  const waiting = new Set<number>(); // debounced, now queued for a pool slot or starting
  // The owner's `pause all` and a usage-limit pause are separate: the quota timer must not lift the owner's stop.
  let manualPaused = false;
  let quotaPaused = false;
  let accepting = !deps.holdUntilStart;
  let stopping = false;
  let resumeTimer: NodeJS.Timeout | null = null;
  let quotaNotified = false;
  const paused = () => manualPaused || quotaPaused;

  const retryBaseMs = deps.retryBaseMs ?? 60_000;
  const backoff = (attempt: number) => Math.min(MAX_BACKOFF_MS, retryBaseMs * 2 ** (attempt - 1));
  const retryTimers = new Set<NodeJS.Timeout>();
  const startFailures = new Map<number, number>();
  function retryLater(ms: number, fn: () => Promise<void>) {
    const t = setTimeout(() => {
      retryTimers.delete(t);
      void fn().catch((err) => log.error({ err }, 'retry failed'));
    }, ms);
    retryTimers.add(t);
  }

  const dmOwner = (text: string) =>
    slack.dm(config.owner.slack, text).catch((err) => log.error({ err }, 'owner DM failed'));
  // A PR that needs the owner: its DM thread (DESIGN §5.6).
  const prNotify = createNotifyPr({ config, store, slack });
  const notify = (pr: Pr, text: string) => prNotify(pr, text).catch((err: unknown) => log.error({ err }, 'owner DM failed'));

  function poke(prId: number): void {
    if (stopping || paused() || !accepting) return;
    const live = lives.get(prId);
    if (live) {
      void steer(live);
      return;
    }
    if (waiting.has(prId)) return; // the run about to start will pick the events up
    // Idle: coalesce near-simultaneous events (e.g. two verdicts) into one message (DESIGN §5.4).
    const t = debounces.get(prId);
    if (t) clearTimeout(t);
    debounces.set(
      prId,
      setTimeout(() => {
        debounces.delete(prId);
        waiting.add(prId);
        void launch(prId);
      }, config.timing.debounceSec * 1000),
    );
  }

  // Deliver pending events into a live run. The closed check and the push are synchronous, so a queue closed while
  // we read the DB leaves the events pending; they are claimed only once pushed (and unclaimed at run end if unread).
  function steer(live: Live): Promise<boolean> {
    const p = live.lock.then(async () => {
      if (live.closing || live.queue.isClosed) return false;
      const pending = await store.pendingEvents(live.prId);
      if (!pending.length) return false;
      const pr = await store.getPr(live.prId);
      const policy = pr ? await actuator.policyLine(pr) : '';
      if (live.closing || live.queue.isClosed) return false;
      const ids = pending.map((e) => e.id);
      live.steered.push({ ids, seq: live.queue.pushed });
      live.queue.push(message(pending, policy));
      await store.claimEvents(ids, live.runId);
      log.info({ prId: live.prId, runId: live.runId, events: pending.length }, 'steered events into live run');
      return true;
    });
    live.lock = p.catch((err) => log.error({ err, prId: live.prId }, 'steer failed'));
    return p.catch(() => false);
  }

  function message(events: InboxEvent[], policy: string, preamble?: string): string {
    return [preamble, formatEvents(events), policy, contextLine(config)].filter(Boolean).join('\n');
  }

  async function launch(prId: number): Promise<void> {
    await shepherdPool.acquire();
    let started = false;
    let failure: unknown = null;
    try {
      if (stopping || paused()) return;
      started = await startRun(prId);
      startFailures.delete(prId);
    } catch (err) {
      failure = err;
      log.error({ err, prId }, 'run failed to start');
    } finally {
      waiting.delete(prId);
      if (!started) shepherdPool.release();
    }
    if (failure) await onStartFailure(prId, failure).catch((err) => log.error({ err, prId }, 'start retry bookkeeping failed'));
  }

  // prMeta / git fetch can fail transiently; the events stay pending, so retry with backoff, then hand over.
  async function onStartFailure(prId: number, err: unknown) {
    const n = (startFailures.get(prId) ?? 0) + 1;
    if (n < MAX_RETRIES) {
      startFailures.set(prId, n);
      retryLater(backoff(n), async () => poke(prId));
      return;
    }
    startFailures.delete(prId);
    const pr = await store.getPr(prId);
    if (!pr || pr.status !== 'active') return;
    await store.updatePr(prId, { status: 'needs_human', reason: 'start_failed' });
    await notify(pr, `${pr.repo}#${pr.number} needs you: the run failed to start ${n} times (${err instanceof Error ? err.message : String(err)}). ${prUrl(pr)}`);
  }

  // Returns true when a run was started; the run releases the pool slot itself.
  async function startRun(prId: number): Promise<boolean> {
    const pr = await store.getPr(prId);
    if (!pr || pr.status !== 'active') return false;
    const pending = await store.pendingEvents(prId);
    if (!pending.length) return false;

    if (pr.runCount >= config.limits.maxRunsPerPr) {
      await store.updatePr(prId, { status: 'needs_human', reason: 'max_runs' });
      await notify(pr, `${pr.repo}#${pr.number} needs you: run budget exhausted (${pr.runCount}/${config.limits.maxRunsPerPr}). ${prUrl(pr)}`);
      return false;
    }

    const prev = await store.lastRun(prId);
    const meta = await github.prMeta(pr);
    const cwd = await repos.ensureWorktree('shepherd', pr, meta.headRef);
    const run = await store.createRun({ prId, sessionId: pr.sessionId });
    await store.claimEvents(pending.map((e) => e.id), run.id);
    const updated = await store.updatePr(prId, { runCount: pr.runCount + 1 });
    const policy = await actuator.policyLine(updated);
    const preamble = pr.sessionId ? undefined : `Use the pr-shepherd:shepherd skill to take over ${prUrl(pr)}.`;

    const queue = new InputQueue();
    queue.push(message(pending, policy, preamble));
    const options: Options = {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: config.limits.maxTurns,
      ...agentOptions(config, 'shepherd'),
      settingSources: ['project'],
      plugins: [{ type: 'local', path: appRoot }],
      outputFormat: { type: 'json_schema', schema: shepherdJsonSchema },
      env: shepherdEnv(),
      ...(pr.sessionId ? { resume: pr.sessionId } : {}),
    };
    const agentRun = runAgent({ prompt: queue, options });
    let resolveDone!: () => void;
    const live: Live = {
      prId,
      runId: run.id,
      queue,
      run: agentRun,
      closing: false,
      interrupted: null,
      steered: [],
      lock: Promise.resolve(),
      done: new Promise((r) => (resolveDone = r)),
    };
    lives.set(prId, live);
    log.info({ prId, runId: run.id, resume: pr.sessionId, events: pending.length }, 'shepherd run started');

    void (async () => {
      try {
        const outcome = await drive(agentRun, queue, {
          onSession: async (sid) => {
            if (sid !== pr.sessionId) await store.updatePr(prId, { sessionId: sid });
            await store.updateRun(run.id, { sessionId: sid });
          },
          // End of turn: keep going while the SDK has queued turns or the inbox has new events (DESIGN §5.4).
          onResult: async (m) => {
            // No queued turns left: everything the SDK had taken from the queue has been read.
            if ((m.queued_turn_count ?? 0) === 0) live.steered = live.steered.filter((s) => s.seq >= queue.taken);
            if (m.subtype !== 'success' || m.is_error || live.interrupted) return close(live);
            if ((m.queued_turn_count ?? 0) > 0) return;
            if (!(await steer(live))) await close(live);
          },
        });
        live.closing = true;
        await live.lock.catch(() => {}); // a steer that already pushed finishes its claim first
        const unread = live.steered.flatMap((s) => s.ids);
        if (unread.length) {
          await store.unclaimEvents?.(unread, run.id);
          log.info({ prId, runId: run.id, events: unread.length }, 'returned unread steered events to the inbox');
        }
        await finishShepherd(pr, run, prev, outcome, live.interrupted);
      } catch (err) {
        log.error({ err, prId, runId: run.id }, 'run bookkeeping failed');
      } finally {
        live.closing = true;
        queue.close();
        lives.delete(prId);
        shepherdPool.release();
        resolveDone();
        void repokeIfPending(prId);
      }
    })();
    return true;
  }

  function close(live: Live): Promise<void> {
    const p = live.lock.then(() => {
      live.closing = true;
      live.queue.close();
    });
    live.lock = p;
    return p;
  }

  async function repokeIfPending(prId: number) {
    if (stopping || paused()) return;
    try {
      if ((await store.pendingEvents(prId)).length) poke(prId);
    } catch (err) {
      log.error({ err, prId }, 'repoke failed');
    }
  }

  async function drive(
    agentRun: AgentRun,
    queue: InputQueue,
    hooks: { onSession(sid: string): Promise<void>; onResult(m: SDKResultMessage): Promise<void> },
  ): Promise<Outcome> {
    const o: Outcome = { sessionId: null, last: null, turns: 0, thrown: null, rateLimited: false, resetAt: null };
    try {
      for await (const m of agentRun as AsyncIterable<SDKMessage>) {
        const sid = (m as { session_id?: string }).session_id;
        if (sid && sid !== o.sessionId) {
          o.sessionId = sid;
          await hooks.onSession(sid);
        }
        if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected') {
          o.rateLimited = true;
          if (m.rate_limit_info.resetsAt) o.resetAt = new Date(m.rate_limit_info.resetsAt * 1000);
        } else if (m.type === 'assistant' && m.error === 'rate_limit') {
          o.rateLimited = true;
        } else if (m.type === 'result') {
          o.last = m;
          o.turns += m.num_turns;
          await hooks.onResult(m);
        }
      }
    } catch (err) {
      o.thrown = err;
    } finally {
      queue.close();
    }
    return o;
  }

  function judge(o: Outcome, interrupted: boolean, schema: z.ZodType): Verdict {
    // An interrupt we asked for ends as error_during_execution + process_exited_nonzero (DESIGN §5.4, S0).
    if (interrupted) return { status: 'interrupted' };
    const last = o.last;
    if (last && last.subtype === 'success' && !last.is_error) {
      const parsed = schema.safeParse(last.structured_output);
      return parsed.success ? { status: 'ok', output: parsed.data } : { status: 'bad_output', error: parsed.error.message };
    }
    const text = [
      o.thrown instanceof Error ? o.thrown.message : o.thrown ? String(o.thrown) : '',
      last?.subtype === 'success' ? last.result : (last?.errors ?? []).join('\n'),
    ].join('\n');
    const quota =
      last?.terminal_reason === 'blocking_limit' ||
      last?.terminal_reason === 'rapid_refill_breaker' ||
      o.rateLimited ||
      LIMIT_TEXT.test(text);
    if (quota) return { status: 'quota', error: text.trim() || undefined, resetAt: o.resetAt ?? parseReset(text) ?? new Date(now().getTime() + QUOTA_BACKOFF_MS) };
    if (last?.subtype === 'error_max_turns') return { status: 'max_turns' };
    if (last?.subtype === 'error_max_structured_output_retries') return { status: 'bad_output', error: 'structured output retries exhausted' };
    return { status: 'error', error: text.trim() || 'run ended without a result' };
  }

  function parseReset(text: string): Date | null {
    // The CLI reports subscription limits as "...limit reached|<epoch seconds>".
    const epoch = /\|(\d{10})\b/.exec(text)?.[1];
    if (epoch) return new Date(Number(epoch) * 1000);
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(text)?.[0];
    if (iso && !Number.isNaN(Date.parse(iso))) return new Date(iso);
    return null;
  }

  function usageOf(last: SDKResultMessage | null): Record<string, unknown> | null {
    if (!last) return null;
    return { usage: last.usage, modelUsage: last.modelUsage, costUsd: last.total_cost_usd };
  }

  async function finishShepherd(pr: Pr, run: Run, prev: Run | null, o: Outcome, interrupted: Live['interrupted']) {
    const v = judge(o, interrupted !== null, shepherdOutputSchema);
    const base = { turns: o.turns, usage: usageOf(o.last), endedAt: now(), sessionId: o.sessionId ?? run.sessionId };
    const dedupeKey = `run:${run.id}`;
    const ref = `${pr.repo}#${pr.number}`;
    log.info({ prId: pr.id, runId: run.id, status: v.status }, 'shepherd run ended');

    // The wake-up event goes in before the run's final status: a crash in between leaves the run 'running', and
    // boot recovery's `restarted` (same dedupe key) then collapses into the event already written.
    switch (v.status) {
      case 'ok': {
        // Record first, then act: the output is persisted before the actuator acts on it (DESIGN §5.5).
        const saved = await store.updateRun(run.id, { ...base, status: 'ok', output: v.output as Run['output'] });
        await applyWithRetry(saved, 1);
        return;
      }
      case 'max_turns':
        await store.addEvent({ prId: pr.id, kind: 'continue', payload: { reason: 'max_turns' }, dedupeKey });
        await store.updateRun(run.id, { ...base, status: 'max_turns' });
        return;
      case 'bad_output':
        if (prev?.status === 'bad_output') {
          await store.updateRun(run.id, { ...base, status: 'bad_output' });
          await store.updatePr(pr.id, { status: 'needs_human', reason: 'bad_output' });
          await notify(pr, `${ref} needs you: the agent returned invalid output twice in a row. ${prUrl(pr)}`);
        } else {
          await store.addEvent({ prId: pr.id, kind: 'continue', payload: { rejected: 'invalid output', error: v.error }, dedupeKey });
          await store.updateRun(run.id, { ...base, status: 'bad_output' });
        }
        return;
      case 'quota':
        await store.addEvent({ prId: pr.id, kind: 'continue', payload: { reason: 'quota' }, dedupeKey });
        await store.updateRun(run.id, { ...base, status: 'quota' });
        await pauseUntil(v.resetAt!, v.error);
        return;
      case 'interrupted':
        // Shutdown interrupts get `restarted` at boot (DESIGN §5.7); a pause-all needs its own wake-up.
        if (interrupted === 'paused') {
          await store.addEvent({ prId: pr.id, kind: 'restarted', payload: { reason: 'paused' }, dedupeKey });
        }
        await store.updateRun(run.id, { ...base, status: 'interrupted' });
        return;
      default:
        // The session file is gone (e.g. pruned): start the next run fresh, with the takeover preamble.
        if (MISSING_SESSION.test(v.error ?? '') && pr.sessionId) await store.updatePr(pr.id, { sessionId: null });
        if (prev?.status === 'error') {
          await store.updateRun(run.id, { ...base, status: 'error' });
          await store.updatePr(pr.id, { status: 'needs_human', reason: 'run_error' });
          await notify(pr, `${ref} needs you: two runs in a row failed. Last error: ${v.error}. ${prUrl(pr)}`);
        } else {
          await store.addEvent({ prId: pr.id, kind: 'continue', payload: { reason: 'error' }, dedupeKey });
          await store.updateRun(run.id, { ...base, status: 'error' });
        }
    }
  }

  // A failed apply (Slack/GitHub hiccup) is retried with backoff; nothing else would wake the PR. A newer run
  // makes the old `next` stale; after MAX_RETRIES the owner takes over.
  async function applyWithRetry(run: Run, attempt: number): Promise<void> {
    try {
      await actuator.apply(run);
      return;
    } catch (err) {
      log.error({ err, runId: run.id, attempt }, 'actuator.apply failed');
      if (attempt >= MAX_RETRIES) return giveUpApply(run, err);
    }
    const retry = async (): Promise<void> => {
      if (stopping) return;
      if (paused()) return retryLater(backoff(attempt), retry);
      const fresh = (await store.unappliedRuns()).find((r) => r.id === run.id);
      if (!fresh || fresh.prId == null) return;
      const last = await store.lastRun(fresh.prId);
      if (last && last.id !== fresh.id) {
        await store.updateRun(fresh.id, { appliedAt: now() });
        log.warn({ runId: fresh.id, newer: last.id }, 'unapplied output superseded by a newer run');
        return;
      }
      await applyWithRetry(fresh, attempt + 1);
    };
    retryLater(backoff(attempt), retry);
  }

  async function giveUpApply(run: Run, err: unknown) {
    await store.updateRun(run.id, { appliedAt: now() });
    const pr = run.prId != null ? await store.getPr(run.prId) : null;
    if (!pr || pr.status !== 'active') return;
    await store.updatePr(pr.id, { status: 'needs_human', reason: 'apply_failed' });
    await notify(pr, `${pr.repo}#${pr.number} needs you: executing the agent's next step failed ${MAX_RETRIES} times (${err instanceof Error ? err.message : String(err)}). ${prUrl(pr)}`);
  }

  // Subscription limit: freeze both pools until reset, tell me once (DESIGN §5.6).
  async function pauseUntil(resetAt: Date, detail?: string) {
    quotaPaused = true;
    clearDebounces();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(resumeFromQuota, Math.max(0, resetAt.getTime() - now().getTime()));
    if (!quotaNotified) {
      quotaNotified = true;
      await dmOwner(`${config.bot.name} hit the Claude usage limit; paused until ${resetAt.toISOString()}.${detail ? ` (${detail.slice(0, 200)})` : ''}`);
    }
  }

  function clearDebounces() {
    for (const t of debounces.values()) clearTimeout(t);
    debounces.clear();
  }

  function pauseAll(): void {
    manualPaused = true;
    clearDebounces();
    for (const live of lives.values()) void interrupt(live, 'paused');
  }

  // The owner's `resume all` lifts both pauses.
  function resumeAll(): void {
    manualPaused = false;
    resumeFromQuota();
  }

  function resumeFromQuota(): void {
    quotaPaused = false;
    quotaNotified = false;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    if (!paused()) start();
  }

  async function interrupt(live: Live, reason: 'shutdown' | 'paused') {
    if (live.interrupted) return;
    live.interrupted = reason;
    live.closing = true;
    live.queue.close();
    try {
      await live.run.interrupt?.();
    } catch (err) {
      log.warn({ err, runId: live.runId }, 'interrupt failed');
    }
  }

  async function interruptAll(): Promise<void> {
    stopping = true;
    clearDebounces();
    if (resumeTimer) clearTimeout(resumeTimer);
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    const all = [...lives.values()];
    await Promise.all(all.map((l) => interrupt(l, 'shutdown')));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(all.map((l) => l.done)),
      new Promise((r) => (timer = setTimeout(r, SHUTDOWN_WAIT_MS))),
    ]);
    clearTimeout(timer);
    for (const l of all) {
      if (lives.has(l.prId)) await store.updateRun(l.runId, { status: 'interrupted', endedAt: now() }).catch(() => {});
    }
  }

  function start(): void {
    accepting = true;
    void (async () => {
      for (const pr of await store.listPrs(['active'])) {
        if ((await store.pendingEvents(pr.id)).length) poke(pr.id);
      }
    })().catch((err) => log.error({ err }, 'scheduler start failed'));
  }

  // G3 review: fresh session, no secrets in env, GitHub only through gh_read (DESIGN §7.2).
  async function runReview(job: Job, cwd: string, context: string): Promise<RunResult> {
    if (quotaPaused) return { status: 'quota', sessionId: null, error: 'paused for usage limit' };
    await reviewPool.acquire();
    try {
      const run = await store.createRun({ jobId: job.id, sessionId: null });
      const queue = new InputQueue();
      queue.push([`Use the pr-shepherd:review skill to review ${prUrl(job)}.`, contextLine(config), context.trim()].filter(Boolean).join('\n'));
      const options: Options = {
        cwd,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: config.limits.maxTurns,
        ...agentOptions(config, 'review'),
        // Omitting settingSources loads every source; the PR's own .claude/ settings (hooks, MCP) must not run.
        settingSources: [],
        plugins: [{ type: 'local', path: appRoot }],
        outputFormat: { type: 'json_schema', schema: reviewJsonSchema },
        env: reviewEnv(),
        mcpServers: { github: ghReadServer(job.repo) },
      };
      const agentRun = runAgent({ prompt: queue, options });
      const outcome = await drive(agentRun, queue, {
        onSession: (sid) => store.updateRun(run.id, { sessionId: sid }).then(() => {}),
        onResult: async (m) => {
          if ((m.queued_turn_count ?? 0) === 0) queue.close();
        },
      });
      const v = judge(outcome, false, reviewOutputSchema);
      const base = { turns: outcome.turns, usage: usageOf(outcome.last), endedAt: now(), sessionId: outcome.sessionId };
      log.info({ jobId: job.id, runId: run.id, status: v.status }, 'review run ended');
      if (v.status === 'ok') {
        await store.updateRun(run.id, { ...base, status: 'ok', output: v.output as Run['output'] });
        return {
          status: 'ok',
          output: v.output as ReviewOutput,
          sessionId: outcome.sessionId ?? '',
          turns: outcome.turns,
          usage: base.usage ?? {},
        };
      }
      await store.updateRun(run.id, { ...base, status: v.status });
      if (v.status === 'quota') await pauseUntil(v.resetAt!, v.error);
      return { status: v.status, sessionId: outcome.sessionId, error: v.error, resetAt: v.resetAt };
    } finally {
      reviewPool.release();
    }
  }

  function shepherdEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SHEPHERD_ENV_DENY.test(k)) env[k] = v;
    // The agent's own git calls must not run hooks planted in a shared mirror (G3 runs untrusted code on this box).
    return { ...env, ...GIT_SAFE_ENV, CLAUDE_CONFIG_DIR: claudeConfigDir };
  }

  function reviewEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of REVIEW_ENV_ALLOW) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    return env;
  }

  function ghReadServer(repo: string) {
    const ghReadTool = tool(
      'gh_read',
      `Run a read-only \`gh\` command on any ${deps.config.org}/* repository (e.g. ["pr","view","123","--repo","${repo}","--json","reviews"]). Always pass --repo. Write commands and repositories outside ${deps.config.org} are refused.`,
      { args: z.array(z.string()).describe('gh arguments, without the leading "gh"') },
      async ({ args }) => {
        try {
          const scope = checkGhScope(args, deps.config.org);
          if (scope) throw new Error(scope);
          return { content: [{ type: 'text' as const, text: await ghRead(args) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    );
    return createSdkMcpServer({ name: 'github', tools: [ghReadTool] });
  }

  return {
    poke,
    runReview,
    interruptAll,
    isRunning: (prId) => lives.has(prId),
    start,
    paused,
    pauseAll,
    resumeAll,
  };
}

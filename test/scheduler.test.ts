import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, RunAgent, SDKMessage, SDKUserMessage } from '../src/agent.js';
import type { Config } from '../src/config.js';
import type { EventKind, InboxEvent, Job, Pr, Run, Store } from '../src/contracts.js';
import { createScheduler, formatEvents, type SchedulerHandle } from '../src/scheduler.js';

// ---------- fixtures ----------

const config: Config = {
  bot: { name: 'test-bot' },
  org: 'your-org',
  owner: { github: 'me', slack: 'UOWNER', name: 'Me' },
  reviewChannel: 'pr-review',
  reviewers: [{ name: 'review-bot', slack: 'UREVIEW', request: '<@{slack}> review {url}', rerequest: '<@{slack}> review {url}' }],
  approvers: [{ name: 'review-bot', slack: 'UREVIEW', request: '<@{slack}> approve {url}' }],
  excludeRepos: [],
  limits: { maxRounds: 4, maxRunsPerPr: 30, maxTurns: 60, shepherdConcurrency: 1, reviewConcurrency: 2 },
  agent: { model: 'claude-sonnet-5', effort: 'medium', shepherd: {}, review: { effort: 'high' } },
  timing: { debounceSec: 0.02, ackTimeoutMin: 15, replyTimeoutMin: 120, sweepMin: 30, reviewIdleDays: 7, reportAt: '09:00', timezone: 'UTC' },
};

const goodOutput = {
  handled: [],
  rebase: null,
  status_line: 'waiting for review-bot',
  next: { action: 'wait', minutes: 10, reason: 'CI' },
};

const goodReview = {
  round: 1,
  head_sha: 'abc1234',
  verdict: 'approved',
  counts: { critical: 0, suggestion: 0, information: 1 },
  summary: 'fine',
  verified: 'ran tests',
  comments: [],
};

// In-memory Store: only what the scheduler touches.
function memStore() {
  const prs = new Map<number, Pr>();
  const events: InboxEvent[] = [];
  const runs: Run[] = [];
  let seq = 0;
  const store = {
    prs,
    events,
    runs,
    addPr(p: Partial<Pr> & { id: number }): Pr {
      const pr: Pr = {
        repo: 'o/r', number: p.id, status: 'active', reason: null, sessionId: null, reviewers: ['review-bot'], maxRounds: 4,
        autoMerge: true, pendingMerge: null, runCount: 0, createdAt: new Date(), updatedAt: new Date(), closedAt: null, ...p,
      };
      prs.set(pr.id, pr);
      return pr;
    },
    async getPr(id: number) { return prs.get(id) ?? null; },
    async listPrs(statuses?: string[]) { return [...prs.values()].filter((p) => !statuses || statuses.includes(p.status)); },
    async updatePr(id: number, patch: Partial<Pr>) {
      const pr = { ...prs.get(id)!, ...patch };
      prs.set(id, pr);
      return pr;
    },
    async claimDmThread(id: number, dmChannel: string, dmTs: string) {
      const pr = prs.get(id)!;
      if (!pr.dmTs) prs.set(id, { ...pr, dmChannel, dmTs });
      return prs.get(id)!;
    },
    async addEvent(e: { prId: number | null; kind: EventKind; payload?: Record<string, unknown>; dedupeKey?: string }) {
      if (e.dedupeKey && events.some((x) => x.dedupeKey === e.dedupeKey)) return null;
      const ev: InboxEvent = { id: ++seq, prId: e.prId, kind: e.kind, payload: e.payload ?? {}, dedupeKey: e.dedupeKey ?? null, createdAt: new Date(), runId: null };
      events.push(ev);
      return ev;
    },
    async pendingEvents(prId: number) { return events.filter((e) => e.prId === prId && e.runId === null); },
    async claimEvents(ids: number[], runId: number) { for (const e of events) if (ids.includes(e.id)) e.runId = runId; },
    async createRun(r: { prId?: number; jobId?: number; sessionId?: string | null }) {
      const run: Run = {
        id: runs.length + 1, prId: r.prId ?? null, jobId: r.jobId ?? null, sessionId: r.sessionId ?? null, status: 'running',
        turns: null, usage: null, output: null, startedAt: new Date(), endedAt: null, appliedAt: null,
      };
      runs.push(run);
      return run;
    },
    async updateRun(id: number, patch: Partial<Run>) {
      const i = runs.findIndex((r) => r.id === id);
      runs[i] = { ...runs[i]!, ...patch };
      return runs[i]!;
    },
    async lastRun(prId: number) { return [...runs].reverse().find((r) => r.prId === prId) ?? null; },
    async unclaimEvents(ids: number[], runId: number) { for (const e of events) if (ids.includes(e.id) && e.runId === runId) e.runId = null; },
    async unappliedRuns() { return runs.filter((r) => r.status === 'ok' && r.output && !r.appliedAt); },
  };
  return store;
}

// ---------- scripted RunAgent ----------

type Ctx = { next(): Promise<string | null>; options: Options; interrupted: Promise<void> };
type Script = (ctx: Ctx) => AsyncGenerator<SDKMessage>;
type Call = { options: Options; prompts: string[] };

function fakeAgent(script: Script) {
  const calls: Call[] = [];
  const run: RunAgent = ({ prompt, options }) => {
    const call: Call = { options, prompts: [] };
    calls.push(call);
    const it = prompt[Symbol.asyncIterator]();
    let onInterrupt!: () => void;
    const interrupted = new Promise<void>((r) => (onInterrupt = r));
    const ctx: Ctx = {
      options,
      interrupted,
      async next() {
        const r = await it.next();
        if (r.done) return null;
        const text = (r.value as SDKUserMessage).message.content as string;
        call.prompts.push(text);
        return text;
      },
    };
    const gen = script(ctx);
    return Object.assign(gen, { interrupt: async () => onInterrupt() });
  };
  return { run, calls };
}

const S = 'sess-1';
const init = (sid = S) => ({ type: 'system', subtype: 'init', session_id: sid }) as unknown as SDKMessage;
const assistant = (sid = S) => ({ type: 'assistant', message: { content: [] }, session_id: sid }) as unknown as SDKMessage;
const success = (output: unknown, extra: Record<string, unknown> = {}, sid = S) =>
  ({
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: '', structured_output: output,
    queued_turn_count: 0, usage: {}, modelUsage: {}, total_cost_usd: 0, session_id: sid, ...extra,
  }) as unknown as SDKMessage;
const failure = (subtype: string, extra: Record<string, unknown> = {}, sid = S) =>
  ({
    type: 'result', subtype, is_error: true, num_turns: 60, errors: [], usage: {}, modelUsage: {}, total_cost_usd: 0,
    session_id: sid, ...extra,
  }) as unknown as SDKMessage;

// Answers every user message with one successful result; ends when the queue closes.
const chatty =
  (output: unknown = goodOutput): Script =>
  async function* (ctx) {
    yield init();
    while ((await ctx.next()) !== null) yield success(output);
  };

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(script: Script, cfg: Config = config) {
  const store = memStore();
  const agent = fakeAgent(script);
  const applied: Run[] = [];
  const dms: string[] = [];
  const deps = {
    config: cfg,
    store: store as unknown as Store,
    github: { prMeta: vi.fn(async (ref: { repo: string; number: number }) => ({ ...ref, headRef: `feat-${ref.number}` })), ghRead: vi.fn() } as never,
    repos: { ensureWorktree: vi.fn(async (_k: string, ref: { number: number }) => `/data/worktrees/r-${ref.number}`) } as never,
    actuator: {
      apply: vi.fn(async (r: Run) => void applied.push(r)),
      onTimer: vi.fn(),
      policyLine: vi.fn(async (pr: Pr) => `[policy] auto_merge=on runs=${pr.runCount}/30`),
    },
    slack: { dm: vi.fn(async (_u: string, t: string) => (dms.push(t), { channel: 'D-owner', ts: `${dms.length}.0` })) } as never,
    dataDir: '/data',
    runAgent: agent.run,
    appRoot: '/app',
  };
  const sched = createScheduler(deps);
  return { sched, store, agent, applied, dms, deps };
}

let current: SchedulerHandle | undefined;
afterEach(async () => {
  await current?.interruptAll(); // stops follow-up runs and clears the quota resume timer
  current = undefined;
});

// ---------- tests ----------

describe('formatEvents', () => {
  it('quotes values with spaces or newlines and keeps one line per event', () => {
    const e = (kind: EventKind, payload: Record<string, unknown>) => ({ id: 1, prId: 1, kind, payload, dedupeKey: null, createdAt: new Date(), runId: null });
    const out = formatEvents([
      e('review_done', { reviewer: 'codex-bot', review: 'https://github.com/o/r/pull/1#pullrequestreview-5', first_line: ':octagonal_sign: verdict: *request_changes*' }),
      e('owner', { text: 'line one\nline two' }),
    ]);
    expect(out).toBe(
      '[event] review_done reviewer=codex-bot review=https://github.com/o/r/pull/1#pullrequestreview-5 first_line=":octagonal_sign: verdict: *request_changes*"\n' +
        '[event] owner text="line one\\nline two"',
    );
  });
});

describe('scheduler — shepherd runs', () => {
  it('starts a new session with the take-over preamble, stores the session id, applies the output', async () => {
    const t = setup(chatty());
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);

    await waitFor(() => t.applied.length === 1);
    const call = t.agent.calls[0]!;
    expect(call.prompts[0]).toBe(
      'Use the pr-shepherd:shepherd skill to take over https://github.com/o/r/pull/1.\n[event] registered\n[policy] auto_merge=on runs=1/30\n[context] bot=test-bot owner=Me (@me) org=your-org',
    );
    expect(call.options.resume).toBeUndefined();
    expect(call.options.cwd).toBe('/data/worktrees/r-1');
    expect(call.options.permissionMode).toBe('bypassPermissions');
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.maxTurns).toBe(60);
    expect([call.options.model, call.options.effort, call.options.fallbackModel]).toEqual(['claude-sonnet-5', 'medium', undefined]);
    expect(call.options.settingSources).toEqual(['project']);
    expect(call.options.plugins).toEqual([{ type: 'local', path: '/app' }]);
    expect(call.options.outputFormat?.type).toBe('json_schema');
    expect(call.options.env?.CLAUDE_CONFIG_DIR).toBe('/data/claude');

    const pr = t.store.prs.get(1)!;
    expect(pr.sessionId).toBe(S);
    expect(pr.runCount).toBe(1);
    expect(t.store.runs[0]).toMatchObject({ status: 'ok', sessionId: S, output: goodOutput, turns: 3 });
    expect(t.store.events.every((e) => e.runId === 1)).toBe(true);
    await waitFor(() => !t.sched.isRunning(1));
  });

  it('resumes an existing session without the preamble', async () => {
    const t = setup(chatty());
    current = t.sched;
    t.store.addPr({ id: 1, sessionId: 'sess-old', runCount: 2 });
    await t.store.addEvent({ prId: 1, kind: 'owner', payload: { text: 'hold on' } });
    t.sched.poke(1);
    await waitFor(() => t.applied.length === 1);
    const call = t.agent.calls[0]!;
    expect(call.options.resume).toBe('sess-old');
    expect(call.prompts[0]).toBe('[event] owner text="hold on"\n[policy] auto_merge=on runs=3/30\n[context] bot=test-bot owner=Me (@me) org=your-org');
  });

  it('steers a second poke into the live run; the same run claims it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      yield assistant();
      await gate; // the second event arrives while the agent is mid-turn
      await ctx.next();
      yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'review_done', payload: { reviewer: 'codex-bot' } });
    t.sched.poke(1);
    await waitFor(() => t.sched.isRunning(1) && t.agent.calls[0]?.prompts.length === 1);

    await t.store.addEvent({ prId: 1, kind: 'review_done', payload: { reviewer: 'review-bot' } });
    t.sched.poke(1);
    await waitFor(() => t.store.events[1]!.runId !== null);
    release();

    await waitFor(() => !t.sched.isRunning(1));
    expect(t.agent.calls).toHaveLength(1);
    expect(t.store.runs).toHaveLength(1);
    expect(t.store.events.map((e) => e.runId)).toEqual([1, 1]);
    expect(t.agent.calls[0]!.prompts[1]).toContain('[event] review_done reviewer=review-bot');
    expect(t.agent.calls[0]!.prompts[1]).toMatch(/\n\[context\] bot=test-bot owner=Me \(@me\) org=your-org$/); // steered messages carry it too
    expect(t.applied).toHaveLength(1);
  });

  it('delivers events that arrive at end of turn before closing the queue', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      // An event lands without a poke (e.g. poke raced the turn end).
      await t.store.addEvent({ prId: 1, kind: 'timer', payload: { note: 'ci' } });
      yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[0]?.status === 'ok');
    expect(t.agent.calls).toHaveLength(1);
    expect(t.agent.calls[0]!.prompts).toHaveLength(2);
    expect(t.agent.calls[0]!.prompts[1]).toContain('[event] timer note=ci');
  });

  it('keeps going while the SDK reports queued turns', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      yield success(goodOutput, { queued_turn_count: 1 });
      yield success(goodOutput, { queued_turn_count: 0 });
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[0]?.status === 'ok');
    expect(t.store.runs[0]!.turns).toBe(6);
  });

  it('debounces: several pokes while idle become one run with one message', async () => {
    const t = setup(chatty(), { ...config, timing: { ...config.timing, debounceSec: 0.08 } });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'review_done', payload: { reviewer: 'codex-bot' } });
    t.sched.poke(1);
    await new Promise((r) => setTimeout(r, 40));
    await t.store.addEvent({ prId: 1, kind: 'review_done', payload: { reviewer: 'review-bot' } });
    t.sched.poke(1);
    await new Promise((r) => setTimeout(r, 50)); // 90ms since the first poke, 50 since the reset
    expect(t.agent.calls).toHaveLength(0);
    await waitFor(() => t.store.runs[0]?.status === 'ok');
    expect(t.agent.calls).toHaveLength(1);
    const first = t.agent.calls[0]!.prompts[0]!;
    expect(first).toContain('reviewer=codex-bot');
    expect(first).toContain('reviewer=review-bot');
  });

  it('runs at most shepherdConcurrency PRs at once, FIFO', async () => {
    const gates: (() => void)[] = [];
    let live = 0;
    let maxLive = 0;
    const t = setup(async function* (ctx) {
      live++;
      maxLive = Math.max(maxLive, live);
      yield init(`s-${ctx.options.cwd}`);
      await ctx.next();
      await new Promise<void>((r) => gates.push(r));
      live--;
      yield success(goodOutput, {}, `s-${ctx.options.cwd}`);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    for (const id of [1, 2, 3]) {
      t.store.addPr({ id });
      await t.store.addEvent({ prId: id, kind: 'registered' });
      t.sched.poke(id);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (let i = 0; i < 3; i++) {
      await waitFor(() => gates.length === 1);
      gates.shift()!();
    }
    await waitFor(() => t.store.runs.length === 3 && t.store.runs.every((r) => r.status === 'ok'));
    expect(maxLive).toBe(1);
    expect(t.agent.calls.map((c) => c.options.cwd)).toEqual(['/data/worktrees/r-1', '/data/worktrees/r-2', '/data/worktrees/r-3']);
  });

  it('stops at the run budget: needs_human max_runs, DM, no run', async () => {
    const t = setup(chatty());
    current = t.sched;
    t.store.addPr({ id: 1, runCount: 30 });
    await t.store.addEvent({ prId: 1, kind: 'timer' });
    t.sched.poke(1);
    await waitFor(() => t.store.prs.get(1)!.status === 'needs_human');
    expect(t.store.prs.get(1)!.reason).toBe('max_runs');
    expect(t.dms[0]).toContain('run budget');
    expect(t.agent.calls).toHaveLength(0);
    expect(t.store.runs).toHaveLength(0);
  });

  it('ignores PRs that are not active; events stay pending', async () => {
    const t = setup(chatty());
    current = t.sched;
    t.store.addPr({ id: 1, status: 'paused' });
    await t.store.addEvent({ prId: 1, kind: 'owner', payload: { text: 'x' } });
    t.sched.poke(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.agent.calls).toHaveLength(0);
    expect(t.store.events[0]!.runId).toBeNull();
  });

  it('error_max_turns → max_turns + continue, which starts the next run', async () => {
    let n = 0;
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      if (n++ === 0) yield failure('error_max_turns', { terminal_reason: 'max_turns' });
      else yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1, sessionId: 's0' });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[1]?.status === 'ok');
    expect(t.store.runs[0]!.status).toBe('max_turns');
    expect(t.agent.calls[1]!.prompts[0]).toContain('[event] continue reason=max_turns');
    expect(t.store.prs.get(1)!.runCount).toBe(2);
  });

  it('bad output twice in a row → needs_human bad_output', async () => {
    const t = setup(chatty({ nope: true }));
    current = t.sched;
    t.store.addPr({ id: 1, sessionId: 's0' });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.prs.get(1)!.status === 'needs_human');
    expect(t.store.prs.get(1)!.reason).toBe('bad_output');
    expect(t.store.runs.map((r) => r.status)).toEqual(['bad_output', 'bad_output']);
    expect(t.agent.calls[1]!.prompts[0]).toContain('[event] continue rejected="invalid output"');
    expect(t.dms).toHaveLength(1);
    expect(t.applied).toHaveLength(0);
  });

  it('error_max_structured_output_retries counts as bad output', async () => {
    let n = 0;
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      if (n++ === 0) yield failure('error_max_structured_output_retries');
      else yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[1]?.status === 'ok');
    expect(t.store.runs[0]!.status).toBe('bad_output');
  });

  it('usage limit → quota: pauses everything until reset, DMs once, resumes on resumeAll', async () => {
    let n = 0;
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      if (n++ === 0) {
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt }, session_id: S } as unknown as SDKMessage;
        yield failure('error_during_execution', { terminal_reason: 'blocking_limit' });
        return;
      }
      yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    t.store.addPr({ id: 2 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[0]?.status === 'quota');
    await waitFor(() => t.sched.paused());
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0]).toContain(new Date(resetsAt * 1000).toISOString());

    await t.store.addEvent({ prId: 2, kind: 'registered' });
    t.sched.poke(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.agent.calls).toHaveLength(1);

    t.sched.resumeAll();
    await waitFor(() => t.store.runs.filter((r) => r.status === 'ok').length === 2);
    expect(t.sched.paused()).toBe(false);
    const pr1Run = t.agent.calls.find((c) => c.options.cwd === '/data/worktrees/r-1' && c.options.resume);
    expect(pr1Run?.prompts[0]).toContain('[event] continue reason=quota');
  });

  it('a thrown usage-limit error is quota too, with a default 15m backoff', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      throw new Error('Claude AI usage limit reached');
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[0]?.status === 'quota');
    expect(t.sched.paused()).toBe(true);
  });

  it('other errors → status error, one continue; a second error → needs_human and a DM', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      throw new Error('boom');
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.prs.get(1)!.status === 'needs_human');
    expect(t.store.runs.map((r) => r.status)).toEqual(['error', 'error']);
    expect(t.store.prs.get(1)!.reason).toBe('run_error');
    expect(t.dms).toHaveLength(1); // only the needs_human one; the retry is silent
  });

  it('interruptAll: our own interrupt ends as interrupted, not error', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      yield assistant();
      await ctx.interrupted;
      yield failure('error_during_execution');
      throw new Error('Claude Code process exited with code 1 (process_exited_nonzero)');
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.sched.isRunning(1));
    await t.sched.interruptAll();
    expect(t.store.runs[0]!.status).toBe('interrupted');
    expect(t.dms).toHaveLength(0);
    expect(t.store.events.filter((e) => e.kind === 'continue')).toHaveLength(0);
    expect(t.sched.isRunning(1)).toBe(false);

    await t.store.addEvent({ prId: 1, kind: 'owner', payload: { text: 'x' } });
    t.sched.poke(1); // no new runs after shutdown
    await new Promise((r) => setTimeout(r, 50));
    expect(t.agent.calls).toHaveLength(1);
  });

  it('pauseAll interrupts live runs and queues a restarted event for resumeAll', async () => {
    let n = 0;
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      if (n++ === 0) {
        await ctx.interrupted;
        throw new Error('process_exited_nonzero');
      }
      yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.sched.isRunning(1));
    t.sched.pauseAll();
    expect(t.sched.paused()).toBe(true);
    await waitFor(() => t.store.runs[0]?.status === 'interrupted');
    t.sched.resumeAll();
    await waitFor(() => t.store.runs[1]?.status === 'ok');
    expect(t.agent.calls[1]!.prompts[0]).toContain('[event] restarted reason=paused');
  });

  it('start() pokes every active PR with pending events', async () => {
    const t = setup(chatty());
    current = t.sched;
    t.store.addPr({ id: 1 });
    t.store.addPr({ id: 2 });
    t.store.addPr({ id: 3, status: 'needs_human' });
    await t.store.addEvent({ prId: 1, kind: 'restarted' });
    await t.store.addEvent({ prId: 3, kind: 'restarted' });
    t.sched.start();
    await waitFor(() => t.store.runs[0]?.status === 'ok');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.store.runs.map((r) => r.prId)).toEqual([1]);
  });
});

describe('scheduler — G3 review runs', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      GH_TOKEN: 'ghp_secret',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      SLACK_APP_TOKEN: 'xapp-secret',
      DATABASE_URL: 'postgres://secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat',
      ANTHROPIC_API_KEY: 'sk-ant-api',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const job: Job = {
    id: 7, repo: 'your-org/example-cli', number: 42, kind: 'review', requestedBy: 'U1', channel: 'C1', threadTs: '1.0',
    status: 'running', verdict: null, createdAt: new Date(), endedAt: null,
  };

  it('runs a fresh isolated session whose env holds no secrets and exposes only gh_read', async () => {
    const t = setup(chatty(goodReview));
    current = t.sched;
    const res = await t.sched.runReview(job, '/data/review-worktrees/cli-42', 'focus on auth');
    expect(res).toMatchObject({ status: 'ok', output: goodReview, sessionId: S });

    const { options, prompts } = t.agent.calls[0]!;
    expect(prompts[0]).toBe('Use the pr-shepherd:review skill to review https://github.com/your-org/example-cli/pull/42.\n[context] bot=test-bot owner=Me (@me) org=your-org\nfocus on auth');
    expect(options.resume).toBeUndefined();
    expect(options.cwd).toBe('/data/review-worktrees/cli-42');
    expect(options.settingSources).toEqual([]);
    expect([options.model, options.effort]).toEqual(['claude-sonnet-5', 'high']); // review overrides effort only
    expect(options.plugins).toEqual([{ type: 'local', path: '/app' }]);
    const env = options.env!;
    expect(Object.keys(env).every((k) => ['PATH', 'HOME', 'LANG', 'TERM', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(k))).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/data/claude');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api');
    for (const v of Object.values(env)) expect(['ghp_secret', 'xoxb-secret', 'xapp-secret', 'postgres://secret', 'aws']).not.toContain(v);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['github']);
    expect(t.store.runs[0]).toMatchObject({ jobId: 7, status: 'ok' });
  });

  it('gh_read proxies to deps.ghRead', async () => {
    const ghRead = vi.fn(async (args: string[]) => `ran ${args.join(' ')}`);
    const t = setup(chatty(goodReview));
    const sched = createScheduler({ ...t.deps, ghRead });
    current = sched;
    await sched.runReview(job, '/w', '');
    const server = t.agent.calls[0]!.options.mcpServers!.github as unknown as {
      instance: { _registeredTools: Record<string, { handler?: (a: unknown, e: unknown) => Promise<unknown>; callback?: (a: unknown, e: unknown) => Promise<unknown> }> };
    };
    const registered = server.instance._registeredTools;
    expect(Object.keys(registered)).toEqual(['gh_read']);
    const fn = registered.gh_read!.handler ?? registered.gh_read!.callback!;
    const out = await fn({ args: ['pr', 'view', '42', '--repo', 'your-org/example-cli'] }, {});
    expect(ghRead).toHaveBeenCalledWith(['pr', 'view', '42', '--repo', 'your-org/example-cli']);
    expect(out).toEqual({ content: [{ type: 'text', text: 'ran pr view 42 --repo your-org/example-cli' }] });
    // other repos are refused before gh runs
    const denied = (await fn({ args: ['api', 'repos/Other/private/contents/x'] }, {})) as { isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(ghRead).toHaveBeenCalledTimes(1);
  });

  it('maps a schema-violating review to bad_output', async () => {
    const t = setup(chatty({ verdict: 'meh' }));
    current = t.sched;
    const res = await t.sched.runReview(job, '/w', '');
    expect(res.status).toBe('bad_output');
  });

  it('respects the review pool size', async () => {
    const gates: (() => void)[] = [];
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      await new Promise<void>((r) => gates.push(r));
      yield success(goodReview);
    });
    current = t.sched;
    const runs = [1, 2, 3].map((i) => t.sched.runReview({ ...job, id: i }, '/w', ''));
    await waitFor(() => gates.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.agent.calls).toHaveLength(2);
    gates.shift()!();
    await waitFor(() => t.agent.calls.length === 3 && gates.length === 2);
    while (gates.length) gates.shift()!();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  });
});

describe('scheduler — review-fix regressions', () => {
  it('shepherd env drops the service secrets and disables git hooks', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GH_TOKEN: 'ghp', SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp', DATABASE_URL: 'postgres://x', PGPASSWORD: 'pw' });
    try {
      const t = setup(chatty());
      current = t.sched;
      t.store.addPr({ id: 1 });
      await t.store.addEvent({ prId: 1, kind: 'registered' });
      t.sched.poke(1);
      await waitFor(() => t.applied.length === 1);
      const env = t.agent.calls[0]!.options.env!;
      expect(env.GH_TOKEN).toBe('ghp');
      for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DATABASE_URL', 'PGPASSWORD']) expect(env[k]).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('a failed apply is retried with backoff', async () => {
    const t = setup(chatty());
    let fails = 2;
    t.deps.actuator.apply = vi.fn(async (r: Run) => {
      if (fails-- > 0) throw new Error('slack 503');
      t.applied.push(r);
    });
    const sched = createScheduler({ ...t.deps, retryBaseMs: 10 });
    current = sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    sched.poke(1);
    await waitFor(() => t.applied.length === 1);
    expect(t.deps.actuator.apply).toHaveBeenCalledTimes(3);
  });

  it('gives up on apply after repeated failures: needs_human, DM', async () => {
    const t = setup(chatty());
    t.deps.actuator.apply = vi.fn(async () => {
      throw new Error('gh 502');
    });
    const sched = createScheduler({ ...t.deps, retryBaseMs: 5 });
    current = sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    sched.poke(1);
    await waitFor(() => t.store.prs.get(1)!.status === 'needs_human', 3000);
    expect(t.store.prs.get(1)!.reason).toBe('apply_failed');
    expect(t.store.runs[0]!.appliedAt).not.toBeNull();
    expect(t.dms.at(-1)).toContain('failed 5 times');
  });

  it('a run that fails to start (prMeta error) is retried', async () => {
    const t = setup(chatty());
    let fails = 1;
    const prMeta = vi.fn(async (ref: { repo: string; number: number }) => {
      if (fails-- > 0) throw new Error('graphql timeout');
      return { ...ref, headRef: 'feat' };
    });
    const sched = createScheduler({ ...t.deps, github: { prMeta, ghRead: vi.fn() } as never, retryBaseMs: 10 });
    current = sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    sched.poke(1);
    await waitFor(() => t.applied.length === 1);
    expect(prMeta).toHaveBeenCalledTimes(2);
  });

  it('events steered into a run that dies before reading them go back to the inbox', async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      if (n++ === 0) {
        await gate; // the steered message stays unread
        throw new Error('boom');
      }
      yield success(goodOutput);
      while ((await ctx.next()) !== null) yield success(goodOutput);
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.sched.isRunning(1));
    const tell = (await t.store.addEvent({ prId: 1, kind: 'owner', payload: { text: 'do not merge yet' } }))!;
    t.sched.poke(1);
    await waitFor(() => tell.runId !== null);
    release();
    await waitFor(() => t.store.runs[1]?.status === 'ok');
    expect(t.agent.calls[1]!.prompts[0]).toContain('do not merge yet');
    expect(tell.runId).toBe(2);
  });

  it('the quota auto-resume does not lift the owner\'s pause all', async () => {
    const t = setup(async function* (ctx) {
      yield init();
      await ctx.next();
      throw new Error('usage limit reached|' + Math.floor(Date.now() / 1000 + 0.05));
    });
    current = t.sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    t.sched.poke(1);
    await waitFor(() => t.store.runs[0]?.status === 'quota');
    t.sched.pauseAll();
    await new Promise((r) => setTimeout(r, 200)); // past the reset time
    expect(t.sched.paused()).toBe(true);
    expect(t.agent.calls).toHaveLength(1);
  });

  it('holdUntilStart: pokes before start() are ignored; start() picks the events up', async () => {
    const t = setup(chatty());
    const sched = createScheduler({ ...t.deps, holdUntilStart: true });
    current = sched;
    t.store.addPr({ id: 1 });
    await t.store.addEvent({ prId: 1, kind: 'registered' });
    sched.poke(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.agent.calls).toHaveLength(0);
    sched.start();
    await waitFor(() => t.applied.length === 1);
  });
});

describe('formatEvents', () => {
  it('unescapes Slack entities so the agent sees plain text', async () => {
    const { formatEvents, unescapeSlack } = await import('../src/scheduler.js');
    expect(unescapeSlack('a &amp; b &lt;x&gt;')).toBe('a & b <x>');
    const line = formatEvents([{ id: 1, prId: 1, kind: 'owner', payload: { text: 'review-bot &amp; codex-bot' }, dedupeKey: null, createdAt: new Date(), runId: null }]);
    expect(line).toBe('[event] owner text="review-bot & codex-bot"');
  });
});


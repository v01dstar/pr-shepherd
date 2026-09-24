import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { Exec, GithubPort, Job, Pr, PrRef, Repos, SlackPort, Store, Workspace, WorkspaceKind } from '../src/contracts.js';
import { createJanitor } from '../src/janitor.js';

const DAY = 24 * 60 * 60 * 1000;
const config = {
  bot: { name: 'test-bot' },
  owner: { github: 'owner-login', slack: 'UOWNER', name: 'Owner' },
  timing: { sweepMin: 30, reviewIdleDays: 7, timezone: 'America/Los_Angeles' },
} as Config;

// 2026-09-23 is a Wednesday; 2026-09-27 is a Sunday.
const WED = new Date('2026-09-23T19:00:00Z');
const SUN = new Date('2026-09-27T19:00:00Z');

function mkPr(id: number, ref: PrRef, patch: Partial<Pr> = {}): Pr {
  return {
    ...ref, id, status: 'active', reason: null, sessionId: null, reviewers: [], maxRounds: 4, autoMerge: true, pendingMerge: null,
    runCount: 0, createdAt: WED, updatedAt: WED, closedAt: null, ...patch,
  };
}
function mkWs(id: number, kind: WorkspaceKind, ref: PrRef, lastUsedAt = WED): Workspace {
  return { ...ref, id, kind, path: `/data/x/${id}`, lastUsedAt, cleanedAt: null };
}

function setup(opts: { ws?: Workspace[]; prs?: Pr[]; jobs?: Partial<Job>[]; states?: Map<string, 'OPEN' | 'MERGED' | 'CLOSED'> | Error; running?: number[]; now?: Date; dataDir?: string; exec?: Exec }) {
  const ws = opts.ws ?? [];
  const prs = opts.prs ?? [];
  const cancelled: number[] = [];
  const store = {
    liveWorkspaces: vi.fn(async () => ws.filter((w) => !w.cleanedAt)),
    getPrByRef: vi.fn(async (r: PrRef) => prs.find((p) => p.repo === r.repo && p.number === r.number) ?? null),
    updatePr: vi.fn(async (id: number, patch: Partial<Pr>) => Object.assign(prs.find((p) => p.id === id)!, patch)),
    cancelTimers: vi.fn(async (id: number) => void cancelled.push(id)),
    jobsSince: vi.fn(async () => (opts.jobs ?? []) as Job[]),
    listPrs: vi.fn(async () => prs.filter((p) => ['active', 'needs_human', 'paused'].includes(p.status))),
  };
  const github = {
    prStates: vi.fn(async () => {
      if (opts.states instanceof Error) throw opts.states;
      return opts.states ?? new Map();
    }),
  };
  const cleaned: string[] = [];
  const repos: Repos = {
    ensureWorktree: vi.fn(),
    refreshReviewWorktree: vi.fn(),
    cleanup: vi.fn(async (kind: WorkspaceKind, ref: PrRef) => {
      cleaned.push(`${kind}:${ref.repo}#${ref.number}`);
      const w = ws.find((x) => x.kind === kind && x.repo === ref.repo && x.number === ref.number);
      if (w) w.cleanedAt = new Date();
    }),
  };
  const dms: string[] = [];
  const slack = { dm: vi.fn(async (_u: string, text: string) => void dms.push(text)) };
  const janitor = createJanitor({
    config,
    store: store as unknown as Store,
    github: github as unknown as GithubPort,
    repos,
    scheduler: { isRunning: (id) => (opts.running ?? []).includes(id) },
    slack: slack as unknown as SlackPort,
    dataDir: opts.dataDir ?? '/nonexistent',
    now: () => opts.now ?? WED,
    exec: opts.exec,
  });
  return { janitor, store, github, repos, slack, cleaned, dms, prs, cancelled };
}

describe('sweep', () => {
  const a = { repo: 'o/a', number: 1 };
  const b = { repo: 'o/b', number: 2 };
  const c = { repo: 'o/c', number: 3 };

  it('merged-outside shepherd PR → terminal status, timers cancelled, one DM, cleanup', async () => {
    const t = setup({
      ws: [mkWs(1, 'shepherd', a)],
      prs: [mkPr(10, a)],
      states: new Map([['o/a#1', 'MERGED']]),
    });
    await t.janitor.sweep();
    expect(t.prs[0]).toMatchObject({ status: 'merged', closedAt: WED });
    expect(t.cancelled).toEqual([10]);
    expect(t.dms).toEqual(['o/a#1 was merged outside test-bot — stopped tracking and cleaned up its workspace.']);
    expect(t.slack.dm).toHaveBeenCalledWith('UOWNER', expect.any(String));
    expect(t.cleaned).toEqual(['shepherd:o/a#1']);
    expect(t.github.prStates).toHaveBeenCalledWith([a]);
  });

  it('PR already merged by the bot → cleanup only, no DM; closed → closed', async () => {
    const t = setup({
      ws: [mkWs(1, 'shepherd', a), mkWs(2, 'shepherd', b)],
      prs: [mkPr(10, a, { status: 'merged', closedAt: WED }), mkPr(11, b)],
      states: new Map([['o/a#1', 'MERGED'], ['o/b#2', 'CLOSED']]),
    });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual(['shepherd:o/a#1', 'shepherd:o/b#2']);
    expect(t.dms).toEqual(['o/b#2 was closed outside test-bot — stopped tracking and cleaned up its workspace.']);
    expect(t.prs[1]!.status).toBe('closed');
    expect(t.store.updatePr).toHaveBeenCalledTimes(1);
  });

  it('skips PRs with a live run and review workspaces with an active job', async () => {
    const t = setup({
      ws: [mkWs(1, 'shepherd', a), mkWs(2, 'review', b, new Date(WED.getTime() - 30 * DAY))],
      prs: [mkPr(10, a)],
      jobs: [{ ...b, status: 'running' }],
      states: new Map([['o/a#1', 'MERGED'], ['o/b#2', 'MERGED']]),
      running: [10],
    });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual([]);
    expect(t.prs[0]!.status).toBe('active');
  });

  it('review workspaces: idle > reviewIdleDays cleaned, recent kept, merged cleaned, unknown state kept', async () => {
    const d = { repo: 'o/d', number: 4 };
    const t = setup({
      ws: [
        mkWs(1, 'review', a, new Date(WED.getTime() - 8 * DAY)),
        mkWs(2, 'review', b, new Date(WED.getTime() - 2 * DAY)),
        mkWs(3, 'review', c, WED),
        mkWs(4, 'review', d, new Date(WED.getTime() - 1 * DAY)),
      ],
      jobs: [{ ...a, status: 'done' }],
      states: new Map([['o/a#1', 'OPEN'], ['o/b#2', 'OPEN'], ['o/c#3', 'MERGED']]),
    });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual(['review:o/a#1', 'review:o/c#3']);
    expect(t.dms).toEqual([]);
  });

  it('GitHub failure skips the whole round', async () => {
    const t = setup({ ws: [mkWs(1, 'review', a, new Date(0))], states: new Error('rate limited') });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual([]);
  });

  it('a batch failure falls back to per-PR queries so one bad ref does not block the rest', async () => {
    const t = setup({ ws: [mkWs(1, 'shepherd', a), mkWs(2, 'review', b, new Date(0))], prs: [mkPr(10, a, { status: 'merged' })] });
    t.github.prStates.mockImplementation(async (refs?: PrRef[]) => {
      if (refs!.length > 1 || refs![0]!.repo === 'o/b') throw new Error('Could not resolve to a Repository');
      return new Map([['o/a#1', 'MERGED' as const]]);
    });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual(['shepherd:o/a#1']);
  });

  it('untracked PR (closed in the db, still open on GitHub) gets its workspace cleaned', async () => {
    const t = setup({ ws: [mkWs(1, 'shepherd', a)], prs: [mkPr(10, a, { status: 'closed' })], states: new Map([['o/a#1', 'OPEN']]) });
    await t.janitor.sweep();
    expect(t.cleaned).toEqual(['shepherd:o/a#1']);
    expect(t.dms).toEqual([]);
  });

  it('a failing cleanup does not stop the others', async () => {
    const t = setup({
      ws: [mkWs(1, 'review', a), mkWs(2, 'review', b)],
      states: new Map([['o/a#1', 'CLOSED'], ['o/b#2', 'CLOSED']]),
    });
    vi.mocked(t.repos.cleanup).mockRejectedValueOnce(new Error('locked'));
    await t.janitor.sweep();
    expect(t.repos.cleanup).toHaveBeenCalledTimes(2);
  });

  it('no workspaces → no GitHub call', async () => {
    const t = setup({});
    await t.janitor.sweep();
    expect(t.github.prStates).not.toHaveBeenCalled();
  });
});

describe('daily', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'pr-shepherd-janitor-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const age = (p: string, days: number, now = WED) => {
    const t = new Date(now.getTime() - days * DAY);
    utimesSync(p, t, t);
  };

  it('prunes Claude sessions older than 30 days, keeping tracked PR sessions', async () => {
    const proj = join(dataDir, 'claude', 'projects', '-data-worktrees-o-a-1');
    const empty = join(dataDir, 'claude', 'projects', '-data-old');
    mkdirSync(join(proj, 'old-sess', 'tool-results'), { recursive: true });
    mkdirSync(empty, { recursive: true });
    for (const f of ['old.jsonl', 'new.jsonl', 'kept.jsonl']) writeFileSync(join(proj, f), '{}');
    writeFileSync(join(proj, 'old-sess', 'tool-results', 'r.txt'), 'x');
    writeFileSync(join(empty, 'gone.jsonl'), '{}');
    age(join(proj, 'old.jsonl'), 31);
    age(join(proj, 'kept.jsonl'), 90);
    age(join(proj, 'new.jsonl'), 3);
    age(join(proj, 'old-sess', 'tool-results', 'r.txt'), 40);
    age(join(proj, 'old-sess', 'tool-results'), 40);
    age(join(proj, 'old-sess'), 40);
    age(join(empty, 'gone.jsonl'), 45);

    const t = setup({ dataDir, prs: [mkPr(1, { repo: 'o/a', number: 1 }, { sessionId: 'kept' })] });
    await t.janitor.daily();
    expect(existsSync(join(proj, 'old.jsonl'))).toBe(false);
    expect(existsSync(join(proj, 'old-sess'))).toBe(false);
    expect(existsSync(join(proj, 'new.jsonl'))).toBe(true);
    expect(existsSync(join(proj, 'kept.jsonl'))).toBe(true);
    expect(existsSync(empty)).toBe(false);
  });

  it('marks idle mirrors, deletes them after 30 days, clears the mark when used, gc only on Sundays', async () => {
    const used = join(dataDir, 'repos', 'o', 'a.git');
    const idle = join(dataDir, 'repos', 'o', 'b.git');
    mkdirSync(used, { recursive: true });
    mkdirSync(idle, { recursive: true });
    writeFileSync(join(used, 'pr-shepherd-idle-since'), new Date(0).toISOString());
    const calls: { args: string[]; cwd?: string }[] = [];
    const exec: Exec = async (_cmd, args, o) => {
      calls.push({ args, cwd: o?.cwd });
      return { stdout: '', stderr: '' };
    };
    const ws = [mkWs(1, 'shepherd', { repo: 'o/a', number: 1 })];

    // Wednesday: no gc; idle mirror gets a marker; used mirror loses its marker.
    await setup({ dataDir, ws, now: WED, exec }).janitor.daily();
    expect(calls).toEqual([]);
    expect(existsSync(join(used, 'pr-shepherd-idle-since'))).toBe(false);
    expect(readFileSync(join(idle, 'pr-shepherd-idle-since'), 'utf8').trim()).toBe(WED.toISOString());

    // Sunday, 4 days idle: gc both, keep both.
    await setup({ dataDir, ws, now: SUN, exec }).janitor.daily();
    expect(calls.map((c) => [c.args.join(' '), c.cwd])).toEqual([
      ['gc --prune=now --quiet', used],
      ['gc --prune=now --quiet', idle],
    ]);
    expect(existsSync(idle)).toBe(true);

    // 31 days later: idle mirror deleted.
    await setup({ dataDir, ws, now: new Date(WED.getTime() + 31 * DAY), exec }).janitor.daily();
    expect(existsSync(idle)).toBe(false);
    expect(existsSync(used)).toBe(true);
  });

  it('is a no-op when directories do not exist', async () => {
    await expect(setup({ dataDir: join(dataDir, 'missing') }).janitor.daily()).resolves.toBeUndefined();
  });
});

describe('start', () => {
  afterEach(() => vi.useRealTimers());
  it('runs sweep + daily at start, sweep every sweepMin, and stops', async () => {
    vi.useFakeTimers();
    const t = setup({ ws: [mkWs(1, 'review', { repo: 'o/a', number: 1 })], states: new Map() });
    const stop = t.janitor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.github.prStates).toHaveBeenCalledTimes(1);
    expect(t.store.listPrs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.github.prStates).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(t.github.prStates).toHaveBeenCalledTimes(2);
    expect(t.store.listPrs).toHaveBeenCalledTimes(1);
  });
});


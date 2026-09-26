import { migrationSql } from './migrations.js';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createActuator } from '../src/actuator.js';
import { helpText } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import type { Command, Db, GithubPort, PrMeta, Repos, SlackMessage, SlackPort } from '../src/contracts.js';
import { createControl, OWNER_ONLY, UNSUPPORTED } from '../src/control.js';
import { createInbox } from '../src/inbox.js';
import type { ShepherdOutput } from '../src/output.js';
import { createStore } from '../src/store.js';

const migration = migrationSql;
const config = loadConfig('config.example.yaml');
const OWNER = config.owner.slack;
const ref = { repo: 'your-org/example-cli', number: 271 };

let store: ReturnType<typeof createStore>;
let meta: PrMeta;
let posts: { channel: string; text: string; threadTs?: string }[];
let dms: string[];
let reactions: string[];
let pokes: number[];
let cleaned: string[];
let merges: string[];
let running: Set<number>;
let paused: boolean;
let calls: string[];
let threadReplies: SlackMessage[];
let g3Calls: string[];
let control: ReturnType<typeof createControl>;

const slack: SlackPort = {
  async post(channel, text, threadTs) {
    posts.push({ channel, text, threadTs });
    return { ts: `${2000 + posts.length}.0`, permalink: '' };
  },
  async react(_c, ts, emoji) {
    reactions.push(`${ts}:${emoji}`);
  },
  async delete() {},
  async dm(_u, text) {
    dms.push(text);
    return { channel: 'D-owner', ts: `${9000 + dms.length}.0` };
  },
  async replies() {
    return threadReplies;
  },
  async channelId(name) {
    return `C-${name}`;
  },
};

const github = {
  async prMeta() {
    return meta;
  },
  async merge(_r: unknown, sha: string) {
    merges.push(sha);
    return { ok: true } as const;
  },
  async comment() {},
} as unknown as GithubPort;

const repos: Repos = {
  async ensureWorktree() {
    return '';
  },
  async refreshReviewWorktree() {
    return '';
  },
  async cleanup(kind, r) {
    cleaned.push(`${kind}:${r.repo}#${r.number}`);
  },
};

const msg = (text: string, user = OWNER, extra: Partial<SlackMessage> = {}): SlackMessage => ({ channel: 'C1', ts: `${Math.random()}`, user, text, ...extra });
const lastPost = () => posts.at(-1)?.text;

beforeEach(async () => {
  const pg = new PGlite();
  await pg.exec(migration);
  const db: Db = { query: async (t, p) => (await pg.query(t, p)) as never };
  store = createStore(db);
  meta = { ...ref, state: 'OPEN', author: config.owner.github, isDraft: false, title: 't', body: '', headRef: 'feat', headSha: 'abcdef1234567', authorIsOrgMember: true };
  posts = [];
  dms = [];
  reactions = [];
  pokes = [];
  cleaned = [];
  merges = [];
  running = new Set();
  paused = false;
  calls = [];
  threadReplies = [];
  g3Calls = [];
  const actuator = createActuator({ config, store, slack, github, repos });
  control = createControl({
    config, store, github, repos, slack, actuator,
    scheduler: {
      poke: (id) => void pokes.push(id),
      isRunning: (id) => running.has(id),
      start: () => void calls.push('start'),
      paused: () => paused,
      pauseAll: () => void calls.push('pauseAll'),
      resumeAll: () => void calls.push('resumeAll'),
    },
    g3: {
      onReview: async (c) => void g3Calls.push(`review ${c.pr.repo}#${c.pr.number}`),
      onApprove: async (c) => void g3Calls.push(`approve ${c.pr.repo}#${c.pr.number}`),
    },
  });
});

describe('register (DESIGN §5.2)', () => {
  it('registers a new PR, then reports updated on re-register', async () => {
    const a = await control.register(ref);
    expect(a).toMatchObject({ code: 202, body: { status: 'registered' } });
    const prId = (a.body as { prId: number }).prId;
    const pr = await store.getPr(prId);
    expect(pr).toMatchObject({ status: 'active', reviewers: config.reviewers.map((r) => r.name), maxRounds: config.limits.maxRounds });
    const b = await control.register(ref);
    expect(b).toMatchObject({ code: 202, body: { status: 'updated', prId } });
    expect((await store.pendingEvents(prId)).map((e) => e.kind)).toEqual(['registered', 'updated']);
    expect(pokes).toEqual([prId, prId]);
  });

  it('rejects other orgs, excluded repos, other authors, drafts and closed PRs', async () => {
    expect((await control.register({ repo: 'Other/cli', number: 1 })).code).toBe(403);
    const cfg = { ...config, excludeRepos: ['example-cli'] };
    const c2 = createControl({ config: cfg, store, github, repos, slack, actuator: {} as never, scheduler: {} as never, g3: {} as never });
    expect((await c2.register(ref)).code).toBe(403);
    meta.author = 'someone';
    expect((await control.register(ref)).code).toBe(403);
    meta.author = config.owner.github;
    meta.isDraft = true;
    expect((await control.register(ref)).code).toBe(409);
    meta.isDraft = false;
    meta.state = 'MERGED';
    expect((await control.register(ref)).code).toBe(409);
    expect(await store.listPrs()).toEqual([]);
  });

  it('returns 400 when the PR cannot be read', async () => {
    const broken = { ...github, prMeta: async () => { throw new Error('not found'); } } as GithubPort;
    const c2 = createControl({ config, store, github: broken, repos, slack, actuator: {} as never, scheduler: {} as never, g3: {} as never });
    expect(await c2.register(ref)).toMatchObject({ code: 400 });
  });
});

describe('commands (DESIGN §9)', () => {
  const run = (cmd: Command, m = msg('x')) => control.onCommand(cmd, m);

  it('refuses owner-only commands from others, allows G3 and help for anyone', async () => {
    await run({ kind: 'track', pr: ref }, msg('x', 'USOMEONE'));
    expect(lastPost()).toBe(OWNER_ONLY);
    expect(await store.listPrs()).toEqual([]);
    await run({ kind: 'g3_review', pr: ref, context: '' }, msg('x', 'USOMEONE'));
    await run({ kind: 'g3_approve', pr: ref, context: '' }, msg('x', 'USOMEONE'));
    expect(g3Calls).toEqual(['review your-org/example-cli#271', 'approve your-org/example-cli#271']);
    await run({ kind: 'help' }, msg('x', 'USOMEONE'));
    expect(lastPost()).toBe(helpText(config.bot.name));
    await run({ kind: 'unknown', text: 'dance' }, msg('x', 'USOMEONE'));
    expect(lastPost()).toBe(UNSUPPORTED);
  });

  it('reacts :eyes: and replies in thread; DMs get unthreaded replies', async () => {
    const m = msg('x', OWNER, { ts: '5.0' });
    await run({ kind: 'help' }, m);
    expect(reactions).toContain('5.0:eyes');
    expect(posts.at(-1)?.threadTs).toBe('5.0');
    await run({ kind: 'help' }, msg('x', OWNER, { channel: 'D1' }));
    expect(posts.at(-1)?.threadTs).toBeUndefined();
  });

  it('track registers; status lists tracked PRs with status_line and rounds', async () => {
    await run({ kind: 'track', pr: ref });
    expect(lastPost()).toContain('registered');
    const pr = (await store.getPrByRef(ref))!;
    const r = await store.createRun({ prId: pr.id });
    const output: ShepherdOutput = {
      handled: [{ reviewer: 'review-bot', review_url: 'u', items: [{ url: 'x', severity: 'Critical', action: 'fix', commit: 'def5678', note: 'n' }] }],
      rebase: null, status_line: 'waiting on review-bot re-review', next: { action: 'wait', minutes: 5, reason: 'ci' },
    };
    await store.updateRun(r.id, { status: 'ok', output, appliedAt: new Date() });
    await run({ kind: 'status' });
    expect(lastPost()).toBe('your-org/example-cli#271 active — waiting on review-bot re-review · rounds review-bot=0/4 codex-bot=0/4');
    await run({ kind: 'status', pr: ref });
    expect(lastPost()).toContain('last run: fix 1 · reply 0 · escalate 0');
    await run({ kind: 'status', pr: { repo: 'your-org/x', number: 1 } });
    expect(lastPost()).toBe('your-org/x#1 is not tracked');

    // an interrupted run without output does not hide the last status line
    const cut = await store.createRun({ prId: pr.id });
    await store.updateRun(cut.id, { status: 'interrupted' });
    await run({ kind: 'status' });
    expect(lastPost()).toBe('your-org/example-cli#271 active — waiting on review-bot re-review · rounds review-bot=0/4 codex-bot=0/4');
    await run({ kind: 'status', pr: ref });
    expect(lastPost()).toContain('last run: fix 1');
  });

  it('resume from needs_human with an empty inbox leaves an event saying why, so a run starts', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { status: 'needs_human', reason: 'reviewers conflict' });
    await run({ kind: 'resume', pr: ref });
    expect((await store.getPr(pr.id))!.status).toBe('active');
    const ev = await store.pendingEvents(pr.id);
    expect(ev.map((e) => [e.kind, e.payload.text])).toEqual([['owner', 'resumed by owner (was needs_human (reviewers conflict))']]);
    expect(pokes).toEqual([pr.id]);
  });

  it('merge while a run is live leaves the worktree to the janitor', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { autoMerge: false, pendingMerge: { sha: 'abc1234', title: 'feat' } });
    running.add(pr.id);
    await run({ kind: 'merge', pr: ref });
    expect((await store.getPr(pr.id))!.status).toBe('merged');
    expect(cleaned).toEqual([]);
  });

  it('tell adds an owner event and leaves needs_human', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { status: 'needs_human', reason: 'max_runs', runCount: 30 });
    await run({ kind: 'tell', pr: ref, text: 'hold off on Suggestions' });
    const after = (await store.getPr(pr.id))!;
    expect(after).toMatchObject({ status: 'active', reason: null, runCount: 0 });
    expect((await store.pendingEvents(pr.id)).map((e) => [e.kind, e.payload.text])).toEqual([['owner', 'hold off on Suggestions']]);
    expect(pokes).toEqual([pr.id]);
  });

  it('set updates policy; raising rounds lifts a max_rounds stop', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { status: 'needs_human', reason: 'max_rounds' });
    await run({ kind: 'set', pr: ref, rounds: 6, reviewers: ['review-bot', 'codex-bot'], autoMerge: false });
    expect(await store.getPr(pr.id)).toMatchObject({ status: 'active', reason: null, maxRounds: 6, reviewers: ['review-bot', 'codex-bot'], autoMerge: false });
    expect(pokes).toEqual([pr.id]);
    await run({ kind: 'set', pr: ref, reviewers: ['Nobody'] });
    expect(lastPost()).toContain('unknown reviewers: Nobody');
    expect((await store.getPr(pr.id))!.reviewers).toEqual(['review-bot', 'codex-bot']);
  });

  it('untrack closes and cleans up, but leaves a live run its worktree', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: new Date(0) });
    await run({ kind: 'untrack', pr: ref });
    expect(await store.getPr(pr.id)).toMatchObject({ status: 'closed', reason: 'untracked' });
    expect(await store.dueTimers(new Date())).toEqual([]);
    expect(cleaned).toEqual(['shepherd:your-org/example-cli#271']);

    const other = await store.upsertPr({ repo: 'your-org/example-cli', number: 9 }, ['review-bot'], 4);
    running.add(other.pr.id);
    await run({ kind: 'untrack', pr: { repo: 'your-org/example-cli', number: 9 } });
    expect(cleaned).toHaveLength(1);
  });

  it('merge releases a pending merge through the actuator', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await run({ kind: 'merge', pr: ref });
    expect(lastPost()).toContain('no merge is waiting');
    await store.updatePr(pr.id, { autoMerge: false, pendingMerge: { sha: 'abc1234', title: 'feat' } });
    await run({ kind: 'merge', pr: ref });
    expect(merges).toEqual(['abc1234']);
    expect(await store.getPr(pr.id)).toMatchObject({ status: 'merged', pendingMerge: null });
    expect(lastPost()).toBe('merged your-org/example-cli#271');
  });

  it('pause / resume a PR and all', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { runCount: 12 });
    await run({ kind: 'pause', pr: ref });
    expect((await store.getPr(pr.id))!.status).toBe('paused');
    await run({ kind: 'resume', pr: ref });
    expect(await store.getPr(pr.id)).toMatchObject({ status: 'active', runCount: 0 });
    expect(pokes).toEqual([pr.id]);
    await run({ kind: 'pause', pr: 'all' });
    await run({ kind: 'resume', pr: 'all' });
    expect(calls).toEqual(['pauseAll', 'resumeAll']);
  });

  it('report DMs the owner', async () => {
    await run({ kind: 'report' });
    expect(dms).toEqual(['pr-shepherd · nothing to report']);
  });
});

describe('timers and recovery (DESIGN §5.7)', () => {
  it('fires due timers into events and pokes; frozen while paused', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: new Date(Date.now() - 1000), note: 'ci' });
    paused = true;
    await control.tickTimers();
    expect(await store.pendingEvents(pr.id)).toEqual([]);
    paused = false;
    await control.tickTimers();
    expect((await store.pendingEvents(pr.id)).map((e) => e.kind)).toEqual(['timer']);
    expect(pokes).toEqual([pr.id]);
  });

  it('applies unapplied runs, marks cut-off runs, fails orphaned jobs, backfills threads, then starts', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    const done = await store.createRun({ prId: pr.id });
    await store.updateRun(done.id, {
      status: 'ok',
      output: { handled: [], rebase: null, status_line: 's', next: { action: 'wait', minutes: 10, reason: 'ci' } },
    });
    const cut = await store.createRun({ prId: pr.id });
    const job = await store.addJob({ repo: 'your-org/other', number: 3, kind: 'review', requestedBy: 'U1', channel: 'C9', threadTs: '9.0' });
    await store.updateJob(job!.id, { status: 'running' });
    const req = await store.addReviewRequest({ prId: pr.id, runId: done.id, kind: 'review', bot: 'review-bot', round: 1, resend: false, channel: 'C-pr-review', requestTs: '100.0' });
    const reviewBot = config.reviewers.find((r) => r.name === 'review-bot')!.slack;
    threadReplies = [{ channel: 'C-pr-review', ts: '101.0', threadTs: '100.0', user: reviewBot, text: 'review: <https://github.com/your-org/example-cli/pull/271#pullrequestreview-1>' }];
    const inbox = createInbox({ config, store, scheduler: { poke: (id) => void pokes.push(id) } });

    await control.recover(inbox);

    expect(await store.unappliedRuns()).toEqual([]);
    expect((await store.runsByStatus(['interrupted'])).map((r) => r.id)).toEqual([cut.id]);
    const kinds = (await store.pendingEvents(pr.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['restarted', 'review_done']));
    expect((await store.jobsSince(new Date(0)))[0]).toMatchObject({ status: 'failed' });
    expect(posts.some((p) => p.channel === 'C9' && p.text.includes('restarted'))).toBe(true);
    expect((await store.openRequests(pr.id)).find((r) => r.id === req!.id)).toBeUndefined();
    expect(calls).toEqual(['start']);

    // Idempotent: a second boot adds nothing new.
    const before = (await store.pendingEvents(pr.id)).length;
    await control.recover(inbox);
    expect((await store.pendingEvents(pr.id)).length).toBe(before);
  });
});

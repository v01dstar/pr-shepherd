import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { GithubPort, GithubReview, Job, PrMeta, PrRef, Repos, RunResult, SlackPort, Store } from '../src/contracts.js';
import { BUSY_REPLY, EXTERNAL_NOTE, FOLLOW_UP_REPLY, ownPrReply, createG3, formatGithubReview, formatSlackVerdict } from '../src/g3.js';
import { classifyReply } from '../src/inbox.js';
import type { ReviewOutput } from '../src/output.js';

const config = {
  bot: { name: 'test-bot' },
  org: 'your-org',
  owner: { github: 'owner-login', slack: 'UOWNER', name: 'Owner' },
  limits: { maxRounds: 4, maxRunsPerPr: 30, maxTurns: 60, shepherdConcurrency: 1, reviewConcurrency: 2 },
} as Config;

const SHA = '5efeec6a1b2c3d4e5f60718293a4b5c6d7e8f901';
const REVIEW_URL = 'https://github.com/your-org/example-e2e/pull/141#pullrequestreview-5294732335';
const pr = (number = 141, repo = 'your-org/example-e2e'): PrRef => ({ repo, number });
const msg = { channel: 'C1', ts: '100.1', user: 'U_REQ', text: '<@BOT> review …' };

const output = (o: Partial<ReviewOutput> = {}): ReviewOutput => ({
  round: 2,
  head_sha: '5efeec6',
  verdict: 'approved',
  counts: { critical: 0, suggestion: 1, information: 1 },
  summary: 'Adds the regression row; looks right.',
  verified: 'Ran npm test: 42 passed. Reverted the fix: the new row reds.',
  comments: [
    { path: 'src/b.ts', line: 3, severity: 'Information', body: 'fyi' },
    { path: 'src/a.ts', line: 42, severity: 'Suggestion', body: 'rename\nthis' },
  ],
  ...o,
});

function harness(opts: { meta?: Partial<PrMeta>; run?: (job: Job) => Promise<RunResult>; postReview?: (r: GithubReview) => Promise<{ url: string }>; concurrency?: number; cleanupError?: string } = {}) {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const reactions: string[] = [];
  const reviews: GithubReview[] = [];
  const jobs = new Map<number, Job>();
  const runs: { job: Job; cwd: string; context: string }[] = [];
  const cleanups: PrRef[] = [];
  let nextId = 1;

  const store = {
    async addJob(j) {
      for (const x of jobs.values()) if (x.repo === j.repo && x.number === j.number && x.kind === j.kind && x.status === 'queued') return null;
      const job: Job = { ...j, id: nextId++, status: 'queued', verdict: null, createdAt: new Date(), endedAt: null };
      jobs.set(job.id, job);
      return job;
    },
    async updateJob(id, patch) {
      Object.assign(jobs.get(id)!, patch);
    },
  } as Partial<Store> as Store;
  const slack = {
    async post(channel, text, threadTs) {
      posts.push({ channel, text, threadTs });
      return { ts: String(posts.length), permalink: '' };
    },
    async react(_c, _ts, emoji) {
      reactions.push(emoji);
    },
  } as Partial<SlackPort> as SlackPort;
  const github = {
    async prMeta(ref) {
      return { ...ref, state: 'OPEN', author: 'someone', isDraft: false, title: 'BYO zones door', body: '', headRef: 'feat', headSha: SHA, authorIsOrgMember: true, ...opts.meta } as PrMeta;
    },
    async postReview(_ref, r) {
      reviews.push(r);
      return opts.postReview ? opts.postReview(r) : { url: REVIEW_URL };
    },
    async login() {
      return 'owner-login';
    },
  } as Partial<GithubPort> as GithubPort;
  const repos: Repos = {
    async ensureWorktree(_k, ref) {
      return `/data/review-worktrees/${ref.number}`;
    },
    async refreshReviewWorktree(ref) {
      return `/data/review-worktrees/${ref.number}`;
    },
    async cleanup(_k, ref) {
      cleanups.push(ref);
      if (opts.cleanupError) throw new Error(opts.cleanupError);
    },
  };
  const scheduler = {
    async runReview(job: Job, cwd: string, context: string): Promise<RunResult> {
      runs.push({ job, cwd, context });
      return opts.run ? opts.run(job) : { status: 'ok', output: output(), sessionId: 's', turns: 3, usage: {} };
    },
  };
  const cfg = { ...config, limits: { ...config.limits, reviewConcurrency: opts.concurrency ?? 2 } };
  const g3 = createG3({ config: cfg, store, slack, github, repos, scheduler, now: () => new Date('2026-09-23T00:00:00Z') });
  return { g3, posts, reactions, reviews, jobs, runs, cleanups };
}

const review = (ref = pr(), context = '') => ({ kind: 'g3_review' as const, pr: ref, context });
const approve = (ref = pr()) => ({ kind: 'g3_approve' as const, pr: ref, context: '' });

describe('formatting', () => {
  it('GitHub review body and inline prefixes', () => {
    const { body, comments } = formatGithubReview(output());
    expect(body).toBe(
      '## Verdict: approved — 0 Critical · 1 Suggestion · 1 Information\n\n' +
        'Adds the regression row; looks right.\n\n' +
        '### Verified\nRan npm test: 42 passed. Reverted the fix: the new row reds.\n\n' +
        '### Findings\n- [Suggestion] src/a.ts:42 — rename this\n- [Information] src/b.ts:3 — fyi',
    );
    expect(comments).toEqual([
      { path: 'src/a.ts', line: 42, body: '**[Suggestion]** rename\nthis' },
      { path: 'src/b.ts', line: 3, body: '**[Information]** fyi' },
    ]);
    expect(formatGithubReview(output({ comments: [] })).body).toContain('### Findings\n- none');
  });

  it('Slack verdict matches review-bot and classifies as done', () => {
    const meta = { repo: 'your-org/example-e2e', number: 141, title: 'BYO zones door' };
    const ok = formatSlackVerdict(output(), meta, REVIEW_URL);
    expect(ok).toBe(
      ':white_check_mark: review verdict: *approved*\n' +
        `review: <${REVIEW_URL}>\n` +
        'Round 2 on example-e2e#141 (BYO zones door) at 5efeec6 — COMMENT/approved, 0 Critical, 1 Suggestion, 1 Information. Adds the regression row; looks right.',
    );
    const bad = formatSlackVerdict(output({ verdict: 'request_changes', counts: { critical: 1, suggestion: 0, information: 0 } }), meta, REVIEW_URL);
    expect(bad.split('\n')[0]).toBe(':octagonal_sign: review verdict: *request_changes*');
    for (const text of [ok, bad]) expect(classifyReply(text)).toMatchObject({ kind: 'done', reviewUrl: REVIEW_URL });
  });
});

describe('onReview', () => {
  it('runs, posts the GitHub review and the Slack verdict', async () => {
    const h = harness();
    await h.g3.onReview(review(pr(), 'focus on the migration'), msg);

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.cwd).toBe('/data/review-worktrees/141');
    expect(h.runs[0]!.context).toBe('focus on the migration');
    expect(h.reviews[0]).toMatchObject({ event: 'COMMENT', commitId: SHA });
    expect(h.reviews[0]!.comments).toHaveLength(2);

    expect(h.posts.map((p) => p.threadTs)).toEqual(['100.1', '100.1']);
    expect(h.posts[0]!.text).toBe(':mag: starting code review on <https://github.com/your-org/example-e2e/pull/141> …');
    const verdict = h.posts[1]!.text;
    expect(verdict.startsWith(':white_check_mark: review verdict: *approved*')).toBe(true);
    expect(classifyReply(verdict)).toMatchObject({ kind: 'done', reviewUrl: REVIEW_URL });

    expect(h.reactions).toEqual(['eyes', 'white_check_mark']);
    expect(h.jobs.get(1)).toMatchObject({ kind: 'review', requestedBy: 'U_REQ', status: 'done', verdict: 'approved' });
  });

  it('request_changes → :octagonal_sign: and :no_entry:', async () => {
    const h = harness({ run: async () => ({ status: 'ok', output: output({ verdict: 'request_changes' }), sessionId: 's', turns: 1, usage: {} }) });
    await h.g3.onReview(review(), msg);
    expect(h.posts[1]!.text.split('\n')[0]).toBe(':octagonal_sign: review verdict: *request_changes*');
    expect(h.reactions).toEqual(['eyes', 'no_entry']);
    expect(h.jobs.get(1)!.verdict).toBe('request_changes');
  });

  it('external contributors get a static-only review', async () => {
    const h = harness({ meta: { authorIsOrgMember: false } });
    await h.g3.onReview(review(pr(), 'ctx'), msg);
    expect(h.runs[0]!.context).toBe(`ctx\n${EXTERNAL_NOTE}`);
  });

  it('refuses my own PR, other orgs, and closed PRs without queueing', async () => {
    const own = harness({ meta: { author: 'owner-login' } });
    await own.g3.onReview(review(), msg);
    expect(own.posts.map((p) => p.text)).toEqual([ownPrReply(config.bot.name)]);

    const other = harness();
    await other.g3.onReview(review(pr(1, 'Elsewhere/x')), msg);
    expect(other.posts[0]!.text).toBe(':x: <https://github.com/Elsewhere/x/pull/1> — review failed (not in your-org)');

    const closed = harness({ meta: { state: 'MERGED' } });
    await closed.g3.onReview(review(), msg);
    expect(closed.posts[0]!.text).toContain('review failed (PR is merged)');

    for (const h of [own, other, closed]) {
      expect(h.jobs.size).toBe(0);
      expect(h.runs).toHaveLength(0);
    }
  });

  it('agent failure → :x: … review failed, job failed', async () => {
    const h = harness({ run: async () => ({ status: 'error', sessionId: null, error: 'boom' }) });
    await h.g3.onReview(review(), msg);
    const last = h.posts.at(-1)!.text;
    expect(last).toBe(':x: <https://github.com/your-org/example-e2e/pull/141> — review failed (error: boom)');
    expect(classifyReply(last).kind).toBe('error');
    expect(h.reviews).toHaveLength(0);
    expect(h.jobs.get(1)).toMatchObject({ status: 'failed' });
    expect(h.g3.inFlight()).toBe(0);
  });

  it('falls back to a body-only review when GitHub rejects inline comments', async () => {
    let calls = 0;
    const h = harness({ postReview: async () => (++calls === 1 ? Promise.reject(new Error('422 line not in diff')) : { url: REVIEW_URL }) });
    await h.g3.onReview(review(), msg);
    expect(h.reviews).toHaveLength(2);
    expect(h.reviews[1]!.comments).toBeUndefined();
    expect(h.jobs.get(1)!.status).toBe('done');
  });

  it('queues when the pool is full and merges duplicate requests', async () => {
    const gates: (() => void)[] = [];
    const h = harness({
      concurrency: 1,
      run: (job) =>
        new Promise((resolve) => gates.push(() => resolve({ status: 'ok', output: output(), sessionId: `s${job.id}`, turns: 1, usage: {} }))),
    });
    const first = h.g3.onReview(review(pr(1)), { ...msg, ts: '1' });
    await flush();
    expect(h.g3.inFlight()).toBe(1);
    expect(h.g3.busy()).toBe(true);

    const second = h.g3.onReview(review(pr(2)), { ...msg, ts: '2' });
    await flush();
    const dupe = h.g3.onReview(review(pr(2)), { ...msg, ts: '3' });
    await dupe;
    expect(h.posts.filter((p) => p.text === BUSY_REPLY).map((p) => p.threadTs)).toEqual(['2']);
    expect(h.posts.filter((p) => p.threadTs === '3')).toHaveLength(0); // duplicate: only :eyes:
    expect(h.runs).toHaveLength(1);

    gates[0]!();
    await first;
    await flush();
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]!.job.number).toBe(2);
    gates[1]!();
    await second;
    expect(h.g3.inFlight()).toBe(0);
    expect([...h.jobs.values()].map((j) => j.status)).toEqual(['done', 'done']);
  });
});

describe('review-fix regressions', () => {
  it('a re-review requested while one is running queues a follow-up that runs after it', async () => {
    const gates: (() => void)[] = [];
    const h = harness({
      concurrency: 2,
      run: (job) =>
        new Promise((resolve) => gates.push(() => resolve({ status: 'ok', output: output(), sessionId: `s${job.id}`, turns: 1, usage: {} }))),
    });
    const first = h.g3.onReview(review(pr(1)), { ...msg, ts: '1' });
    await flush();
    expect(h.runs).toHaveLength(1);
    const again = h.g3.onReview(review(pr(1)), { ...msg, ts: '2' });
    await flush();
    expect(h.posts.filter((p) => p.text === FOLLOW_UP_REPLY).map((p) => p.threadTs)).toEqual(['2']);
    expect(h.runs).toHaveLength(1); // not concurrently on the same worktree, despite a free slot
    const dupe = h.g3.onReview(review(pr(1)), { ...msg, ts: '3' });
    await dupe; // the follow-up is still queued: merged into it
    gates[0]!();
    await first;
    await flush();
    expect(h.runs).toHaveLength(2);
    gates[1]!();
    await again;
    expect([...h.jobs.values()].map((j) => j.status)).toEqual(['done', 'done']);
  });
});

describe('onApprove', () => {
  it('approves as me, pinned to the head, then cleans up', async () => {
    const h = harness({ cleanupError: 'workspace not registered' });
    await h.g3.onApprove(approve(), msg);
    expect(h.reviews).toEqual([{ event: 'APPROVE', body: 'LGTM', commitId: SHA }]);
    const text = h.posts[0]!.text;
    expect(text).toBe(`:white_check_mark: <https://github.com/your-org/example-e2e/pull/141> — approved as owner-login (<${REVIEW_URL}>)`);
    expect(classifyReply(text)).toMatchObject({ kind: 'done', reviewUrl: REVIEW_URL });
    expect(h.reactions).toEqual(['eyes', 'white_check_mark']);
    expect(h.jobs.get(1)).toMatchObject({ kind: 'approve', status: 'done', verdict: 'approved' });
    expect(h.cleanups).toEqual([pr()]);
  });

  it('GitHub failure → :x: … failed, no cleanup', async () => {
    const h = harness({ postReview: async () => Promise.reject(new Error('Review cannot be requested')) });
    await h.g3.onApprove(approve(), msg);
    const text = h.posts[0]!.text;
    expect(text).toBe(':x: <https://github.com/your-org/example-e2e/pull/141> — failed (github): Review cannot be requested');
    expect(classifyReply(text).kind).toBe('error');
    expect(h.jobs.get(1)).toMatchObject({ status: 'failed', verdict: 'failed' });
    expect(h.cleanups).toHaveLength(0);
  });

  it('refuses my own PR', async () => {
    const h = harness({ meta: { author: 'Owner-Login' } });
    await h.g3.onApprove(approve(), msg);
    expect(h.posts.map((p) => p.text)).toEqual([ownPrReply(config.bot.name)]);
    expect(h.reviews).toHaveLength(0);
  });
});

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

import { migrationSql } from './migrations.js';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/contracts.js';
import { createStore } from '../src/store.js';

const migration = migrationSql;

async function freshStore() {
  const pg = new PGlite();
  await pg.exec(migration);
  const db: Db = { query: async (t, p) => (await pg.query(t, p)) as never };
  return createStore(db);
}

const ref = { repo: 'your-org/example-cli', number: 7 };
let store: Awaited<ReturnType<typeof freshStore>>;
beforeEach(async () => {
  store = await freshStore();
});

describe('prs', () => {
  it('upserts, reads and patches', async () => {
    const a = await store.upsertPr(ref, ['review-bot', 'codex-bot'], 4);
    expect(a.created).toBe(true);
    expect(a.pr).toMatchObject({ ...ref, status: 'active', reviewers: ['review-bot', 'codex-bot'], maxRounds: 4, autoMerge: true, pendingMerge: null, runCount: 0 });
    expect(typeof a.pr.id).toBe('number');
    expect(a.pr.createdAt).toBeInstanceOf(Date);

    const b = await store.upsertPr(ref, ['x'], 9);
    expect(b.created).toBe(false);
    expect(b.pr.reviewers).toEqual(['review-bot', 'codex-bot']);

    const p = await store.updatePr(a.pr.id, { status: 'needs_human', reason: 'max_rounds', pendingMerge: { sha: 'abc1234', title: 't' }, reviewers: ['codex-bot'], runCount: 3 });
    expect(p).toMatchObject({ status: 'needs_human', reason: 'max_rounds', pendingMerge: { sha: 'abc1234', title: 't' }, reviewers: ['codex-bot'], runCount: 3 });
    expect((await store.getPr(a.pr.id))?.reason).toBe('max_rounds');
    expect((await store.getPrByRef(ref))?.id).toBe(a.pr.id);
    expect(await store.getPr(999)).toBeNull();
    expect(await store.getPrByRef({ repo: 'x/y', number: 1 })).toBeNull();

    await store.upsertPr({ repo: 'your-org/example-cli', number: 8 }, ['codex-bot'], 4);
    expect((await store.listPrs()).length).toBe(2);
    expect((await store.listPrs(['needs_human'])).map((x) => x.number)).toEqual([7]);

    await store.updatePr(a.pr.id, { pendingMerge: null });
    expect((await store.getPr(a.pr.id))?.pendingMerge).toBeNull();
  });

  it('claimDmThread: the first claim wins, later ones get the stored thread; lookup by thread', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    expect(await store.claimDmThread(pr.id, 'D1', '100.0')).toMatchObject({ dmChannel: 'D1', dmTs: '100.0' });
    expect(await store.claimDmThread(pr.id, 'D1', '200.0')).toMatchObject({ dmChannel: 'D1', dmTs: '100.0' });
    expect((await store.getPrByDmThread('D1', '100.0'))?.id).toBe(pr.id);
    expect(await store.getPrByDmThread('D1', '200.0')).toBeNull();
  });

  it('re-tracking a closed PR reactivates it', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    await store.updatePr(pr.id, { status: 'closed', closedAt: new Date(), runCount: 5 });
    const again = await store.upsertPr(ref, ['review-bot'], 6);
    expect(again.created).toBe(true);
    expect(again.pr).toMatchObject({ id: pr.id, status: 'active', closedAt: null, runCount: 0, reviewers: ['review-bot'], maxRounds: 6 });
  });

  it('re-tracking starts a fresh lifecycle: new session, rounds and requests start over', async () => {
    const { pr } = await store.upsertPr(ref, ['review-bot'], 4);
    await store.updatePr(pr.id, { sessionId: 'old-session' });
    const base = { prId: pr.id, kind: 'review' as const, bot: 'review-bot', resend: false, channel: 'C', requestTs: '1.0' };
    await store.addReviewRequest({ ...base, runId: 1, round: 4 });
    await store.updatePr(pr.id, { status: 'closed', reason: 'untracked', closedAt: new Date() });
    const again = await store.upsertPr(ref, ['review-bot'], 4);
    expect(again.pr.sessionId).toBeNull();
    expect(await store.roundsByBot(pr.id)).toEqual({});
    expect(await store.openRequests(pr.id)).toEqual([]);
    expect(await store.requestsForPr(pr.id)).toEqual([]);
    await store.addReviewRequest({ ...base, runId: 2, round: 1 });
    expect(await store.roundsByBot(pr.id)).toEqual({ 'review-bot': 1 });
  });
});

describe('events', () => {
  it('dedupes, lists pending and claims', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    const e1 = await store.addEvent({ prId: pr.id, kind: 'review_done', payload: { reviewer: 'codex-bot' }, dedupeKey: 'C1:1.0' });
    expect(e1).toMatchObject({ prId: pr.id, kind: 'review_done', payload: { reviewer: 'codex-bot' }, dedupeKey: 'C1:1.0', runId: null });
    expect(await store.addEvent({ prId: pr.id, kind: 'review_done', dedupeKey: 'C1:1.0' })).toBeNull();
    const e2 = await store.addEvent({ prId: pr.id, kind: 'owner' });
    const e3 = await store.addEvent({ prId: pr.id, kind: 'owner' }); // no dedupe key never conflicts
    expect(e2!.payload).toEqual({});
    expect((await store.pendingEvents(pr.id)).map((e) => e.id)).toEqual([e1!.id, e2!.id, e3!.id]);

    const run = await store.createRun({ prId: pr.id });
    await store.claimEvents([e1!.id, e2!.id], run.id);
    await store.claimEvents([], run.id);
    expect((await store.pendingEvents(pr.id)).map((e) => e.id)).toEqual([e3!.id]);
  });
});

describe('review-fix extras', () => {
  it('unclaims only events claimed by that run; lastRunWithOutput skips runs without output', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    const e = await store.addEvent({ prId: pr.id, kind: 'owner' });
    const r1 = await store.createRun({ prId: pr.id });
    await store.claimEvents([e!.id], r1.id);
    await store.unclaimEvents([e!.id], r1.id + 1);
    expect(await store.pendingEvents(pr.id)).toEqual([]);
    await store.unclaimEvents([e!.id], r1.id);
    expect((await store.pendingEvents(pr.id)).map((x) => x.id)).toEqual([e!.id]);

    await store.updateRun(r1.id, { status: 'ok', output: { handled: [], rebase: null, status_line: 'waiting', next: { action: 'wait', minutes: 5, reason: 'ci' } } });
    const r2 = await store.createRun({ prId: pr.id });
    await store.updateRun(r2.id, { status: 'interrupted' });
    expect((await store.lastRun(pr.id))!.id).toBe(r2.id);
    expect((await store.lastRunWithOutput(pr.id))!.id).toBe(r1.id);
  });
});

describe('runs', () => {
  it('creates, updates and queries', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    const r = await store.createRun({ prId: pr.id, sessionId: 's1' });
    expect(r).toMatchObject({ prId: pr.id, jobId: null, sessionId: 's1', status: 'running', output: null, appliedAt: null });
    const output = { handled: [], rebase: null, status_line: 'x', next: { action: 'escalate' as const, reason: 'r' } };
    const u = await store.updateRun(r.id, { status: 'ok', output, usage: { in: 1 }, turns: 3, endedAt: new Date() });
    expect(u).toMatchObject({ status: 'ok', output, usage: { in: 1 }, turns: 3 });
    expect((await store.unappliedRuns()).map((x) => x.id)).toEqual([r.id]);
    await store.updateRun(r.id, { appliedAt: new Date() });
    expect(await store.unappliedRuns()).toEqual([]);

    const r2 = await store.createRun({ jobId: 5 });
    expect(r2.prId).toBeNull();
    expect((await store.runsByStatus(['running'])).map((x) => x.id)).toEqual([r2.id]);
    expect((await store.lastRun(pr.id))?.id).toBe(r.id);
    expect(await store.lastRun(999)).toBeNull();
    expect((await store.runsSince(new Date(Date.now() - 60_000))).length).toBe(2);
    expect(await store.runsSince(new Date(Date.now() + 60_000))).toEqual([]);
  });
});

describe('review requests', () => {
  it('dedupes by (run, bot), tracks rounds and threads', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot', 'review-bot'], 4);
    const base = { prId: pr.id, runId: 1, kind: 'review' as const, round: 1, resend: false, channel: 'C1', requestTs: '100.1' };
    const a = await store.addReviewRequest({ ...base, bot: 'codex-bot' });
    expect(a).toMatchObject({ bot: 'codex-bot', acked: false, superseded: false, doneAt: null, lastActivityAt: null });
    expect(await store.addReviewRequest({ ...base, bot: 'codex-bot' })).toBeNull();
    const b = await store.addReviewRequest({ ...base, bot: 'review-bot', requestTs: '100.2' });
    await store.addReviewRequest({ ...base, runId: 2, bot: 'codex-bot', round: 2, requestTs: '200.1' });
    await store.addReviewRequest({ ...base, runId: 3, bot: 'review-bot', kind: 'approve', round: 0, requestTs: '300.1' });

    expect(await store.roundsByBot(pr.id)).toEqual({ 'codex-bot': 2, 'review-bot': 1 });
    expect((await store.requestsByThread('C1', '100.1')).map((r) => r.bot)).toEqual(['codex-bot']);

    const t = new Date('2026-09-23T10:00:00Z');
    await store.updateRequest(a!.id, { superseded: true });
    await store.updateRequest(b!.id, { acked: true, lastActivityAt: t, doneAt: t, reviewUrl: 'u', firstLine: 'f' });
    await store.updateRequest(b!.id, {});
    expect((await store.openRequests(pr.id)).map((r) => r.requestTs)).toEqual(['200.1', '300.1']);
    expect((await store.openRequests()).length).toBe(2);
    const all = await store.requestsForPr(pr.id);
    expect(all.length).toBe(4);
    expect(all[1]).toMatchObject({ acked: true, lastActivityAt: t, doneAt: t, reviewUrl: 'u', firstLine: 'f' });
  });
});

describe('timers', () => {
  it('adds, lists due, fires and cancels', async () => {
    const { pr } = await store.upsertPr(ref, ['codex-bot'], 4);
    const now = new Date('2026-09-23T10:00:00Z');
    const t1 = await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: new Date(now.getTime() - 1000), note: 'ci' });
    const t2 = await store.addTimer({ prId: pr.id, kind: 'ack_timeout', refId: 9, fireAt: now });
    await store.addTimer({ prId: pr.id, kind: 'ack_timeout', refId: 10, fireAt: new Date(now.getTime() + 1000) });
    expect(t1).toMatchObject({ kind: 'wait', note: 'ci', refId: null, firedAt: null });
    expect((await store.dueTimers(now)).map((t) => t.id)).toEqual([t1.id, t2.id]);

    await store.fireTimer(t1.id);
    expect((await store.dueTimers(now)).map((t) => t.id)).toEqual([t2.id]);

    await store.cancelTimers(pr.id, 'ack_timeout', 9);
    expect(await store.dueTimers(now)).toEqual([]);
    expect((await store.dueTimers(new Date(now.getTime() + 5000))).length).toBe(1);
    await store.cancelTimers(pr.id);
    expect(await store.dueTimers(new Date(now.getTime() + 5000))).toEqual([]);
  });
});

describe('jobs', () => {
  it('merges duplicates only while queued (a running job gets a follow-up)', async () => {
    const j = { kind: 'review' as const, repo: 'o/r', number: 1, requestedBy: 'U1', channel: 'C', threadTs: '1.1' };
    const a = await store.addJob(j);
    expect(a).toMatchObject({ ...j, status: 'queued', verdict: null });
    expect(await store.addJob(j)).toBeNull();
    const b = await store.addJob({ ...j, kind: 'approve' });
    expect(b).not.toBeNull();

    expect((await store.nextQueuedJob())?.id).toBe(a!.id);
    await store.updateJob(a!.id, { status: 'running' });
    expect((await store.nextQueuedJob())?.id).toBe(b!.id);
    const followUp = await store.addJob(j);
    expect(followUp).not.toBeNull();
    expect(await store.addJob(j)).toBeNull();
    await store.updateJob(a!.id, { status: 'done', verdict: 'approved', endedAt: new Date() });
    await store.updateJob(followUp!.id, { status: 'done', verdict: 'approved', endedAt: new Date() });
    expect(await store.addJob(j)).not.toBeNull();

    const since = await store.jobsSince(new Date(Date.now() - 60_000));
    expect(since.length).toBe(4);
    expect(since[0]).toMatchObject({ status: 'done', verdict: 'approved' });
  });
});

describe('workspaces', () => {
  it('upserts, lists live and marks cleaned', async () => {
    const w = await store.upsertWorkspace({ ...ref, kind: 'shepherd', path: '/data/worktrees/cli-7' });
    expect(w).toMatchObject({ ...ref, kind: 'shepherd', path: '/data/worktrees/cli-7', cleanedAt: null });
    await store.markWorkspaceCleaned(w.id);
    expect(await store.liveWorkspaces()).toEqual([]);
    const again = await store.upsertWorkspace({ ...ref, kind: 'shepherd', path: '/data/worktrees/cli-7' });
    expect(again.id).toBe(w.id);
    expect(again.cleanedAt).toBeNull();
    expect((await store.liveWorkspaces()).length).toBe(1);
  });
});

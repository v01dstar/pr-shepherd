import { migrationSql } from './migrations.js';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createActuator } from '../src/actuator.js';
import { createInbox } from '../src/inbox.js';
import { stripHandoff } from '../src/github.js';
import { loadConfig } from '../src/config.js';
import type { Db, GithubPort, Pr, PrMeta, Repos, Run, SlackPort } from '../src/contracts.js';
import type { Next, ShepherdOutput } from '../src/output.js';
import { createStore } from '../src/store.js';

const migration = migrationSql;
// The example config plus two {mentions} bots, to exercise merged requests.
const example = loadConfig('config.example.yaml');
const config = {
  ...example,
  reviewers: [
    ...example.reviewers,
    { name: 'summary-bot-a', slack: 'USUMMARYA', request: '{mentions} please review: {url}\n{summary}', rerequest: '{mentions} pushed fixes, please re-review: {url}\n{summary}' },
    { name: 'summary-bot-b', slack: 'USUMMARYB', request: '{mentions} please review: {url}\n{summary}', rerequest: '{mentions} pushed fixes, please re-review: {url}\n{summary}' },
  ],
  approvers: example.approvers.slice(0, 1),
};
const ref = { repo: 'your-org/example-cli', number: 271 };
const URL = 'https://github.com/your-org/example-cli/pull/271';

let store: ReturnType<typeof createStore>;
let clock: Date;
let posts: { channel: string; text: string; threadTs?: string; ts: string }[];
let dms: string[];
let comments: string[];
let merges: { sha: string; subject: string; body: string }[];
let mergeResult: { ok: true } | { ok: false; error: string };
let meta: PrMeta;
let cleaned: string[];
let actuator: ReturnType<typeof createActuator>;

const slack: SlackPort = {
  async post(channel, text, threadTs) {
    const ts = `${1000 + posts.length}.0`;
    posts.push({ channel, text, threadTs, ts });
    return { ts, permalink: `https://slack/${ts}` };
  },
  async react() {},
  async dm(user, text) {
    expect(user).toBe(config.owner.slack);
    dms.push(text);
  },
  async replies() {
    return [];
  },
  async channelId(name) {
    return `C-${name}`;
  },
};
const github = {
  async prMeta() {
    return meta;
  },
  async merge(_ref: unknown, sha: string, subject: string, body: string) {
    merges.push({ sha, subject, body });
    return mergeResult;
  },
  async comment(_ref: unknown, body: string) {
    comments.push(body);
  },
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

beforeEach(async () => {
  const pg = new PGlite();
  await pg.exec(migration);
  const db: Db = { query: async (t, p) => (await pg.query(t, p)) as never };
  store = createStore(db);
  clock = new Date(); // sent_at/created_at default to the DB's now(), so the fake clock starts at real time
  posts = [];
  dms = [];
  comments = [];
  merges = [];
  cleaned = [];
  mergeResult = { ok: true };
  meta = { ...ref, state: 'OPEN', author: 'owner-login', isDraft: false, title: 'feat', body: 'Body\n<!-- pr-shepherd:handoff v1\nagent: x\n-->\n### Handoff\n**Intent**: y\n<!-- /pr-shepherd:handoff -->\n', headRef: 'f', headSha: 'abc1234', authorIsOrgMember: true };
  actuator = createActuator({ config, store, slack, github, repos, now: () => clock });
});

const advance = (min: number) => (clock = new Date(clock.getTime() + min * 60_000));

async function newPr(reviewers = ['review-bot', 'codex-bot', 'summary-bot-a', 'summary-bot-b']): Promise<Pr> {
  return (await store.upsertPr(ref, reviewers, 4)).pr;
}

function out(next: Next, handled: ShepherdOutput['handled'] = []): ShepherdOutput {
  return { handled, rebase: null, status_line: 'x', next };
}

async function runWith(pr: Pr, next: Next, handled?: ShepherdOutput['handled']): Promise<Run> {
  const r = await store.createRun({ prId: pr.id });
  return store.updateRun(r.id, { status: 'ok', output: out(next, handled) });
}

const review = (reviewers: string[], resend = false): Next => ({ action: 'request_review', reviewers, summary: 'fixed the thing', resend });

async function fresh(run: Run) {
  return (await store.runsByStatus(['ok', 'bad_output'])).find((r) => r.id === run.id)!;
}

describe('request_review', () => {
  it('posts per-bot messages, groups {mentions} bots into one, records requests and ack timers', async () => {
    const pr = await newPr();
    const run = await runWith(pr, review(['review-bot', 'summary-bot-a', 'summary-bot-b']));
    await actuator.apply(run);

    expect(comments).toHaveLength(1); // review-bot's template lacks {summary}
    expect(comments[0]).toContain('fixed the thing');
    expect(comments[0]).toMatch(/^\*\*pr-shepherd · r1 summary\*\*\n/); // header uses config.bot.name
    expect(posts.map((p) => p.text)).toEqual([
      `<@UREVIEWBOT> review ${URL}`,
      `<@USUMMARYA> <@USUMMARYB> please review: ${URL}\nfixed the thing`,
    ]);
    expect(posts.every((p) => p.channel === 'C-pr-review' && !p.threadTs)).toBe(true);

    const open = await store.openRequests(pr.id);
    expect(open.map((r) => [r.bot, r.round, r.requestTs])).toEqual([
      ['review-bot', 1, '1000.0'],
      ['summary-bot-a', 1, '1001.0'],
      ['summary-bot-b', 1, '1001.0'],
    ]);
    const timers = await store.dueTimers(new Date(clock.getTime() + 15 * 60_000));
    expect(timers.map((t) => [t.kind, t.refId])).toEqual(open.map((r) => ['ack_timeout', r.id]));
    expect(await store.dueTimers(new Date(clock.getTime() + 14 * 60_000))).toEqual([]);
    expect((await fresh(run)).appliedAt).toEqual(clock);
  });

  it('skips the PR comment when every template carries {summary}', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['summary-bot-a'])));
    expect(comments).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it('is idempotent: re-apply of the same run, and a crashed partial apply, send nothing twice', async () => {
    const pr = await newPr();
    const run = await runWith(pr, review(['review-bot', 'codex-bot']));
    await actuator.apply(run);
    await actuator.apply(await fresh(run)); // appliedAt set → no-op
    await actuator.apply(run); // stale copy without appliedAt → deduped by (run_id, bot)
    expect(posts).toHaveLength(2);
    expect(comments).toHaveLength(1);
    expect((await store.openRequests(pr.id)).length).toBe(2);
  });

  it('uses rerequest templates from round 2 and counts rounds', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['summary-bot-a'])));
    const [first] = await store.openRequests(pr.id);
    await store.updateRequest(first!.id, { doneAt: clock });
    await actuator.apply(await runWith(pr, review(['summary-bot-a'])));
    expect(posts[1]!.text).toBe(`<@USUMMARYA> pushed fixes, please re-review: ${URL}\nfixed the thing`);
    expect(await store.roundsByBot(pr.id)).toEqual({ 'summary-bot-a': 2 });
  });

  it('rejects reviewers outside the PR set with a continue event', async () => {
    const pr = await newPr(['codex-bot']);
    const run = await runWith(pr, review(['review-bot']));
    await actuator.apply(run);
    expect(posts).toEqual([]);
    const ev = await store.pendingEvents(pr.id);
    expect(ev.map((e) => e.kind)).toEqual(['continue']);
    expect(String(ev[0]!.payload.rejected)).toContain('review-bot');
    const r = await fresh(run);
    expect(r.status).toBe('bad_output');
    expect(r.appliedAt).not.toBeNull();
    expect((await store.getPr(pr.id))!.status).toBe('active');
  });

  it('two rejected runs in a row → needs_human bad_output', async () => {
    const pr = await newPr(['codex-bot']);
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const p = (await store.getPr(pr.id))!;
    expect(p).toMatchObject({ status: 'needs_human', reason: 'bad_output' });
    expect(dms.at(-1)).toContain('bad_output');
    expect((await store.pendingEvents(pr.id)).length).toBe(1);
  });

  it('a good run between rejections resets the streak', async () => {
    const pr = await newPr(['codex-bot']);
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    await actuator.apply(await runWith(pr, { action: 'wait', minutes: 5, reason: 'ci' }));
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    expect((await store.getPr(pr.id))!.status).toBe('active');
  });

  it('skips a bot whose open request is still live, re-requests once stalled', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    expect(posts).toHaveLength(1);
    advance(16); // past ackTimeoutMin without ack → stalled
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    expect(posts).toHaveLength(2);
    const open = await store.openRequests(pr.id);
    expect(open.map((r) => r.round)).toEqual([2]); // old one superseded
  });

  it('enforces max_rounds → needs_human and DMs the owner', async () => {
    const pr = await newPr(['codex-bot']);
    await store.updatePr(pr.id, { maxRounds: 1 });
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    const [r1] = await store.openRequests(pr.id);
    await store.updateRequest(r1!.id, { doneAt: clock });
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    expect(posts).toHaveLength(1);
    expect((await store.getPr(pr.id))!).toMatchObject({ status: 'needs_human', reason: 'max_rounds' });
    expect(dms.at(-1)).toContain('max_rounds');
  });

  it('resend keeps the round and supersedes the previous open request', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const [old] = await store.openRequests(pr.id);
    advance(20);
    await actuator.apply(await runWith(pr, review(['review-bot'], true)));
    const all = await store.requestsForPr(pr.id);
    expect(all.map((r) => [r.id === old!.id, r.round, r.resend, r.superseded])).toEqual([
      [true, 1, false, true],
      [false, 1, true, false],
    ]);
    // old request's ack timer cancelled, new one armed
    const timers = await store.dueTimers(new Date(clock.getTime() + 60 * 60_000));
    expect(timers.map((t) => t.refId)).toEqual([all[1]!.id]);
    expect(posts[1]!.text).toBe(`<@UREVIEWBOT> review ${URL}`);
  });

  it('posts the handled summary line into the latest request thread', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['codex-bot'])));
    const handled = [{
      reviewer: 'codex-bot', review_url: 'u',
      items: [
        { url: 'a', severity: 'Critical' as const, action: 'fix' as const, commit: 'def5678abc', note: '' },
        { url: 'b', severity: 'Suggestion' as const, action: 'reply' as const, commit: null, note: '' },
        { url: 'c', severity: 'Suggestion' as const, action: 'escalate' as const, commit: null, note: 'conflict' },
      ],
    }];
    await actuator.apply(await runWith(pr, { action: 'wait', minutes: 10, reason: 'ci' }, handled));
    expect(posts.at(-1)).toMatchObject({ threadTs: '1000.0', text: 'r1 @def5678: fix 1 · reply 1 · escalate 1' });
  });
});

describe('request_approve', () => {
  it('requests the approver, at most twice per head', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts.at(-1)!.text).toBe(`<@UREVIEWBOT> approve ${URL}`);
    let open = await store.openRequests(pr.id);
    expect(open.map((r) => [r.kind, r.round])).toEqual([['approve', 0]]);
    await store.updateRequest(open[0]!.id, { doneAt: clock });

    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts).toHaveLength(2);
    open = await store.openRequests(pr.id);
    await store.updateRequest(open[0]!.id, { doneAt: clock });

    const third = await runWith(pr, { action: 'request_approve' });
    await actuator.apply(third);
    expect(posts).toHaveLength(2);
    expect((await store.pendingEvents(pr.id)).map((e) => e.kind)).toEqual(['continue']);

    // the cap is per head SHA: a rebase (new head) without a new review round may request again
    meta = { ...meta, headSha: 'def5678' };
    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts.at(-1)!.text).toContain('approve');
    expect(posts).toHaveLength(3);
    const reqs = await store.requestsForPr(pr.id);
    expect(reqs.map((r) => r.headSha)).toEqual(['abc1234', 'abc1234', 'def5678']);
  });

  it('does not re-request while an approve request is live', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts).toHaveLength(1);
    // not silently OK: the agent is told why nothing was sent
    const ev = await store.pendingEvents(pr.id);
    expect(ev.map((e) => e.kind)).toEqual(['continue']);
    expect(String(ev[0]!.payload.rejected)).toMatch(/still open/);
  });
});

describe('request_approve with several approvers', () => {
  const two = {
    ...config,
    approvers: [
      { name: 'review-bot', slack: 'UREVIEWBOT', request: '<@{slack}> approve {url}' },
      { name: 'lead-a', slack: 'ULEADA', request: '{mentions} please approve {url}' },
      { name: 'lead-b', slack: 'ULEADB', request: '{mentions} please approve {url}' },
    ],
  };

  it('asks every approver by default, merging {mentions} templates into one message', async () => {
    actuator = createActuator({ config: two, store, slack, github, repos, now: () => clock });
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts.map((p) => p.text).sort()).toEqual([`<@ULEADA> <@ULEADB> please approve ${URL}`, `<@UREVIEWBOT> approve ${URL}`]);
    expect((await store.openRequests(pr.id)).map((r) => r.bot).sort()).toEqual(['lead-a', 'lead-b', 'review-bot']);
  });

  it('asks only the named subset, skips a live one, and rejects unknown names', async () => {
    actuator = createActuator({ config: two, store, slack, github, repos, now: () => clock });
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'request_approve', approvers: ['lead-b'] }));
    expect(posts.map((p) => p.text)).toEqual([`<@ULEADB> please approve ${URL}`]);

    await actuator.apply(await runWith(pr, { action: 'request_approve' }));
    expect(posts).toHaveLength(3); // review-bot + lead-a; lead-b is still live
    expect((await store.openRequests(pr.id)).filter((r) => r.bot === 'lead-b')).toHaveLength(1);

    await actuator.apply(await runWith(pr, { action: 'request_approve', approvers: ['nobody'] }));
    expect(posts).toHaveLength(3);
    const ev = await store.pendingEvents(pr.id);
    expect(String(ev.at(-1)!.payload.rejected)).toMatch(/unknown approvers: nobody/);
  });
});

describe('merge', () => {
  it('auto_merge on: squash-merges with the handoff stripped, goes terminal and cleans up', async () => {
    const pr = await newPr();
    await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: clock });
    await actuator.apply(await runWith(pr, { action: 'merge', sha: 'abc1234', title: 'feat: x' }));
    expect(merges).toEqual([{ sha: 'abc1234', subject: 'feat: x (#271)', body: 'Body' }]);
    const p = (await store.getPr(pr.id))!;
    expect(p.status).toBe('merged');
    expect(p.closedAt).toEqual(clock);
    expect(cleaned).toEqual(['shepherd:your-org/example-cli#271']);
    expect(await store.dueTimers(clock)).toEqual([]);
    expect(dms.at(-1)).toContain('merged');
  });

  it('merge failure → merge_failed event', async () => {
    const pr = await newPr();
    mergeResult = { ok: false, error: 'head changed' };
    const run = await runWith(pr, { action: 'merge', sha: 'abc1234', title: 't' });
    await actuator.apply(run);
    const ev = await store.pendingEvents(pr.id);
    expect(ev.map((e) => [e.kind, e.payload.error])).toEqual([['merge_failed', 'head changed']]);
    expect((await store.getPr(pr.id))!.status).toBe('active');
  });

  it('auto_merge off: stores pendingMerge and asks the owner', async () => {
    const pr = await newPr();
    await store.updatePr(pr.id, { autoMerge: false });
    await actuator.apply(await runWith(pr, { action: 'merge', sha: 'abc1234', title: 't' }));
    expect(merges).toEqual([]);
    expect((await store.getPr(pr.id))!.pendingMerge).toEqual({ sha: 'abc1234', title: 't' });
    expect(dms.at(-1)).toContain('merge your-org/example-cli#271');
  });

  it('paused PRs never auto-merge', async () => {
    const pr = await newPr();
    await store.updatePr(pr.id, { status: 'paused' });
    await actuator.apply(await runWith(pr, { action: 'merge', sha: 'abc1234', title: 't' }));
    expect(merges).toEqual([]);
  });

  it('stripHandoff removes only the handoff block', () => {
    expect(stripHandoff('a\n<!-- pr-shepherd:handoff v1\nx\n-->\nz\n<!-- /pr-shepherd:handoff -->\nb')).toBe('a\nb');
    expect(stripHandoff('plain')).toBe('plain');
  });
});

describe('wait / escalate / done', () => {
  it('wait arms a single wait timer', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'wait', minutes: 10, reason: 'ci' }));
    await actuator.apply(await runWith(pr, { action: 'wait', minutes: 20, reason: 'ci2' }));
    const t = await store.dueTimers(new Date(clock.getTime() + 60 * 60_000));
    expect(t.map((x) => [x.kind, x.note, x.fireAt.getTime() - clock.getTime()])).toEqual([['wait', 'ci2', 20 * 60_000]]);
  });

  it('wait over 60 minutes is rejected', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, { action: 'wait', minutes: 90, reason: 'x' }));
    expect(await store.dueTimers(new Date(clock.getTime() + 999 * 60_000))).toEqual([]);
    expect((await store.pendingEvents(pr.id))[0]!.kind).toBe('continue');
  });

  it('escalate → needs_human with escalated items in the DM', async () => {
    const pr = await newPr();
    const handled = [{ reviewer: 'codex-bot', review_url: 'u', items: [{ url: 'https://x/1', severity: 'Critical' as const, action: 'escalate' as const, commit: null, note: 'violates constraint' }] }];
    await actuator.apply(await runWith(pr, { action: 'escalate', reason: 'reviewers disagree' }, handled));
    expect((await store.getPr(pr.id))!).toMatchObject({ status: 'needs_human', reason: 'reviewers disagree' });
    expect(dms[0]).toContain('reviewers disagree');
    expect(dms[0]).toContain('violates constraint');
  });

  it('done on a closed PR → closed + cleanup; done on an open PR → escalate', async () => {
    const pr = await newPr();
    meta = { ...meta, state: 'CLOSED' };
    await actuator.apply(await runWith(pr, { action: 'done', reason: 'abandoned' }));
    expect((await store.getPr(pr.id))!.status).toBe('closed');
    expect(cleaned).toHaveLength(1);

    const other = (await store.upsertPr({ repo: 'your-org/example-cli', number: 9 }, ['codex-bot'], 4)).pr;
    meta = { ...meta, state: 'OPEN' };
    await actuator.apply(await runWith(other, { action: 'done', reason: 'nothing to do' }));
    expect((await store.getPr(other.id))!.status).toBe('needs_human');
  });

  it('runs for terminal PRs are just marked applied', async () => {
    const pr = await newPr();
    await store.updatePr(pr.id, { status: 'merged' });
    const run = await runWith(pr, review(['codex-bot']));
    await actuator.apply(run);
    expect(posts).toEqual([]);
    expect((await fresh(run)).appliedAt).not.toBeNull();
  });
});

describe('onTimer', () => {
  it('wait → timer event, deduped', async () => {
    const pr = await newPr();
    const t = await store.addTimer({ prId: pr.id, kind: 'wait', fireAt: clock, note: 'ci' });
    await actuator.onTimer(t);
    await actuator.onTimer(t);
    const ev = await store.pendingEvents(pr.id);
    expect(ev.map((e) => [e.kind, e.payload.reason, e.dedupeKey])).toEqual([['timer', 'ci', `timer:${t.id}`]]);
    expect(await store.dueTimers(clock)).toEqual([]);
  });

  it('ack_timeout without ack → reviewer_stalled no_ack', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    advance(15);
    const [t] = await store.dueTimers(clock);
    await actuator.onTimer(t!);
    const [ev] = await store.pendingEvents(pr.id);
    expect(ev).toMatchObject({ kind: 'reviewer_stalled', payload: { reviewer: 'review-bot', stage: 'no_ack', waited: '15m', resends: 0 } });
    expect(await store.dueTimers(clock)).toEqual([]);
  });

  it('ack_timeout after ack → arms reply_timeout; reply_timeout re-arms on fresh activity, then stalls', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const [req] = await store.openRequests(pr.id);
    advance(5);
    await store.updateRequest(req!.id, { acked: true, lastActivityAt: clock });
    advance(10);
    const [ack] = await store.dueTimers(clock);
    await actuator.onTimer(ack!);
    expect(await store.pendingEvents(pr.id)).toEqual([]);

    advance(110); // 120 min after last activity
    const [reply] = await store.dueTimers(clock);
    expect(reply).toMatchObject({ kind: 'reply_timeout', refId: req!.id });
    await store.updateRequest(req!.id, { lastActivityAt: new Date(clock.getTime() - 30 * 60_000) });
    await actuator.onTimer(reply!);
    expect(await store.pendingEvents(pr.id)).toEqual([]);
    expect(await store.dueTimers(clock)).toEqual([]);

    advance(90);
    const [reply2] = await store.dueTimers(clock);
    await actuator.onTimer(reply2!);
    const [ev] = await store.pendingEvents(pr.id);
    expect(ev).toMatchObject({ kind: 'reviewer_stalled', payload: { reviewer: 'review-bot', stage: 'no_reply', waited: '120m' } });
  });

  it('timeouts for finished requests only fire the timer', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const [req] = await store.openRequests(pr.id);
    await store.updateRequest(req!.id, { doneAt: clock });
    advance(15);
    const [t] = await store.dueTimers(clock);
    await actuator.onTimer(t!);
    expect(await store.pendingEvents(pr.id)).toEqual([]);
    expect(await store.dueTimers(clock)).toEqual([]);
  });
});

describe('policyLine', () => {
  it('formats policy and budget', async () => {
    const pr = await newPr(['review-bot', 'codex-bot']);
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const p = await store.updatePr(pr.id, { runCount: 7 });
    expect(await actuator.policyLine(p)).toBe('[policy] auto_merge=on rounds review-bot=1/4 codex-bot=0/4 runs=7/30');
    const off = await store.updatePr(pr.id, { autoMerge: false });
    expect(await actuator.policyLine(off)).toContain('auto_merge=off');
  });
});

describe('review-fix regressions', () => {
  it('a reviewer_error closes the request, so an immediate resend goes out', async () => {
    const pr = await newPr();
    await actuator.apply(await runWith(pr, review(['review-bot'])));
    const [req] = await store.openRequests(pr.id);
    const inbox = createInbox({ config, store, scheduler: { poke() {} }, now: () => clock });
    advance(2);
    await inbox.onThreadReply({ channel: req!.channel, ts: '2000.0', threadTs: req!.requestTs, user: 'UREVIEWBOT', text: ':x: failed to clone' });
    expect(await store.dueTimers(new Date(clock.getTime() + 999 * 60_000))).toEqual([]); // its timers are gone
    await actuator.apply(await runWith(pr, review(['review-bot'], true)));
    expect(posts).toHaveLength(2);
    const all = await store.requestsForPr(pr.id);
    expect(all.map((r) => [r.round, r.resend, r.superseded])).toEqual([[1, false, true], [1, true, false]]);
  });

  it('a failed Slack post is finished on re-apply without re-posting the PR summary comment', async () => {
    const pr = await newPr();
    const run = await runWith(pr, review(['review-bot', 'codex-bot']));
    const realPost = slack.post;
    slack.post = async () => {
      throw new Error('ratelimited');
    };
    await expect(actuator.apply(run)).rejects.toThrow('ratelimited');
    slack.post = realPost;
    expect(comments).toHaveLength(1);
    expect((await store.openRequests(pr.id)).every((r) => r.requestTs.startsWith('pending:'))).toBe(true);
    await actuator.apply(run);
    expect(comments).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect((await store.openRequests(pr.id)).map((r) => r.requestTs)).toEqual(['1000.0', '1001.0']);
    // ack timers were armed with the rows, one per request
    const timers = await store.dueTimers(new Date(clock.getTime() + 15 * 60_000));
    expect(timers).toHaveLength(2);
  });

  it('releaseMerge: every release is its own attempt; a crash before merging keeps pendingMerge', async () => {
    const pr = await newPr();
    await store.updatePr(pr.id, { autoMerge: false, pendingMerge: { sha: 'abc1234', title: 't' } });
    mergeResult = { ok: false, error: 'checks pending' };
    expect(await actuator.releaseMerge((await store.getPr(pr.id))!)).toMatchObject({ ok: false });
    await store.updatePr(pr.id, { pendingMerge: { sha: 'abc1234', title: 't' } });
    advance(1);
    expect(await actuator.releaseMerge((await store.getPr(pr.id))!)).toMatchObject({ ok: false });
    expect((await store.pendingEvents(pr.id)).map((e) => e.kind)).toEqual(['merge_failed', 'merge_failed']);

    await store.updatePr(pr.id, { pendingMerge: { sha: 'abc1234', title: 't' } });
    const realMeta = github.prMeta;
    github.prMeta = async () => {
      throw new Error('graphql timeout');
    };
    const r = await actuator.releaseMerge((await store.getPr(pr.id))!);
    github.prMeta = realMeta;
    expect(r).toMatchObject({ ok: false });
    expect((await store.getPr(pr.id))!.pendingMerge).toEqual({ sha: 'abc1234', title: 't' });
  });

  it('releaseMerge with a live run leaves the worktree to the janitor', async () => {
    const pr = await newPr();
    await store.updatePr(pr.id, { autoMerge: false, pendingMerge: { sha: 'abc1234', title: 't' } });
    expect(await actuator.releaseMerge((await store.getPr(pr.id))!, { skipCleanup: true })).toEqual({ ok: true });
    expect((await store.getPr(pr.id))!.status).toBe('merged');
    expect(cleaned).toEqual([]);
  });
});

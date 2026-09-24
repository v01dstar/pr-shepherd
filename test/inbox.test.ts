import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { EventKind, InboxEvent, ReviewRequest, SlackMessage, Store, Timer, TimerKind } from '../src/contracts.js';
import { classifyReply, createInbox } from '../src/inbox.js';

type Case = { bot: string; expect: string; text: string; link?: string };
const fx = JSON.parse(readFileSync('test/fixtures/slack/verdicts.json', 'utf8')) as { cases: Case[]; approve: Case[] };

describe('classifyReply — reviewer-bot message formats (synthetic content)', () => {
  for (const c of [...fx.cases, ...fx.approve]) {
    it(`${c.bot}: ${c.text.split('\n')[0]!.slice(0, 60)}`, () => {
      const r = classifyReply(c.text);
      expect(r.kind).toBe(c.expect);
      if (c.link) expect(r.reviewUrl).toBe(c.link);
    });
  }
});

// ---------- createInbox ----------

const config = {
  owner: { github: 'me', slack: 'UOWNER' },
  reviewers: [
    { name: 'review-bot', slack: 'UREVIEW', request: '', rerequest: '' },
    { name: 'codex-bot', slack: 'UCODEX', request: '', rerequest: '' },
    { name: 'summary-bot-a', slack: 'USUMA', request: '', rerequest: '' },
    { name: 'summary-bot-b', slack: 'USUMB', request: '', rerequest: '' },
  ],
  approvers: [{ name: 'review-bot', slack: 'UREVIEW', request: '' }, { name: 'second-approver', slack: 'USECOND', request: '' }],
  timing: { replyTimeoutMin: 120 },
} as unknown as Config;

const NOW = new Date('2026-09-23T10:00:00Z');
const LINK = 'https://github.com/your-org/example-cli/pull/7#pullrequestreview-99';

type NewEvent = { prId: number | null; kind: EventKind; payload?: Record<string, unknown>; dedupeKey?: string };
type NewTimer = { prId: number; kind: TimerKind; refId?: number | null; fireAt: Date };

function memInbox(reqs: Partial<ReviewRequest>[]) {
  const requests: ReviewRequest[] = reqs.map((r, i): ReviewRequest => ({
    id: i + 1, prId: 1, runId: 1, kind: 'review', bot: 'review-bot', round: 1, resend: false, channel: 'C', requestTs: '100.0',
    sentAt: NOW, lastActivityAt: null, acked: false, doneAt: null, reviewUrl: null, firstLine: null, superseded: false, headSha: null, ...r,
  }));
  const events: NewEvent[] = [];
  const timers: NewTimer[] = [];
  const cancelled: [number, TimerKind | undefined, number | undefined][] = [];
  const store = {
    async requestsByThread(channel: string, ts: string) {
      return requests.filter((r) => r.channel === channel && r.requestTs === ts);
    },
    async openRequests(prId?: number) {
      return requests.filter((r) => (prId === undefined || r.prId === prId) && !r.doneAt && !r.superseded);
    },
    async updateRequest(id: number, patch: Partial<ReviewRequest>) {
      Object.assign(requests.find((r) => r.id === id)!, patch);
    },
    async addEvent(e: NewEvent) {
      if (e.dedupeKey && events.some((x) => x.dedupeKey === e.dedupeKey)) return null;
      events.push(e);
      return { id: events.length } as InboxEvent;
    },
    async addTimer(t: NewTimer) {
      timers.push(t);
      return t as unknown as Timer;
    },
    async cancelTimers(prId: number, kind?: TimerKind, refId?: number) {
      cancelled.push([prId, kind, refId]);
    },
  };
  const pokes: number[] = [];
  const inbox = createInbox({ config, store: store as unknown as Store, scheduler: { poke: (id) => void pokes.push(id) }, now: () => NOW });
  return { inbox, requests, events, timers, cancelled, pokes };
}

const reply = (user: string, text: string, ts = '101.0', threadTs = '100.0'): SlackMessage => ({ channel: 'C', ts, threadTs, user, text });

describe('createInbox.onThreadReply', () => {
  it('owner reply → owner event (deduped by channel:ts) and poke', async () => {
    const t = memInbox([{}]);
    await t.inbox.onThreadReply(reply('UOWNER', 'skip the Suggestions'));
    await t.inbox.onThreadReply(reply('UOWNER', 'skip the Suggestions'));
    expect(t.events).toEqual([{ prId: 1, kind: 'owner', payload: { text: 'skip the Suggestions' }, dedupeKey: 'slack:C:101.0' }]);
    expect(t.pokes).toEqual([1]);
  });

  it('ignores top-level messages, unknown threads and other authors', async () => {
    const t = memInbox([{}]);
    await t.inbox.onThreadReply({ channel: 'C', ts: '100.0', user: 'UOWNER', text: 'hi' });
    await t.inbox.onThreadReply(reply('UOWNER', 'hi', '101.0', '999.0'));
    await t.inbox.onThreadReply(reply('USOMEONE', `looks good ${LINK}`));
    await t.inbox.onThreadReply(reply('UCODEX', `review: <${LINK}>`)); // codex-bot was not tagged in review-bot's thread
    expect(t.events).toEqual([]);
    expect(t.pokes).toEqual([]);
  });

  it('review link from the tagged bot → review_done, request closed, timers cancelled', async () => {
    const t = memInbox([{}]);
    await t.inbox.onThreadReply(reply('UREVIEW', `:octagonal_sign: review verdict: *request_changes*\nreview: <${LINK}>`));
    expect(t.requests[0]).toMatchObject({ doneAt: NOW, reviewUrl: LINK, firstLine: ':octagonal_sign: review verdict: *request_changes*' });
    expect(t.cancelled).toEqual([[1, 'ack_timeout', 1], [1, 'reply_timeout', 1]]);
    expect(t.events).toEqual([
      {
        prId: 1,
        kind: 'review_done',
        dedupeKey: 'slack:C:101.0',
        payload: { reviewer: 'review-bot', review: LINK, first_line: ':octagonal_sign: review verdict: *request_changes*', superseded: false },
      },
    ]);
    expect(t.pokes).toEqual([1]);

    await t.inbox.onThreadReply(reply('UREVIEW', `again ${LINK}`, '102.0'));
    expect(t.events).toHaveLength(1);
  });

  it('approve request → approve_done', async () => {
    const t = memInbox([{ kind: 'approve' }]);
    await t.inbox.onThreadReply(reply('UREVIEW', `:white_check_mark: approved as reviewer-account (<${LINK}>)`));
    expect(t.events[0]!.kind).toBe('approve_done');
  });

  it('any configured approver can answer an approve request; others are ignored', async () => {
    const t = memInbox([{ kind: 'approve', bot: 'review-bot' }, { kind: 'approve', bot: 'second-approver' }]);
    await t.inbox.onThreadReply(reply('UNOBODY', `approved (<${LINK}>)`, '101.0'));
    expect(t.events).toHaveLength(0);
    await t.inbox.onThreadReply(reply('USECOND', `:white_check_mark: approved (<${LINK}>)`, '102.0'));
    expect(t.events.map((e) => [e.kind, e.payload?.reviewer])).toEqual([['approve_done', 'second-approver']]);
    expect(t.requests[1]!.doneAt).toEqual(NOW);
  });

  it('matches the right bot in a merged {mentions} thread', async () => {
    const t = memInbox([{ bot: 'summary-bot-a' }, { bot: 'summary-bot-b' }]);
    await t.inbox.onThreadReply(reply('USUMB', `:x: Reviewed … changes requested\nFull review: <${LINK}>`));
    expect(t.requests[1]!.doneAt).toEqual(NOW);
    expect(t.requests[0]!.doneAt).toBeNull();
    expect(t.events[0]!.payload).toMatchObject({ reviewer: 'summary-bot-b' });
  });

  it(':x: without a link → reviewer_error', async () => {
    const t = memInbox([{ bot: 'codex-bot' }]);
    await t.inbox.onThreadReply(reply('UCODEX', ':x: review failed: clone timed out\ndetails'));
    expect(t.events).toEqual([
      { prId: 1, kind: 'reviewer_error', dedupeKey: 'slack:C:101.0', payload: { reviewer: 'codex-bot', first_line: ':x: review failed: clone timed out' } },
    ]);
    expect(t.pokes).toEqual([1]);
    // the request is over: marked errored (first line, no review link) and its timers are gone
    expect(t.requests[0]).toMatchObject({ doneAt: null, reviewUrl: null, firstLine: ':x: review failed: clone timed out', lastActivityAt: NOW });
    expect(t.cancelled).toEqual([[1, 'ack_timeout', 1], [1, 'reply_timeout', 1]]);
    // progress afterwards (the bot retried by itself) makes it live again
    await t.inbox.onThreadReply(reply('UCODEX', ':mag: retrying', '102.0'));
    expect(t.requests[0]!.firstLine).toBeNull();
  });

  it('writes the wake-up event before closing the request, so a crash in between replays', async () => {
    // addEvent fails (the crash point): the request must still be open for the restart backfill to replay it
    const reqs = memInbox([{}]).requests;
    const inbox = createInbox({
      config,
      store: {
        async requestsByThread() { return reqs; },
        async openRequests() { return reqs.filter((r) => !r.doneAt); },
        async updateRequest(id: number, patch: Partial<ReviewRequest>) { Object.assign(reqs.find((r) => r.id === id)!, patch); },
        async addEvent() { throw new Error('db down'); },
        async cancelTimers() {},
      } as unknown as Store,
      scheduler: { poke() {} },
      now: () => NOW,
    });
    await expect(inbox.onThreadReply(reply('UREVIEW', `review: <${LINK}>`))).rejects.toThrow('db down');
    expect(reqs[0]!.doneAt).toBeNull();
  });

  it('progress → ack; first ack swaps the ack timeout for a reply timeout, later progress pushes it out', async () => {
    const t = memInbox([{}]);
    await t.inbox.onThreadReply(reply('UREVIEW', ':mag: starting code review on <https://github.com/your-org/example-cli/pull/7> …'));
    expect(t.requests[0]).toMatchObject({ acked: true, lastActivityAt: NOW });
    expect(t.cancelled).toEqual([[1, 'ack_timeout', 1], [1, 'reply_timeout', 1]]);
    expect(t.timers).toEqual([{ prId: 1, kind: 'reply_timeout', refId: 1, fireAt: new Date(NOW.getTime() + 120 * 60_000) }]);
    expect(t.events).toEqual([]);
    expect(t.pokes).toEqual([]);

    await t.inbox.onThreadReply(reply('UREVIEW', 'still reading', '102.0'));
    expect(t.cancelled.slice(2)).toEqual([[1, 'reply_timeout', 1]]); // no second ack_timeout cancel
    expect(t.timers).toHaveLength(2);
  });

  it('superseded request: a late reply still counts while the resend is open, and closes the resend too', async () => {
    const t = memInbox([{ superseded: true }, { requestTs: '200.0', resend: true }]);
    await t.inbox.onThreadReply(reply('UREVIEW', `review: <${LINK}>`));
    expect(t.events[0]).toMatchObject({ kind: 'review_done', payload: { superseded: true } });
    expect(t.requests[1]!.doneAt).toEqual(NOW);

    // The resend's own reply arrives later: first wins, so nothing new.
    await t.inbox.onThreadReply(reply('UREVIEW', `review: <${LINK}>`, '201.0', '200.0'));
    expect(t.events).toHaveLength(1);
    expect(t.pokes).toEqual([1]);
  });

  it('superseded request: ignored once the resend already finished', async () => {
    const t = memInbox([{ superseded: true }, { requestTs: '200.0', resend: true }]);
    await t.inbox.onThreadReply(reply('UREVIEW', `review: <${LINK}>`, '201.0', '200.0'));
    await t.inbox.onThreadReply(reply('UREVIEW', `review: <${LINK}>`, '102.0', '100.0'));
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.payload).toMatchObject({ superseded: false });
    expect(t.requests[0]!.doneAt).toBeNull();
  });
});

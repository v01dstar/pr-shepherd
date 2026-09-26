// Inbox: events from HTTP / Slack / timers (DESIGN §5.1, §5.3). The wake-up event is written before the request's
// state changes, so a crash in between replays (dedupe keys) instead of losing the event.
import type { Config } from './config.js';
import type { ReviewRequest, Scheduler, SlackMessage, Store } from './contracts.js';
import { log } from './log.js';

export type ReplyKind = 'done' | 'error' | 'activity';

// Bot-agnostic reply classification (DESIGN §5.3): a GitHub review link means the bot finished;
// otherwise a leading :x: / :warning: is an error; anything else is progress (an ack).
const REVIEW_LINK = /https:\/\/github\.com\/[^\s|>]+\/pull\/\d+#pullrequestreview-\d+/;

export function classifyReply(text: string): { kind: ReplyKind; reviewUrl?: string; firstLine: string } {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const link = REVIEW_LINK.exec(text)?.[0];
  if (link) return { kind: 'done', reviewUrl: link, firstLine };
  if (/^:(x|warning):/.test(firstLine.trim())) return { kind: 'error', firstLine };
  return { kind: 'activity', firstLine };
}

// ---------- Slack thread replies → events (DESIGN §5.3) ----------

type InboxDeps = {
  config: Config;
  store: Store;
  scheduler: Pick<Scheduler, 'poke'>;
  now?: () => Date;
  ownerSlackId?: string;
  // An owner reply also takes the PR out of needs_human (DESIGN §5.6); index.ts passes that; default is poke.
  wakeByOwner?: (prId: number) => Promise<void>;
  // Acknowledges an owner reply in a PR's DM thread (index.ts: :eyes: reaction).
  ack?: (msg: SlackMessage) => Promise<void>;
};

export function createInbox(deps: InboxDeps): { onThreadReply(msg: SlackMessage): Promise<void> } {
  const { config, store, scheduler } = deps;
  const now = deps.now ?? (() => new Date());
  const owner = deps.ownerSlackId ?? config.owner.slack;

  const botSlackId = (r: ReviewRequest): string | undefined =>
    r.kind === 'approve'
      ? config.approvers.find((a) => a.name === r.bot)?.slack
      : config.reviewers.find((b) => b.name === r.bot)?.slack;

  async function onThreadReply(msg: SlackMessage): Promise<void> {
    if (!msg.threadTs || msg.threadTs === msg.ts) return;
    const dedupeKey = `slack:${msg.channel}:${msg.ts}`;
    const requests = await store.requestsByThread(msg.channel, msg.threadTs);
    if (!requests.length) {
      // The owner writing in a PR's DM thread (DESIGN §5.6).
      const pr = msg.user === owner ? await store.getPrByDmThread(msg.channel, msg.threadTs) : null;
      if (!pr || pr.status === 'merged' || pr.status === 'closed') return;
      const e = await store.addEvent({ prId: pr.id, kind: 'owner', payload: { text: msg.text }, dedupeKey });
      if (!e) return;
      await (deps.wakeByOwner ? deps.wakeByOwner(pr.id) : Promise.resolve(scheduler.poke(pr.id)));
      await deps.ack?.(msg).catch((err: unknown) => log.warn({ err }, 'ack failed'));
      return;
    }

    if (msg.user === owner) {
      // A thread belongs to one PR, even when {mentions} merged several bots into it.
      const prId = requests[0]!.prId;
      const e = await store.addEvent({ prId, kind: 'owner', payload: { text: msg.text }, dedupeKey });
      if (e) await (deps.wakeByOwner ? deps.wakeByOwner(prId) : Promise.resolve(scheduler.poke(prId)));
      return;
    }

    const author = [msg.user, msg.botId].filter((x): x is string => !!x);
    const req = requests.find((r) => {
      const id = botSlackId(r);
      return id !== undefined && author.includes(id);
    });
    if (!req) {
      if (msg.botId) log.info({ channel: msg.channel, ts: msg.ts, botId: msg.botId }, 'unrecognized bot reply in request thread');
      return;
    }

    const c = classifyReply(msg.text);
    const at = now();
    if (c.kind === 'done') return onDone(req, c.reviewUrl!, c.firstLine, dedupeKey, at);
    if (c.kind === 'error') {
      const e = await store.addEvent({
        prId: req.prId,
        kind: 'reviewer_error',
        payload: { reviewer: req.bot, first_line: c.firstLine },
        dedupeKey,
      });
      if (!req.doneAt) {
        // The request is over: firstLine without a review link marks it errored, so a resend is not blocked by it.
        await store.updateRequest(req.id, { lastActivityAt: at, firstLine: c.firstLine });
        await store.cancelTimers(req.prId, 'ack_timeout', req.id);
        await store.cancelTimers(req.prId, 'reply_timeout', req.id);
      }
      if (e) scheduler.poke(req.prId);
      return;
    }
    // Progress: the bot is alive. The reply timeout counts from the last activity (DESIGN §5.3).
    if (req.doneAt) return;
    const firstAck = !req.acked;
    // Progress after an error (the bot retried on its own) makes the request live again.
    await store.updateRequest(req.id, { acked: true, lastActivityAt: at, ...(req.firstLine != null ? { firstLine: null } : {}) });
    if (firstAck) await store.cancelTimers(req.prId, 'ack_timeout', req.id);
    await store.cancelTimers(req.prId, 'reply_timeout', req.id);
    await store.addTimer({
      prId: req.prId,
      kind: 'reply_timeout',
      refId: req.id,
      fireAt: new Date(at.getTime() + config.timing.replyTimeoutMin * 60_000),
    });
  }

  async function onDone(req: ReviewRequest, reviewUrl: string, firstLine: string, dedupeKey: string, at: Date) {
    if (req.doneAt) return;
    // A resend supersedes the old request, but whichever thread answers first wins (DESIGN §5.3).
    // Resends keep the round, so the live successor is an open request for the same bot/kind/round.
    const successors = (await store.openRequests(req.prId)).filter(
      (r) => r.id > req.id && r.bot === req.bot && r.kind === req.kind && r.round === req.round,
    );
    if (req.superseded && successors.length === 0) {
      log.info({ requestId: req.id, bot: req.bot }, 'late reply on superseded request ignored; a newer one already finished');
      return;
    }
    const e = await store.addEvent({
      prId: req.prId,
      kind: req.kind === 'approve' ? 'approve_done' : 'review_done',
      payload: { reviewer: req.bot, review: reviewUrl, first_line: firstLine, superseded: req.superseded },
      dedupeKey,
    });
    for (const r of [req, ...successors]) {
      await store.updateRequest(r.id, { doneAt: at, reviewUrl, firstLine, lastActivityAt: at });
      await store.cancelTimers(r.prId, 'ack_timeout', r.id);
      await store.cancelTimers(r.prId, 'reply_timeout', r.id);
    }
    if (e) scheduler.poke(req.prId);
  }

  return { onThreadReply };
}

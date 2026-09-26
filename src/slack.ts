// Slack adapter over Bolt Socket Mode (DESIGN §5.3 thread replies, §7.1 / §9 commands).
// Routing is a pure function (routeEvent) so it is testable without Bolt; the port is built over a
// minimal client interface so tests can pass a fake.
import { App } from '@slack/bolt';
import type { Command, SlackHandlers, SlackMessage, SlackPort } from './contracts.js';
import type { Config } from './config.js';
import { parseCommand } from './commands.js';
import { log } from './log.js';

// ---------- routing (pure) ----------

// The fields we read from Slack `message` / `app_mention` event payloads.
export type RawEvent = {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { id?: string; user_id?: string };
  text?: string;
  attachments?: { text?: string; fallback?: string; pretext?: string }[];
};

export type RouteCtx = { botUserId: string; botId?: string; reviewChannelId: string };

export type Route = { kind: 'thread_reply'; msg: SlackMessage } | { kind: 'command'; cmd: Command; msg: SlackMessage };

// Subtypes that carry a real new message; edits, deletes, joins etc. are ignored.
const MESSAGE_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share', 'me_message']);

export function normalize(ev: RawEvent): SlackMessage | null {
  if (!ev.channel || !ev.ts) return null;
  let text = ev.text ?? '';
  // Some bots post only attachments; their text is what a human would read.
  if (!text.trim() && ev.attachments?.length) {
    text = ev.attachments.map((a) => [a.pretext, a.text ?? a.fallback].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  }
  const msg: SlackMessage = { channel: ev.channel, ts: ev.ts, text };
  if (ev.thread_ts && ev.thread_ts !== ev.ts) msg.threadTs = ev.thread_ts;
  const user = ev.user ?? ev.bot_profile?.user_id;
  if (user) msg.user = user;
  const botId = ev.bot_id ?? ev.bot_profile?.id;
  if (botId) msg.botId = botId;
  return msg;
}

// Decides what a Slack event means. May return two routes (a mention inside a review thread is both
// a thread reply and a command). A command can arrive twice (message + app_mention); the caller dedupes.
export function routeEvent(ev: RawEvent, ctx: RouteCtx): Route[] {
  if (ev.type === 'message' && !MESSAGE_SUBTYPES.has(ev.subtype)) return [];
  const msg = normalize(ev);
  if (!msg) return [];
  if (msg.user === ctx.botUserId || (ctx.botId && msg.botId === ctx.botId)) return [];

  const routes: Route[] = [];
  const inReviewThread = msg.channel === ctx.reviewChannelId && !!msg.threadTs;
  if (ev.type === 'message' && inReviewThread) routes.push({ kind: 'thread_reply', msg });
  const isDm = ev.channel_type === 'im';
  const mentioned = new RegExp(`<@${ctx.botUserId}(?:\\|[^>]*)?>`).test(msg.text);
  // Channel messages mentioning us are commands too: Slack may not send app_mention for bot authors.
  if (ev.type === 'app_mention' || isDm || (ev.type === 'message' && mentioned)) {
    const cmd = parseCommand(msg.text, ctx.botUserId);
    // Free text in a DM thread is for that PR's agent (DESIGN §5.6); real commands stay commands.
    if (isDm && msg.threadTs && cmd.kind === 'unknown') return [{ kind: 'thread_reply', msg }];
    // Reviewer bots often @ the requester in their thread replies; that is a reply, not a command.
    if (!(inReviewThread && cmd.kind === 'unknown')) routes.push({ kind: 'command', cmd, msg });
  }
  return routes;
}

// ---------- port ----------

type ApiResult = { ok?: boolean; [k: string]: unknown };
// The Web API methods we use; Bolt's app.client satisfies it, tests pass a fake.
export type SlackApi = {
  chat: {
    postMessage(a: { channel: string; text: string; thread_ts?: string; reply_broadcast?: boolean; unfurl_links?: boolean; unfurl_media?: boolean }): Promise<ApiResult & { ts?: string; channel?: string }>;
    getPermalink(a: { channel: string; message_ts: string }): Promise<ApiResult & { permalink?: string }>;
    delete(a: { channel: string; ts: string }): Promise<ApiResult>;
  };
  reactions: { add(a: { channel: string; timestamp: string; name: string }): Promise<ApiResult> };
  conversations: {
    open(a: { users: string }): Promise<ApiResult & { channel?: { id?: string } }>;
    replies(a: { channel: string; ts: string; cursor?: string; limit?: number }): Promise<ApiResult & { messages?: RawEvent[]; response_metadata?: { next_cursor?: string } }>;
    list(a: { types: string; exclude_archived: boolean; limit: number; cursor?: string }): Promise<ApiResult & { channels?: { id?: string; name?: string }[]; response_metadata?: { next_cursor?: string } }>;
  };
  bots: { info(a: { bot: string }): Promise<ApiResult & { bot?: { user_id?: string } }> };
};

function slackError(e: unknown): string | undefined {
  return (e as { data?: { error?: string } })?.data?.error;
}

export function createSlackPort(api: SlackApi): SlackPort & { botUserIdOf(botId: string): Promise<string | undefined> } {
  const channels = new Map<string, string>();
  const botUsers = new Map<string, string | undefined>();

  async function post(channel: string, text: string, threadTs?: string, opts: { broadcast?: boolean } = {}) {
    const broadcast = threadTs && opts.broadcast ? { reply_broadcast: true } : {};
    const r = await api.chat.postMessage({ channel, text, thread_ts: threadTs, ...broadcast, unfurl_links: false, unfurl_media: false });
    if (!r.ts) throw new Error(`chat.postMessage returned no ts (channel ${channel})`);
    const link = await api.chat.getPermalink({ channel: r.channel ?? channel, message_ts: r.ts });
    return { ts: r.ts, permalink: link.permalink ?? '' };
  }

  return {
    post,

    async react(channel, ts, emoji) {
      try {
        await api.reactions.add({ channel, timestamp: ts, name: emoji.replace(/^:|:$/g, '') });
      } catch (e) {
        if (slackError(e) !== 'already_reacted') throw e;
      }
    },

    async dm(userId, text) {
      const r = await api.conversations.open({ users: userId });
      const id = r.channel?.id;
      if (!id) throw new Error(`conversations.open returned no channel for ${userId}`);
      const { ts } = await post(id, text);
      return { channel: id, ts };
    },

    async delete(channel, ts) {
      await api.chat.delete({ channel, ts });
    },

    async replies(channel, threadTs) {
      const out: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await api.conversations.replies({ channel, ts: threadTs, cursor, limit: 200 });
        for (const m of r.messages ?? []) {
          if (m.ts === threadTs) continue; // the parent
          const msg = normalize({ ...m, channel, thread_ts: m.thread_ts ?? threadTs });
          if (msg) out.push(msg);
        }
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    async channelId(name) {
      const key = name.replace(/^#/, '');
      const hit = channels.get(key);
      if (hit) return hit;
      let cursor: string | undefined;
      do {
        const r = await api.conversations.list({ types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
        for (const c of r.channels ?? []) if (c.id && c.name) channels.set(c.name, c.id);
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      const id = channels.get(key);
      if (id) return id;
      if (/^[CGD][A-Z0-9]{6,}$/.test(key)) return key; // already an id
      throw new Error(`Slack channel not found: #${key}`);
    },

    // Bot messages usually carry `user`; when they only carry bot_id, resolve it once via bots.info.
    async botUserIdOf(botId) {
      if (botUsers.has(botId)) return botUsers.get(botId);
      let uid: string | undefined;
      try {
        uid = (await api.bots.info({ bot: botId })).bot?.user_id;
      } catch (e) {
        log.warn({ err: e, botId }, 'bots.info failed');
      }
      botUsers.set(botId, uid);
      return uid;
    },
  };
}

// ---------- app ----------

export async function createSlack(opts: {
  config: Config;
  botToken: string;
  appToken: string;
  handlers: SlackHandlers;
}): Promise<SlackPort & { start(): Promise<void>; stop(): Promise<void>; botUserId: string }> {
  const app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true });
  const auth = await app.client.auth.test();
  if (!auth.user_id) throw new Error('Slack auth.test returned no user_id');
  const botUserId = auth.user_id;
  const port = createSlackPort(app.client as unknown as SlackApi);
  let ctx: RouteCtx | null = null;

  // The same mention arrives as both `message` and `app_mention`; handle each command once.
  const seen = new Set<string>();
  const firstTime = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 2000) seen.delete(seen.values().next().value!);
    return true;
  };

  async function dispatch(ev: RawEvent) {
    if (!ctx) return;
    for (const r of routeEvent(ev, ctx)) {
      try {
        if (!r.msg.user && r.msg.botId) {
          const uid = await port.botUserIdOf(r.msg.botId);
          if (uid) r.msg.user = uid;
        }
        if (r.kind === 'thread_reply') await opts.handlers.onThreadReply(r.msg);
        else if (firstTime(`${r.msg.channel}:${r.msg.ts}`)) await opts.handlers.onCommand(r.cmd, r.msg);
      } catch (err) {
        log.error({ err, route: r.kind, channel: r.msg.channel, ts: r.msg.ts }, 'slack handler failed');
      }
    }
  }

  app.event('message', async ({ event }) => dispatch(event as unknown as RawEvent));
  app.event('app_mention', async ({ event }) => dispatch({ ...(event as unknown as RawEvent), type: 'app_mention' }));
  app.error(async (err) => {
    log.error({ err }, 'bolt error');
  });

  return {
    ...port,
    botUserId,
    async start() {
      const reviewChannelId = await port.channelId(opts.config.reviewChannel);
      ctx = { botUserId, botId: auth.bot_id, reviewChannelId };
      await app.start();
      log.info({ botUserId, reviewChannelId }, 'slack connected');
    },
    async stop() {
      await app.stop();
    },
  };
}

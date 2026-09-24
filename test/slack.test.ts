import { describe, expect, it, vi } from 'vitest';
import { createSlackPort, routeEvent, type RawEvent, type SlackApi } from '../src/slack.js';

const ctx = { botUserId: 'UBOT', botId: 'BBOT', reviewChannelId: 'CREVIEW' };
const PARENT = '1758600000.000100';

describe('routeEvent', () => {
  it('bot reply in a review thread (user present) → thread_reply', () => {
    const ev: RawEvent = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'CREVIEW',
      channel_type: 'channel',
      ts: '1758600100.000200',
      thread_ts: PARENT,
      user: 'UREVIEWBOT',
      bot_id: 'B0REVIEW',
      bot_profile: { id: 'B0REVIEW' },
      text: ':mag: starting code review on <https://github.com/your-org/example-api/pull/528> …',
    };
    expect(routeEvent(ev, ctx)).toEqual([
      {
        kind: 'thread_reply',
        msg: { channel: 'CREVIEW', ts: '1758600100.000200', threadTs: PARENT, user: 'UREVIEWBOT', botId: 'B0REVIEW', text: ev.text },
      },
    ]);
  });

  it('bot reply without user keeps botId (resolved later) and uses attachment text when text is empty', () => {
    const [r] = routeEvent(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'CREVIEW',
        ts: '1758600100.000300',
        thread_ts: PARENT,
        bot_id: 'B0CODEX',
        text: '',
        attachments: [{ fallback: ':microscope: analyzing with Codex…' }],
      },
      ctx,
    );
    expect(r).toEqual({
      kind: 'thread_reply',
      msg: { channel: 'CREVIEW', ts: '1758600100.000300', threadTs: PARENT, botId: 'B0CODEX', text: ':microscope: analyzing with Codex…' },
    });
  });

  it('human reply in a review thread → thread_reply', () => {
    const routes = routeEvent(
      { type: 'message', channel: 'CREVIEW', ts: '2.0', thread_ts: PARENT, user: 'UOWNER', text: 'skip the flaky test' },
      ctx,
    );
    expect(routes.map((r) => r.kind)).toEqual(['thread_reply']);
  });

  it('top-level channel messages and other channels are ignored', () => {
    expect(routeEvent({ type: 'message', channel: 'CREVIEW', ts: PARENT, user: 'U1', text: 'hi' }, ctx)).toEqual([]);
    expect(routeEvent({ type: 'message', channel: 'CREVIEW', ts: PARENT, thread_ts: PARENT, user: 'U1', text: 'parent' }, ctx)).toEqual([]);
    expect(routeEvent({ type: 'message', channel: 'COTHER', ts: '2.0', thread_ts: PARENT, user: 'U1', text: 'hi' }, ctx)).toEqual([]);
  });

  it('edits, deletes and joins are ignored', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
      expect(routeEvent({ type: 'message', subtype, channel: 'CREVIEW', ts: '2.0', thread_ts: PARENT, user: 'U1', text: 'x' }, ctx)).toEqual([]);
    }
  });

  it('own messages are ignored (by user id or bot id)', () => {
    const base = { type: 'message', channel: 'CREVIEW', ts: '2.0', thread_ts: PARENT, text: '<@UREVIEWBOT> review x' };
    expect(routeEvent({ ...base, user: 'UBOT', bot_id: 'BBOT' }, ctx)).toEqual([]);
    expect(routeEvent({ ...base, subtype: 'bot_message', bot_id: 'BBOT' }, ctx)).toEqual([]);
    expect(routeEvent({ ...base, type: 'app_mention', user: 'UBOT', text: '<@UBOT> help' }, ctx)).toEqual([]);
  });

  it('app_mention at top level → command', () => {
    const routes = routeEvent(
      {
        type: 'app_mention',
        channel: 'CREVIEW',
        ts: '3.0',
        user: 'UOTHER',
        text: '<@UOTHER> <@UBOT> please review: <https://github.com/your-org/example-cli/pull/288>\nsigned out it refuses.',
      },
      ctx,
    );
    expect(routes).toEqual([
      {
        kind: 'command',
        cmd: { kind: 'g3_review', pr: { repo: 'your-org/example-cli', number: 288 }, context: 'signed out it refuses.' },
        msg: expect.objectContaining({ channel: 'CREVIEW', ts: '3.0', user: 'UOTHER' }),
      },
    ]);
  });

  it('bot-authored channel message mentioning us → command (Slack may skip app_mention for bots)', () => {
    const routes = routeEvent(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'CANY',
        ts: '4.0',
        bot_id: 'BREVIEW',
        user: 'UREVIEWBOT',
        text: '<@UBOT> please approve <https://github.com/your-org/example-app/pull/168> - workflow approved',
      },
      ctx,
    );
    expect(routes).toEqual([
      {
        kind: 'command',
        cmd: { kind: 'g3_approve', pr: { repo: 'your-org/example-app', number: 168 }, context: 'workflow approved' },
        msg: expect.objectContaining({ ts: '4.0', user: 'UREVIEWBOT', botId: 'BREVIEW' }),
      },
    ]);
  });

  it('mention inside a review thread is both a reply and a command', () => {
    const routes = routeEvent(
      { type: 'message', channel: 'CREVIEW', ts: '5.0', thread_ts: PARENT, user: 'UOWNER', text: '<@UBOT> status' },
      ctx,
    );
    expect(routes.map((r) => r.kind)).toEqual(['thread_reply', 'command']);
    expect(routes[1]).toMatchObject({ cmd: { kind: 'status' }, msg: { threadTs: PARENT } });
  });

  it('reviewer bot @-ing us in its thread reply is only a reply, not an unknown command', () => {
    const text = '<@UBOT> :white_check_mark: review verdict: *approved*\nreview: <https://github.com/o/r/pull/1#pullrequestreview-9>';
    expect(routeEvent({ type: 'message', subtype: 'bot_message', channel: 'CREVIEW', ts: '6.0', thread_ts: PARENT, user: 'UREVIEWBOT', bot_id: 'BJ', text }, ctx).map((r) => r.kind)).toEqual(['thread_reply']);
    expect(routeEvent({ type: 'app_mention', channel: 'CREVIEW', ts: '6.0', thread_ts: PARENT, user: 'UREVIEWBOT', text }, ctx)).toEqual([]);
  });

  it('DM from anyone → command without needing a mention', () => {
    const routes = routeEvent({ type: 'message', channel: 'D0OWNER', channel_type: 'im', ts: '7.0', user: 'UOWNER', text: 'pause all' }, ctx);
    expect(routes).toEqual([{ kind: 'command', cmd: { kind: 'pause', pr: 'all' }, msg: { channel: 'D0OWNER', ts: '7.0', user: 'UOWNER', text: 'pause all' } }]);
    expect(routeEvent({ type: 'message', channel: 'D0X', channel_type: 'im', ts: '8.0', user: 'USOMEONE', text: 'hello' }, ctx)[0]).toMatchObject({
      cmd: { kind: 'unknown', text: 'hello' },
    });
  });
});

function fakeApi(over: Partial<{ [K in keyof SlackApi]: Partial<SlackApi[K]> }> = {}) {
  const api = {
    chat: {
      postMessage: vi.fn(async (a: { channel: string }) => ({ ok: true, ts: '9.0', channel: a.channel })),
      getPermalink: vi.fn(async (a: { channel: string; message_ts: string }) => ({ ok: true, permalink: `https://x.slack.com/archives/${a.channel}/p${a.message_ts}` })),
      ...over.chat,
    },
    reactions: { add: vi.fn(async () => ({ ok: true })), ...over.reactions },
    conversations: {
      open: vi.fn(async () => ({ ok: true, channel: { id: 'D0DM' } })),
      replies: vi.fn(async () => ({ ok: true, messages: [] })),
      list: vi.fn(async () => ({ ok: true, channels: [] })),
      ...over.conversations,
    },
    bots: { info: vi.fn(async () => ({ ok: true, bot: { user_id: 'U0BOT' } })), ...over.bots },
  };
  return api;
}

describe('createSlackPort', () => {
  it('post returns ts + permalink without unfurling', async () => {
    const api = fakeApi();
    const port = createSlackPort(api as unknown as SlackApi);
    await expect(port.post('C1', 'hi', '1.0')).resolves.toEqual({ ts: '9.0', permalink: 'https://x.slack.com/archives/C1/p9.0' });
    expect(api.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', text: 'hi', thread_ts: '1.0', unfurl_links: false }));
  });

  it('react strips colons and ignores already_reacted', async () => {
    const add = vi.fn(async () => {
      throw Object.assign(new Error('An API error occurred: already_reacted'), { data: { ok: false, error: 'already_reacted' } });
    });
    const port = createSlackPort(fakeApi({ reactions: { add } }) as unknown as SlackApi);
    await expect(port.react('C1', '1.0', ':eyes:')).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1.0', name: 'eyes' });
  });

  it('react rethrows other errors', async () => {
    const add = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { data: { ok: false, error: 'channel_not_found' } });
    });
    await expect(createSlackPort(fakeApi({ reactions: { add } }) as unknown as SlackApi).react('C1', '1.0', 'eyes')).rejects.toThrow('boom');
  });

  it('dm opens a conversation and posts', async () => {
    const api = fakeApi();
    await createSlackPort(api as unknown as SlackApi).dm('UOWNER', 'report');
    expect(api.conversations.open).toHaveBeenCalledWith({ users: 'UOWNER' });
    expect(api.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D0DM', text: 'report' }));
  });

  it('replies paginates and excludes the parent', async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: PARENT, user: 'UBOT', text: '<@UREVIEWBOT> review x' },
          { ts: '2.0', thread_ts: PARENT, user: 'UREVIEWBOT', bot_id: 'BJ', text: ':mag: starting' },
        ],
        response_metadata: { next_cursor: 'c2' },
      })
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: '3.0', thread_ts: PARENT, user: 'UREVIEWBOT', text: 'done' }], response_metadata: { next_cursor: '' } });
    const out = await createSlackPort(fakeApi({ conversations: { replies } }) as unknown as SlackApi).replies('C1', PARENT);
    expect(out).toEqual([
      { channel: 'C1', ts: '2.0', threadTs: PARENT, user: 'UREVIEWBOT', botId: 'BJ', text: ':mag: starting' },
      { channel: 'C1', ts: '3.0', threadTs: PARENT, user: 'UREVIEWBOT', text: 'done' },
    ]);
    expect(replies).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }));
  });

  it('channelId resolves names across pages and caches', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, channels: [{ id: 'CA', name: 'general' }], response_metadata: { next_cursor: 'n' } })
      .mockResolvedValueOnce({ ok: true, channels: [{ id: 'CREVIEW', name: 'pr-review' }] });
    const port = createSlackPort(fakeApi({ conversations: { list } }) as unknown as SlackApi);
    expect(await port.channelId('#pr-review')).toBe('CREVIEW');
    expect(await port.channelId('pr-review')).toBe('CREVIEW');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('channelId throws for unknown names', async () => {
    await expect(createSlackPort(fakeApi() as unknown as SlackApi).channelId('nope')).rejects.toThrow('not found');
  });

  it('botUserIdOf caches bots.info', async () => {
    const api = fakeApi();
    const port = createSlackPort(api as unknown as SlackApi);
    expect(await port.botUserIdOf('B1')).toBe('U0BOT');
    expect(await port.botUserIdOf('B1')).toBe('U0BOT');
    expect(api.bots.info).toHaveBeenCalledTimes(1);
  });
});

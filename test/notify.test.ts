import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { Pr } from '../src/contracts.js';
import { createNotifyPr } from '../src/notify.js';

const config = { owner: { github: 'me', slack: 'UOWNER' } } as unknown as Config;
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const prs = new Map<number, Partial<Pr>>([[1, { id: 1 }], [2, { id: 2 }]]);
  const dms: string[] = [];
  const deleted: string[] = [];
  const posts: { channel: string; text: string; threadTs?: string; broadcast?: boolean }[] = [];
  const notify = createNotifyPr({
    config,
    store: {
      getPr: async (id) => (prs.get(id) as Pr) ?? null,
      // Same compare-and-set as the real store (covered in store.test.ts).
      claimDmThread: async (id, dmChannel, dmTs) => {
        const pr = prs.get(id)!;
        if (!pr.dmTs) Object.assign(pr, { dmChannel, dmTs });
        return { ...pr } as Pr;
      },
    },
    slack: {
      dm: async (_u, text) => {
        dms.push(text);
        const ts = `${dms.length}00.0`;
        await tick(); // lets a concurrent notice read the PR before this one claims the thread
        return { channel: 'D1', ts };
      },
      post: async (channel, text, threadTs, opts) => (posts.push({ channel, text, threadTs, broadcast: opts?.broadcast }), { ts: '9.0', permalink: '' }),
      delete: async (_c, ts) => void deleted.push(ts),
    },
  });
  return { notify, prs, dms, deleted, posts };
}

describe('createNotifyPr — one DM thread per PR', () => {
  it('the first DM about a PR starts its thread; later ones reply there, broadcast', async () => {
    const t = setup();
    await t.notify({ id: 1 } as Pr, 'o/a#1 needs you: x');
    expect(t.dms).toHaveLength(1);
    expect(t.dms[0]).toContain('Reply in this thread');
    expect(t.prs.get(1)).toMatchObject({ dmChannel: 'D1', dmTs: '100.0' });

    await t.notify({ id: 1 } as Pr, 'o/a#1 ready to merge'); // a stale copy still finds the thread
    expect(t.dms).toHaveLength(1);
    expect(t.posts).toEqual([{ channel: 'D1', text: expect.stringContaining('ready to merge'), threadTs: '100.0', broadcast: true }]);
  });

  it('two notices racing on a PR without a thread: one thread; the loser deletes its DM and replies in it', async () => {
    const t = setup();
    await Promise.all([t.notify({ id: 1 } as Pr, 'first'), t.notify({ id: 1 } as Pr, 'second')]);
    expect(t.dms).toHaveLength(2);
    expect(t.prs.get(1)).toMatchObject({ dmChannel: 'D1', dmTs: '100.0' });
    expect(t.deleted).toEqual(['200.0']);
    expect(t.posts).toEqual([{ channel: 'D1', text: expect.stringContaining('second'), threadTs: '100.0', broadcast: true }]);
  });

  it('each PR gets its own thread', async () => {
    const t = setup();
    await t.notify({ id: 1 } as Pr, 'a');
    await t.notify({ id: 2 } as Pr, 'b');
    expect(t.prs.get(1)!.dmTs).toBe('100.0');
    expect(t.prs.get(2)!.dmTs).toBe('200.0');
    expect(t.posts).toEqual([]);
  });
});

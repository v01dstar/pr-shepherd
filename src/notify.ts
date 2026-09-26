// The owner hears about a PR only when it needs them, in that PR's DM thread (DESIGN §5.6): the first such DM
// starts the thread, later ones reply in it (also broadcast to the DM so they are not buried), and the owner's
// replies there reach the agent (inbox). The database decides which DM starts the thread: two notices racing on a
// PR without one both DM, one wins claimDmThread, and the other deletes its DM and replies in the winner's thread.
import type { Config } from './config.js';
import type { Pr, SlackPort, Store } from './contracts.js';
import { log } from './log.js';

export type NotifyPr = (pr: Pr, text: string) => Promise<void>;

type Deps = {
  config: Config;
  store: Pick<Store, 'getPr' | 'claimDmThread'>;
  slack: Pick<SlackPort, 'dm' | 'post' | 'delete'>;
};

export function createNotifyPr(deps: Deps): NotifyPr {
  const { config, store, slack } = deps;
  return async (pr, text) => {
    const body = `${text}\n_Reply in this thread when it's handled (e.g. "done, continue") and I'll pick it up._`;
    const inThread = (p: Pr) => slack.post(p.dmChannel!, body, p.dmTs!, { broadcast: true });
    // The caller's copy may predate the thread; read the current one.
    const current = (await store.getPr(pr.id)) ?? pr;
    if (current.dmChannel && current.dmTs) {
      await inThread(current);
      return;
    }
    const dm = await slack.dm(config.owner.slack, body);
    const stored = await store.claimDmThread(pr.id, dm.channel, dm.ts);
    if (stored.dmChannel === dm.channel && stored.dmTs === dm.ts) return;
    await slack.delete(dm.channel, dm.ts).catch((err: unknown) => log.warn({ err, prId: pr.id }, 'could not delete duplicate PR DM'));
    await inThread(stored);
  };
}

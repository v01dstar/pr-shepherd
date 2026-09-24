// G3: review / approve other people's PRs when tagged (DESIGN §7.2, §7.3).
// The agent only produces the structured review; the harness posts everything, as me.
import type { Config } from './config.js';
import type { Command, GithubPort, Job, PrMeta, PrRef, Repos, Scheduler, SlackMessage, SlackPort, Store } from './contracts.js';
import { log } from './log.js';
import { reviewOutputSchema, type ReviewOutput } from './output.js';

export type G3Deps = {
  config: Config;
  store: Store;
  slack: SlackPort;
  github: GithubPort;
  repos: Repos;
  scheduler: Pick<Scheduler, 'runReview'>;
  now?: () => Date;
};

export type G3 = {
  onReview(cmd: Extract<Command, { kind: 'g3_review' }>, msg: SlackMessage): Promise<void>;
  onApprove(cmd: Extract<Command, { kind: 'g3_approve' }>, msg: SlackMessage): Promise<void>;
  inFlight(): number; // review runs holding a slot
  busy(): boolean; // a new review would have to queue
};

export const ownPrReply = (botName: string) => `this is my own PR — it goes through ${botName}'s shepherd flow (G2)`;
export const BUSY_REPLY = ':hourglass_flowing_sand: all review slots are busy — queued, will start as soon as one frees up…';
export const EXTERNAL_NOTE = 'external contributor: static review only, do not run code';
export const FOLLOW_UP_REPLY = ':hourglass_flowing_sand: a review of this PR is already running — queued a re-review of the latest head for when it finishes…';

const SEVERITY_ORDER = { Critical: 0, Suggestion: 1, Information: 2 } as const;

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.repo}/pull/${ref.number}`;
}

export function formatGithubReview(out: ReviewOutput): { body: string; comments: { path: string; line: number; body: string }[] } {
  const c = out.counts;
  const sorted = [...out.comments].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const findings = sorted.length
    ? sorted.map((f) => `- [${f.severity}] ${f.path}:${f.line} — ${f.body.replace(/\s*\n\s*/g, ' ')}`).join('\n')
    : '- none';
  const body = [
    `## Verdict: ${out.verdict} — ${c.critical} Critical · ${c.suggestion} Suggestion · ${c.information} Information`,
    out.summary,
    `### Verified\n${out.verified}`,
    `### Findings\n${findings}`,
  ].join('\n\n');
  return { body, comments: sorted.map((f) => ({ path: f.path, line: f.line, body: `**[${f.severity}]** ${f.body}` })) };
}

// Mirrors review-bot's verdict so classifyReply (DESIGN §5.3) reads it as `done` via the review link.
export function formatSlackVerdict(out: ReviewOutput, meta: Pick<PrMeta, 'repo' | 'number' | 'title'>, reviewUrl: string): string {
  const icon = out.verdict === 'approved' ? ':white_check_mark:' : ':octagonal_sign:';
  const repoName = meta.repo.split('/').pop() ?? meta.repo;
  const c = out.counts;
  return [
    `${icon} review verdict: *${out.verdict}*`,
    `review: <${reviewUrl}>`,
    `Round ${out.round} on ${repoName}#${meta.number} (${meta.title}) at ${out.head_sha.slice(0, 7)} — COMMENT/${out.verdict}, ` +
      `${c.critical} Critical, ${c.suggestion} Suggestion, ${c.information} Information. ${out.summary}`,
  ].join('\n');
}

// FIFO counting semaphore for the review pool (DESIGN §5.4: G3 review pool, queue when full).
function pool(size: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    active: () => active,
    full: () => active >= size || waiters.length > 0,
    async acquire() {
      if (active < size && waiters.length === 0) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next(); // slot passes straight to the next waiter
      else active--;
    },
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createG3(deps: G3Deps): G3 {
  const { config, store, slack, github, repos, scheduler } = deps;
  const now = deps.now ?? (() => new Date());
  const slots = pool(config.limits.reviewConcurrency);
  // One review per PR at a time: they share the review worktree. A request during a running review queues a
  // follow-up job (DESIGN §7.2 only merges requests while queued).
  const prChains = new Map<string, Promise<unknown>>();
  function onePerPr<T>(ref: PrRef, fn: () => Promise<T>): { busy: boolean; done: Promise<T> } {
    const key = `${ref.repo.toLowerCase()}#${ref.number}`;
    const prev = prChains.get(key);
    const done = (prev ?? Promise.resolve()).catch(() => {}).then(fn);
    prChains.set(key, done);
    void done.finally(() => { if (prChains.get(key) === done) prChains.delete(key); }).catch(() => {});
    return { busy: prev !== undefined, done };
  }

  const thread = (msg: SlackMessage) => msg.threadTs ?? msg.ts;
  const reply = (msg: SlackMessage, text: string) => slack.post(msg.channel, text, thread(msg));
  // Reactions are cosmetic; `already_reacted` and friends must not break a flow.
  const react = (msg: SlackMessage, emoji: string) =>
    slack.react(msg.channel, msg.ts, emoji).catch((e) => log.warn({ err: errMsg(e), emoji }, 'g3: react failed'));

  // DESIGN §7.2 checks. Returns meta, or the reason to refuse (already replied for own PRs).
  async function check(ref: PrRef, msg: SlackMessage): Promise<{ meta: PrMeta } | { reason: string }> {
    let meta: PrMeta;
    try {
      meta = await github.prMeta(ref);
    } catch (e) {
      return { reason: `cannot read PR: ${errMsg(e)}` };
    }
    if (meta.repo.split('/')[0]?.toLowerCase() !== config.org.toLowerCase()) return { reason: `not in ${config.org}` };
    if (meta.state !== 'OPEN') return { reason: `PR is ${meta.state.toLowerCase()}` };
    if (meta.author.toLowerCase() === config.owner.github.toLowerCase()) {
      await reply(msg, ownPrReply(config.bot.name));
      return { reason: 'own PR' };
    }
    return { meta };
  }

  async function finishJob(job: Job, status: 'done' | 'failed', verdict: string) {
    await store.updateJob(job.id, { status, verdict, endedAt: now() });
  }

  // The agent may report a short SHA; GitHub's commit_id needs the full one. The head may also have moved
  // since the check, so prefer a fresh read. Unresolvable → undefined (GitHub pins to the current head).
  async function fullSha(ref: PrRef, reported: string, checked: string): Promise<string | undefined> {
    if (/^[0-9a-f]{40}$/i.test(reported)) return reported;
    if (reported && checked.startsWith(reported)) return checked;
    const fresh = await github.prMeta(ref).catch(() => undefined);
    return fresh && reported && fresh.headSha.startsWith(reported) ? fresh.headSha : undefined;
  }

  async function postReview(ref: PrRef, out: ReviewOutput, headSha: string | undefined): Promise<string> {
    const { body, comments } = formatGithubReview(out);
    try {
      return (await github.postReview(ref, { event: 'COMMENT', body, commitId: headSha, comments })).url;
    } catch (e) {
      if (!comments.length) throw e;
      // GitHub rejects the whole review if one inline line is outside the diff; the body already lists every finding.
      log.warn({ err: errMsg(e), pr: ref }, 'g3: inline comments rejected, posting body only');
      return (await github.postReview(ref, { event: 'COMMENT', body, commitId: headSha })).url;
    }
  }

  async function runReview(job: Job, meta: PrMeta, cmd: Extract<Command, { kind: 'g3_review' }>, msg: SlackMessage) {
    const url = prUrl(cmd.pr);
    await store.updateJob(job.id, { status: 'running' });
    await reply(msg, `:mag: starting code review on <${url}> …`);

    await repos.ensureWorktree('review', cmd.pr, meta.headRef);
    const cwd = await repos.refreshReviewWorktree(cmd.pr);
    const context = [cmd.context.trim(), meta.authorIsOrgMember ? '' : EXTERNAL_NOTE].filter(Boolean).join('\n');
    const result = await scheduler.runReview(job, cwd, context);
    if (result.status !== 'ok') throw new Error(result.error ? `${result.status}: ${result.error}` : result.status);
    const parsed = reviewOutputSchema.safeParse(result.output);
    if (!parsed.success) throw new Error('bad_output: not a review');
    const out = parsed.data;

    const reviewUrl = await postReview(cmd.pr, out, await fullSha(cmd.pr, out.head_sha, meta.headSha));
    await reply(msg, formatSlackVerdict(out, meta, reviewUrl));
    await react(msg, out.verdict === 'approved' ? 'white_check_mark' : 'no_entry');
    await finishJob(job, 'done', out.verdict);
  }

  return {
    inFlight: () => slots.active(),
    busy: () => slots.full(),

    async onReview(cmd, msg) {
      const url = prUrl(cmd.pr);
      await react(msg, 'eyes');
      const checked = await check(cmd.pr, msg);
      if ('reason' in checked) {
        if (checked.reason !== 'own PR') await reply(msg, `:x: <${url}> — review failed (${checked.reason})`);
        return;
      }
      const job = await store.addJob({ ...cmd.pr, kind: 'review', requestedBy: msg.user ?? msg.botId ?? 'unknown', channel: msg.channel, threadTs: thread(msg) });
      if (!job) return; // same PR already queued: the :eyes: is the whole answer

      const { busy, done } = onePerPr(cmd.pr, async () => {
        if (slots.full()) await reply(msg, BUSY_REPLY);
        await slots.acquire();
        try {
          // Re-read the PR: a follow-up must review the head as it is now.
          const meta = busy ? (await github.prMeta(cmd.pr).catch(() => checked.meta)) : checked.meta;
          await runReview(job, meta, cmd, msg);
        } catch (e) {
          log.error({ err: errMsg(e), job: job.id }, 'g3: review failed');
          await reply(msg, `:x: <${url}> — review failed (${errMsg(e)})`).catch(() => undefined);
          await finishJob(job, 'failed', 'failed').catch(() => undefined);
        } finally {
          slots.release();
        }
      });
      if (busy) await reply(msg, FOLLOW_UP_REPLY).catch(() => undefined);
      await done;
    },

    async onApprove(cmd, msg) {
      const url = prUrl(cmd.pr);
      await react(msg, 'eyes');
      const checked = await check(cmd.pr, msg);
      if ('reason' in checked) {
        if (checked.reason !== 'own PR') await reply(msg, `:x: <${url}> — failed (${checked.reason})`);
        return;
      }
      const job = await store.addJob({ ...cmd.pr, kind: 'approve', requestedBy: msg.user ?? msg.botId ?? 'unknown', channel: msg.channel, threadTs: thread(msg) });
      if (!job) return;
      await store.updateJob(job.id, { status: 'running' });

      try {
        // Lock the approval to the head we checked, so a push in between doesn't get a blind LGTM.
        const { url: reviewUrl } = await github.postReview(cmd.pr, { event: 'APPROVE', body: 'LGTM', commitId: checked.meta.headSha });
        const login = await github.login();
        await reply(msg, `:white_check_mark: <${url}> — approved as ${login} (<${reviewUrl}>)`);
        await react(msg, 'white_check_mark');
        await finishJob(job, 'done', 'approved');
      } catch (e) {
        log.error({ err: errMsg(e), job: job.id }, 'g3: approve failed');
        await reply(msg, `:x: <${url}> — failed (github): ${errMsg(e)}`).catch(() => undefined);
        await finishJob(job, 'failed', 'failed').catch(() => undefined);
        return;
      }

      try {
        await repos.cleanup('review', cmd.pr);
      } catch (e) {
        if (!/not registered/i.test(errMsg(e))) log.warn({ err: errMsg(e), pr: cmd.pr }, 'g3: review workspace cleanup failed');
      }
    },
  };
}

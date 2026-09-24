// Fake reviewer bot for dev: answers @-mentions in #pr-review-test with the reviewer-bot reply formats
// (review-bot / codex-bot / summary-bot style, see test/fixtures/slack/verdicts.json), so the shepherd loop can be
// exercised end to end without bothering the real bots.
//
//   FAKE_SLACK_BOT_TOKEN=xoxb-… FAKE_SLACK_APP_TOKEN=xapp-… FAKE_MODE=changes npx tsx scripts/fake-reviewer.ts
//
// FAKE_MODE      approve | changes | queue-then-approve | silent | error   (default approve)
// FAKE_PERSONA   review | codex | summary                                   (default review)
// FAKE_REVIEW_URL  fixed review link; default <pr url>#pullrequestreview-<random>
// FAKE_DELAY_SEC   pause between progress and verdict (default 5)
// FAKE_CHANNEL     channel name to answer in (default pr-review-test)
// `approve <url>` mentions always get review-bot's approve format (or its failure format in error mode).
import { App, LogLevel } from '@slack/bolt';

const MODES = ['approve', 'changes', 'queue-then-approve', 'silent', 'error'] as const;
type Mode = (typeof MODES)[number];
type Persona = 'review' | 'codex' | 'summary';

const mode = (process.env.FAKE_MODE ?? 'approve') as Mode;
const persona = (process.env.FAKE_PERSONA ?? 'review') as Persona;
const delayMs = Number(process.env.FAKE_DELAY_SEC ?? 5) * 1000;
const channelName = process.env.FAKE_CHANNEL ?? 'pr-review-test';
if (!MODES.includes(mode)) throw new Error(`FAKE_MODE must be one of ${MODES.join('|')}`);
if (!['review', 'codex', 'summary'].includes(persona)) throw new Error('FAKE_PERSONA must be review|codex|summary');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PR_URL = /https:\/\/github\.com\/([^/\s|>]+\/[^/\s|>]+)\/pull\/(\d+)/;

function reviewUrl(prUrl: string) {
  return process.env.FAKE_REVIEW_URL ?? `${prUrl}#pullrequestreview-${Math.floor(1e9 + Math.random() * 9e9)}`;
}

// Messages in order, FAKE_DELAY_SEC apart. Formats mirror the real reviewer bots' messages.
function reviewScript(prUrl: string, repo: string, n: string, approved: boolean): string[] {
  const link = reviewUrl(prUrl);
  const short = `${repo.split('/')[1]}#${n}`;
  switch (persona) {
    case 'review':
      return [
        `:mag: starting code review on <${prUrl}> …`,
        approved
          ? `:white_check_mark: review verdict: *approved*\nreview: <${link}>\nRound 1 on ${short} at abc1234 — COMMENT/approved, zero Critical. (fake)`
          : `:octagonal_sign: review verdict: *request_changes*\nreview: <${link}>\nReviewed ${repo}#${n} at head abc1234 … One Critical stands (fake).`,
      ];
    case 'codex':
      return [
        `:mag: reviewing <${prUrl}> with Codex…`,
        approved
          ? `:white_check_mark: verdict: *approved*\nreview: <${link}>\nNo critical issues found. (fake)`
          : `:octagonal_sign: verdict: *request_changes*\nreview: <${link}>\nThis correctness risk is Critical, so changes are requested. (fake)`,
      ];
    case 'summary':
      return [
        approved
          ? `:white_check_mark: Reviewed <${prUrl}|${short}> — no blocking findings (0 min)\n\nI found no problems and would approve it. (fake)\n\nFull review: <${link}>`
          : `:x: Reviewed <${prUrl}|${short}> — changes requested (1 important, 0 min)\n\nI would not merge it as-is. (fake)\n\nFull review: <${link}>`,
      ];
  }
}

const app = new App({
  token: process.env.FAKE_SLACK_BOT_TOKEN,
  appToken: process.env.FAKE_SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

let channelId: string | undefined;

app.event('app_mention', async ({ event, client, logger }) => {
  if (!channelId) {
    const info = await client.conversations.info({ channel: event.channel });
    if (info.channel?.name === channelName) channelId = event.channel;
  }
  if (event.channel !== channelId) return;

  const m = PR_URL.exec(event.text);
  if (!m) return;
  const [prUrl, repo, n] = [m[0], m[1]!, m[2]!];
  const threadTs = event.thread_ts ?? event.ts;
  const say = (text: string) => client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text });
  const isApprove = /\bapprove\b/i.test(event.text.replace(PR_URL, ''));
  logger.info(`${isApprove ? 'approve' : 'review'} ${repo}#${n} mode=${mode} persona=${persona}`);

  if (mode === 'silent') return;
  if (mode === 'error') {
    await say(isApprove ? `:x: <${prUrl}> — failed (not mergeable): Review cannot be requested` : `:x: <${prUrl}> — review failed (fake error)`);
    return;
  }
  if (isApprove) {
    await sleep(delayMs);
    await say(`:white_check_mark: <${prUrl}> — approved as fake-approver (<${reviewUrl(prUrl)}>)`);
    return;
  }
  if (mode === 'queue-then-approve') {
    await say(persona === 'review' ? ':hourglass_flowing_sand: all review slots are busy — queued, will start as soon as one frees up…' : 'Queued — 1 review ahead of this one.');
    await sleep(delayMs * 2);
  }
  const steps = reviewScript(prUrl, repo, n, mode !== 'changes');
  for (const [i, text] of steps.entries()) {
    if (i > 0) await sleep(delayMs);
    await say(text);
  }
});

await app.start();
console.log(`fake reviewer up: mode=${mode} persona=${persona} channel=#${channelName}`);

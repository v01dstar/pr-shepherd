// Daily report DM'd to the owner, built only from the database (DESIGN §5.9).
import type { Config } from './config.js';
import type { Pr, SlackPort, Store } from './contracts.js';
import { log } from './log.js';
import type { StoreExtras } from './store.js';
import type { CredentialStatus } from './credentials.js';
import { daysLeft } from './expiry.js';

const DAY_MS = 24 * 60 * 60_000;

// Wall-clock parts of `d` in `timeZone`.
function zoned(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, md: `${get('month')}-${get('day')}`, hm: `${get('hour')}:${get('minute')}` };
}

const joinParts = (parts: string[]) => parts.join(' · ');

const shortName = (pr: Pr) => `${pr.repo.split('/').pop()}#${pr.number}`;

type ReportDeps = {
  store: Store & Partial<Pick<StoreExtras, 'lastRunWithOutput'>>;
  config: Config;
  credentials?: () => CredentialStatus | undefined;
};

// Tokens expiring within this window get a line in the report (DESIGN §11.1).
const EXPIRY_REPORT_DAYS = 30;

export async function buildReport(deps: ReportDeps, now: Date): Promise<string | null> {
  const { store, config } = deps;
  const since = new Date(now.getTime() - DAY_MS);
  const lines: string[] = [];

  const jobs = (await store.jobsSince(since)).filter((j) => j.status === 'done');
  const reviews = jobs.filter((j) => j.kind === 'review');
  const approved = reviews.filter((j) => j.verdict === 'approved').length;
  const changes = reviews.filter((j) => j.verdict === 'request_changes').length;
  const approves = jobs.filter((j) => j.kind === 'approve' && j.verdict === 'approved').length;
  const g3: string[] = [];
  if (reviews.length) g3.push(`review ${reviews.length} (✅${approved} ⛔${changes})`);
  if (approves) g3.push(`approve ${approves}`);
  if (g3.length) lines.push(`G3: ${joinParts(g3)}`);

  const items = (await store.runsSince(since)).flatMap((r) =>
    r.prId != null && r.output && 'handled' in r.output ? r.output.handled.flatMap((h) => h.items) : [],
  );
  const merged = (await store.listPrs(['merged'])).filter((p) => p.closedAt && p.closedAt >= since).length;
  const mine: string[] = [];
  if (items.length) {
    const count = (a: string) => items.filter((i) => i.action === a).length;
    const parts = [`fix ${count('fix')}`, `reply ${count('reply')}`, `escalate ${count('escalate')}`];
    if (count('ignore')) parts.push(`ignore ${count('ignore')}`);
    mine.push(`comments handled ${items.length} (${parts.join(' · ')})`);
  }
  if (merged) mine.push(`merged ${merged}`);
  if (mine.length) lines.push(`My PRs: ${joinParts(mine)}`);

  const open = await store.listPrs(['needs_human', 'active', 'paused']);
  open.sort((a, b) => Number(b.status === 'needs_human') - Number(a.status === 'needs_human') || a.id - b.id);
  if (open.length) {
    lines.push(`Open ${open.length}:`);
    for (const pr of open) {
      let text: string;
      if (pr.status === 'needs_human') text = `needs me: ${pr.reason ?? '-'}`;
      else {
        // The latest run with output; an interrupted/errored/quota run after it has none (DESIGN §5.9).
        const run = await store.lastRun(pr.id);
        const withOutput = run?.output ? run : ((await store.lastRunWithOutput?.(pr.id)) ?? null);
        const line = withOutput?.output && 'status_line' in withOutput.output ? withOutput.output.status_line : null;
        const status = run?.status === 'running' ? 'working' : (line ?? '-');
        text = pr.status === 'paused' ? `paused: ${status}` : status;
      }
      lines.push(`• ${shortName(pr)} ${text}`);
    }
  }

  const creds = deps.credentials?.();
  for (const [name, c] of Object.entries(creds ?? {})) {
    if (!c.expiresAt) continue;
    const left = daysLeft(new Date(c.expiresAt), now);
    if (left <= EXPIRY_REPORT_DAYS) lines.push(`:hourglass: ${name} token expires in ${Math.max(left, 0)} days${c.estimated ? ' (estimated)' : ''}`);
  }

  if (!lines.length) return null;
  return [`${config.bot.name} · ${zoned(now, config.timing.timezone).md}`, ...lines].join('\n');
}

// Checks once a minute; fires once per local day once the wall clock in timing.timezone reaches timing.reportAt.
// ">=" instead of "==" so timer drift can't skip the minute; a start after reportAt waits for tomorrow.
export function scheduleReport(deps: ReportDeps & { slack: SlackPort; now?: () => Date }): () => void {
  const now = deps.now ?? (() => new Date());
  const { reportAt, timezone } = deps.config.timing;
  const start = zoned(now(), timezone);
  let lastDate: string | null = start.hm >= reportAt ? start.date : null;
  const tick = async () => {
    const t = now();
    const z = zoned(t, timezone);
    if (z.hm < reportAt || z.date === lastDate) return;
    lastDate = z.date;
    const text = await buildReport(deps, t);
    if (text) await deps.slack.dm(deps.config.owner.slack, text);
  };
  const handle = setInterval(() => void tick().catch((e: unknown) => log.error({ err: e }, 'daily report failed')), 60_000);
  return () => clearInterval(handle);
}

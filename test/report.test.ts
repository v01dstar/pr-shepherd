import { migrationSql } from './migrations.js';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db, SlackPort } from '../src/contracts.js';
import type { ShepherdOutput } from '../src/output.js';
import { buildReport, scheduleReport } from '../src/report.js';
import { createStore } from '../src/store.js';

const migration = migrationSql;
const config = loadConfig('config.example.yaml'); // timezone America/Los_Angeles, reportAt 09:00

let store: ReturnType<typeof createStore>;
beforeEach(async () => {
  const pg = new PGlite();
  await pg.exec(migration);
  const db: Db = { query: async (t, p) => (await pg.query(t, p)) as never };
  store = createStore(db);
});

const item = (action: 'fix' | 'reply' | 'escalate' | 'ignore') => ({ url: 'u', severity: 'Suggestion' as const, action, commit: null, note: '' });
const output = (status_line: string, actions: Parameters<typeof item>[0][] = []): ShepherdOutput => ({
  handled: actions.length ? [{ reviewer: 'codex-bot', review_url: 'r', items: actions.map(item) }] : [],
  rebase: null,
  status_line,
  next: { action: 'wait', minutes: 5, reason: 'x' },
});

describe('buildReport', () => {
  it('keeps the last status line when the latest run was interrupted', async () => {
    const pr = (await store.upsertPr({ repo: 'your-org/example-cli', number: 271 }, ['codex-bot'], 4)).pr;
    const r1 = await store.createRun({ prId: pr.id });
    await store.updateRun(r1.id, { status: 'ok', output: output('waiting for review-bot re-review (r2)') });
    const r2 = await store.createRun({ prId: pr.id });
    await store.updateRun(r2.id, { status: 'interrupted' });
    expect(await buildReport({ store, config }, new Date())).toContain('• example-cli#271 waiting for review-bot re-review (r2)');
  });

  it('returns null when there is nothing to report', async () => {
    expect(await buildReport({ store, config }, new Date())).toBeNull();
  });

  it('renders the DESIGN §5.9 format with needs_human first', async () => {
    const now = new Date();
    const job = { repo: 'o/r', number: 1, requestedBy: 'U1', channel: 'C', threadTs: '1.1' };
    for (const [kind, verdict, n] of [['review', 'approved', 1], ['review', 'approved', 2], ['review', 'request_changes', 3], ['approve', 'approved', 4]] as const) {
      const j = await store.addJob({ ...job, kind, number: n });
      await store.updateJob(j!.id, { status: 'done', verdict, endedAt: now });
    }
    await store.addJob({ ...job, kind: 'review', number: 9 }); // still queued: not counted

    const active = (await store.upsertPr({ repo: 'your-org/example-cli', number: 271 }, ['codex-bot'], 4)).pr;
    const human = (await store.upsertPr({ repo: 'your-org/example-api', number: 530 }, ['codex-bot'], 4)).pr;
    const merged = (await store.upsertPr({ repo: 'your-org/example-console', number: 540 }, ['codex-bot'], 4)).pr;
    await store.updatePr(human.id, { status: 'needs_human', reason: 'two reviewers disagree' });
    await store.updatePr(merged.id, { status: 'merged', closedAt: now });

    const r1 = await store.createRun({ prId: active.id });
    await store.updateRun(r1.id, { status: 'ok', output: output('old', ['fix', 'fix', 'reply']), endedAt: now });
    const r2 = await store.createRun({ prId: active.id });
    await store.updateRun(r2.id, { status: 'ok', output: output('waiting on review-bot re-review (r2)', ['fix', 'escalate']), endedAt: now });

    const text = await buildReport({ store, config }, now);
    const md = new Intl.DateTimeFormat('en-CA', { timeZone: config.timing.timezone, month: '2-digit', day: '2-digit' }).format(now);
    expect(text).toBe(
      [
        `pr-shepherd · ${md}`,
        'G3: review 3 (✅2 ⛔1) · approve 1',
        'My PRs: comments handled 5 (fix 3 · reply 1 · escalate 1) · merged 1',
        'Open 2:',
        '• example-api#530 needs me: two reviewers disagree',
        '• example-cli#271 waiting on review-bot re-review (r2)',
      ].join('\n'),
    );
  });

  it('omits empty sections and ignores old merges', async () => {
    const pr = (await store.upsertPr({ repo: 'your-org/a', number: 1 }, ['codex-bot'], 4)).pr;
    await store.updatePr(pr.id, { status: 'merged', closedAt: new Date(Date.now() - 2 * 86_400_000) });
    const p2 = (await store.upsertPr({ repo: 'your-org/b', number: 2 }, ['codex-bot'], 4)).pr;
    await store.updatePr(p2.id, { status: 'paused' });
    await store.createRun({ prId: p2.id });
    const text = (await buildReport({ store, config }, new Date()))!;
    expect(text.split('\n').slice(1)).toEqual(['Open 1:', '• b#2 paused: working']);
  });
});

describe('scheduleReport', () => {
  afterEach(() => vi.useRealTimers());

  it('DMs the owner once when the local clock reaches reportAt', async () => {
    vi.useFakeTimers();
    const dms: string[] = [];
    const slack = { dm: async (_u: string, t: string) => void dms.push(t) } as unknown as SlackPort;
    await store.upsertPr({ repo: 'your-org/a', number: 1 }, ['codex-bot'], 4);
    // 08:58 PDT = 15:58Z
    let clock = new Date('2026-09-23T15:58:00Z');
    const stop = scheduleReport({ store, config, slack, now: () => clock });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dms).toEqual([]);
    clock = new Date('2026-09-23T16:00:30Z');
    await vi.advanceTimersByTimeAsync(60_000);
    clock = new Date('2026-09-23T16:01:30Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatch(/^pr-shepherd · 09-23\n/);
    stop();
  });

  it('does not fire on a start after reportAt', async () => {
    vi.useFakeTimers();
    const dms: string[] = [];
    const slack = { dm: async (_u: string, t: string) => void dms.push(t) } as unknown as SlackPort;
    await store.upsertPr({ repo: 'your-org/a', number: 1 }, ['codex-bot'], 4);
    const clock = new Date('2026-09-23T20:00:00Z');
    const stop = scheduleReport({ store, config, slack, now: () => clock });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dms).toEqual([]);
    stop();
  });
});

describe('buildReport credential expiry', () => {
  it('adds a line for tokens expiring within 30 days', async () => {
    const { buildReport } = await import('../src/report.js');
    const now = new Date('2026-09-24T16:00:00Z');
    const store = { jobsSince: async () => [], runsSince: async () => [], listPrs: async () => [], lastRun: async () => null } as never;
    const config = (await import('../src/config.js')).loadConfig('config.example.yaml');
    const credentials = () => ({
      github: { ok: true, detail: '', checkedAt: '', expiresAt: '2026-10-01T16:00:00Z' },
      claude: { ok: true, detail: '', checkedAt: '', expiresAt: '2027-09-01T00:00:00Z', estimated: true },
      slack: { ok: true, detail: '', checkedAt: '' },
    });
    const text = await buildReport({ store, config, credentials }, now);
    expect(text).toContain(':hourglass: github token expires in 7 days');
    expect(text).not.toContain('claude token');
    expect(await buildReport({ store, config }, now)).toBeNull();
  });
});

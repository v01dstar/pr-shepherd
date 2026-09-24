import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/contracts.js';
import { dueReminder, parseGithubExpiry, trackExpiry } from '../src/expiry.js';
import { migrationSql } from './migrations.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-24T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('parseGithubExpiry', () => {
  it('parses the header formats GitHub sends', () => {
    expect(parseGithubExpiry('2026-11-05 22:08:02 UTC')?.toISOString()).toBe('2026-11-05T22:08:02.000Z');
    expect(parseGithubExpiry('2026-11-05 15:08:02 -0700')?.toISOString()).toBe('2026-11-05T22:08:02.000Z');
    expect(parseGithubExpiry(undefined)).toBeNull();
    expect(parseGithubExpiry('never')).toBeNull();
  });
});

describe('dueReminder', () => {
  it('announces each threshold once, collapsing thresholds crossed together', () => {
    expect(dueReminder(at(40), T0, [])).toBeNull();
    expect(dueReminder(at(30), T0, [])).toEqual({ days: 30, marks: [30] });
    expect(dueReminder(at(20), T0, [30])).toBeNull();
    expect(dueReminder(at(5), T0, [30])).toEqual({ days: 5, marks: [30, 14, 7] });
    expect(dueReminder(at(5), T0, [30, 14, 7])).toBeNull();
    expect(dueReminder(at(-2), T0, [30, 14, 7, 3])).toEqual({ days: 0, marks: [30, 14, 7, 3, 1] });
  });
});

describe('trackExpiry', () => {
  let db: Db;
  beforeEach(async () => {
    const pg = new PGlite();
    await pg.exec(migrationSql);
    db = { query: (t, p) => pg.query(t, p) as never };
  });

  it('github: reminds at 30/14/7 days and only once per threshold', async () => {
    const exp = at(60);
    expect((await trackExpiry(db, { name: 'github', token: 'a', expiresAt: exp }, T0)).remindDays).toBeNull();
    expect((await trackExpiry(db, { name: 'github', token: 'a', expiresAt: exp }, at(30))).remindDays).toBe(30);
    expect((await trackExpiry(db, { name: 'github', token: 'a', expiresAt: exp }, at(31))).remindDays).toBeNull();
    expect((await trackExpiry(db, { name: 'github', token: 'a', expiresAt: exp }, at(46))).remindDays).toBe(14);
  });

  it('github: a token without expiry never reminds', async () => {
    expect((await trackExpiry(db, { name: 'github', token: 'a', expiresAt: null }, T0)).remindDays).toBeNull();
  });

  it('claude: counts one year from first sight and resets on a new token', async () => {
    const first = await trackExpiry(db, { name: 'claude', token: 'old' }, T0);
    expect(first).toMatchObject({ estimated: true, remindDays: null });
    expect(first.expiresAt?.toISOString()).toBe(at(365).toISOString());
    expect((await trackExpiry(db, { name: 'claude', token: 'old' }, at(335))).remindDays).toBe(30);
    expect((await trackExpiry(db, { name: 'claude', token: 'old' }, at(336))).remindDays).toBeNull();
    const rotated = await trackExpiry(db, { name: 'claude', token: 'new' }, at(340));
    expect(rotated.remindDays).toBeNull();
    expect(rotated.expiresAt?.toISOString()).toBe(at(705).toISOString());
  });
});

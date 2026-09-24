// Credential expiry reminders (DESIGN §11.1). GitHub reports a fine-grained PAT's expiry on every API
// response; a `claude setup-token` token has no expiry API, so its one-year life is counted from the
// first time this deployment saw it. Each threshold is announced once per token.
import { createHash } from 'node:crypto';
import type { Db } from './contracts.js';

export const REMINDER_DAYS = [30, 14, 7, 3, 1];
export const CLAUDE_TOKEN_LIFETIME_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// Header value like "2026-11-05 22:08:02 UTC" or "2026-11-05 15:08:02 -0700".
export function parseGithubExpiry(value: string | undefined): Date | null {
  const m = value?.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const zone = !m[3] || /^(utc|z)$/i.test(m[3]) ? 'Z' : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysLeft(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

// The threshold to announce now, if any: the tightest one already crossed and not yet announced.
// Crossing several at once (e.g. first check with 5 days left) announces once and marks all of them.
export function dueReminder(expiresAt: Date, now: Date, reminded: number[]): { days: number; marks: number[] } | null {
  const left = daysLeft(expiresAt, now);
  const crossed = REMINDER_DAYS.filter((t) => left <= t);
  const fresh = crossed.filter((t) => !reminded.includes(t));
  if (!fresh.length) return null;
  return { days: Math.max(left, 0), marks: crossed };
}

export type ExpiryResult = { expiresAt: Date | null; estimated: boolean; remindDays: number | null };

// Records the token's fingerprint/expiry and returns whether a reminder is due now.
// For claude pass expiresAt undefined: it is derived from first_seen_at.
export async function trackExpiry(
  db: Db,
  input: { name: 'github' | 'claude'; token: string; expiresAt?: Date | null },
  now: Date,
): Promise<ExpiryResult> {
  const fp = fingerprint(input.token);
  const prev = (
    await db.query<{ fingerprint: string; first_seen_at: Date; reminded: number[] }>(
      'select fingerprint, first_seen_at, reminded from credential_expiry where name = $1',
      [input.name],
    )
  ).rows[0];
  const same = prev?.fingerprint === fp;
  const firstSeen = same ? new Date(prev.first_seen_at) : now;
  const reminded = same ? prev.reminded ?? [] : [];
  const estimated = input.expiresAt === undefined;
  const expiresAt = estimated ? new Date(firstSeen.getTime() + CLAUDE_TOKEN_LIFETIME_DAYS * DAY_MS) : input.expiresAt ?? null;
  const due = expiresAt ? dueReminder(expiresAt, now, reminded) : null;
  const nextReminded = due ? [...new Set([...reminded, ...due.marks])] : reminded;
  await db.query(
    `insert into credential_expiry (name, fingerprint, first_seen_at, expires_at, reminded, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (name) do update set fingerprint = excluded.fingerprint, first_seen_at = excluded.first_seen_at,
       expires_at = excluded.expires_at, reminded = excluded.reminded, updated_at = excluded.updated_at`,
    [input.name, fp, firstSeen, expiresAt, nextReminded, now],
  );
  return { expiresAt, estimated, remindDays: due ? due.days : null };
}

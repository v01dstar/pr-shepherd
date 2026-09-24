// Postgres pool + forward-only SQL migrations from migrations/*.sql (DESIGN §10).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { log } from './log.js';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, idleTimeoutMillis: 30_000 });
// An idle client losing its connection (DB restart, proxy reaping) emits 'error' on the pool; unhandled, it kills
// the process. The pool drops that client and the next query reconnects.
pool.on('error', (err) => log.error({ err }, 'pg idle client error'));

export async function migrate(dir = 'migrations'): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(7212024)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
    const applied = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log.info({ file }, 'migration applied');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(7212024)').catch(() => {});
    client.release();
  }
}

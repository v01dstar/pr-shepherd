// Every migration in order, for pglite-backed tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const migrationSql = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join('migrations', f), 'utf8'))
  .join('\n');

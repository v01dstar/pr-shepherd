// Workspace sweep + daily janitor (DESIGN §5.8).
import { readdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Exec, GithubPort, Repos, Scheduler, Store, Workspace } from './contracts.js';
import { defaultExec } from './github.js';
import { log } from './log.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_RETENTION_DAYS = 30;
const MIRROR_IDLE_DAYS = 30;
// Written into a bare mirror when it first has no live workspace; git ignores unknown files in the git dir.
const IDLE_MARKER = 'pr-shepherd-idle-since';
// Read (and cleared) for mirrors marked before the rename.

export type Janitor = { sweep(): Promise<void>; daily(): Promise<void>; start(): () => void };

export function createJanitor(deps: {
  config: Config;
  store: Store;
  github: GithubPort;
  repos: Repos;
  scheduler: Pick<Scheduler, 'isRunning'>;
  dataDir: string;
  now?: () => Date;
  exec?: Exec;
}): Janitor {
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? defaultExec;
  let sweeping = false;
  let dailyRunning = false;

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepOnce();
    } finally {
      sweeping = false;
    }
  }

  async function sweepOnce(): Promise<void> {
    const live = await deps.store.liveWorkspaces();
    if (!live.length) return;
    const { states, failed } = await prStates(live);
    const t = now();
    const busyReviews = await activeJobRefs(t);
    for (const ws of live) {
      if (failed.has(`${ws.repo}#${ws.number}`)) continue;
      try {
        await sweepWorkspace(ws, states.get(`${ws.repo}#${ws.number}`), busyReviews, t);
      } catch (e) {
        log.warn({ err: (e as Error).message, repo: ws.repo, number: ws.number, kind: ws.kind }, 'sweep: cleanup failed; will retry');
      }
    }
  }

  // One bad ref (e.g. a deleted repo) fails the whole batch; fall back to per-ref queries so it can't block the rest.
  async function prStates(live: Workspace[]) {
    const refs = live.map((w) => ({ repo: w.repo, number: w.number }));
    const failed = new Set<string>();
    try {
      return { states: await deps.github.prStates(refs), failed };
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'sweep: batched state query failed; retrying per PR');
    }
    const states = new Map<string, 'OPEN' | 'MERGED' | 'CLOSED'>();
    for (const ref of refs) {
      try {
        for (const [k, v] of await deps.github.prStates([ref])) states.set(k, v);
      } catch (e) {
        failed.add(`${ref.repo}#${ref.number}`);
        log.warn({ err: (e as Error).message, repo: ref.repo, number: ref.number }, 'sweep: state query failed; skipping');
      }
    }
    return { states, failed };
  }

  // G3 review runs have no prs row, so "is it running" comes from the jobs table.
  async function activeJobRefs(t: Date): Promise<Set<string>> {
    const since = new Date(t.getTime() - (deps.config.timing.reviewIdleDays + 1) * DAY_MS);
    const jobs = await deps.store.jobsSince(since);
    return new Set(jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => `${j.repo}#${j.number}`));
  }

  async function sweepWorkspace(ws: Workspace, state: string | undefined, busyReviews: Set<string>, t: Date) {
    const ref = { repo: ws.repo, number: ws.number };
    const key = `${ws.repo}#${ws.number}`;
    const pr = await deps.store.getPrByRef(ref);
    if (pr && deps.scheduler.isRunning(pr.id)) return;
    if (ws.kind === 'review' && busyReviews.has(key)) return;

    if (state === 'MERGED' || state === 'CLOSED') {
      if (ws.kind === 'shepherd' && pr && pr.status !== 'merged' && pr.status !== 'closed') {
        const status = state === 'MERGED' ? 'merged' : 'closed';
        await deps.store.updatePr(pr.id, { status, closedAt: t });
        await deps.store.cancelTimers(pr.id);
      }
      await deps.repos.cleanup(ws.kind, ref);
      return;
    }
    // Untracked (or cleanup failed at merge time) while GitHub still says OPEN.
    if (ws.kind === 'shepherd' && pr && (pr.status === 'merged' || pr.status === 'closed')) {
      await deps.repos.cleanup('shepherd', ref);
      return;
    }
    if (ws.kind === 'review' && t.getTime() - ws.lastUsedAt.getTime() > deps.config.timing.reviewIdleDays * DAY_MS) {
      await deps.repos.cleanup('review', ref);
    }
  }

  async function daily(): Promise<void> {
    if (dailyRunning) return;
    dailyRunning = true;
    try {
      await pruneSessions().catch((e: Error) => log.warn({ err: e.message }, 'janitor: session prune failed'));
      await maintainMirrors().catch((e: Error) => log.warn({ err: e.message }, 'janitor: mirror maintenance failed'));
    } finally {
      dailyRunning = false;
    }
  }

  // Deletes Claude session records (files and per-session dirs) under claude/projects/* older than 30 days,
  // except sessions still referenced by a tracked PR.
  async function pruneSessions() {
    const projects = join(deps.dataDir, 'claude', 'projects');
    const cutoff = now().getTime() - SESSION_RETENTION_DAYS * DAY_MS;
    const keep = new Set(
      (await deps.store.listPrs(['active', 'needs_human', 'paused'])).map((p) => p.sessionId).filter((s): s is string => !!s),
    );
    let removed = 0;
    for (const proj of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!proj.isDirectory()) continue;
      const dir = join(projects, proj.name);
      const entries = await readdir(dir);
      for (const name of entries) {
        if (keep.has(name.replace(/\.jsonl$/, ''))) continue;
        const p = join(dir, name);
        if ((await newestMtime(p)) < cutoff) {
          await rm(p, { recursive: true, force: true });
          removed++;
        }
      }
      if (!(await readdir(dir)).length) await rm(dir, { recursive: true, force: true });
    }
    if (removed) log.info({ removed }, 'janitor: pruned old Claude sessions');
  }

  async function maintainMirrors() {
    const live = await deps.store.liveWorkspaces();
    // Shepherd and G3 review worktrees have separate mirrors (repos.ts).
    await maintainMirrorRoot(join(deps.dataDir, 'repos'), new Set(live.filter((w) => w.kind === 'shepherd').map((w) => w.repo)));
    await maintainMirrorRoot(join(deps.dataDir, 'review-repos'), new Set(live.filter((w) => w.kind === 'review').map((w) => w.repo)));
  }

  async function maintainMirrorRoot(repos: string, liveRepos: Set<string>) {
    const t = now();
    const gcDay = weekday(t, deps.config.timing.timezone) === 'Sun';
    for (const owner of await readdir(repos, { withFileTypes: true }).catch(() => [])) {
      if (!owner.isDirectory()) continue;
      for (const m of await readdir(join(repos, owner.name), { withFileTypes: true })) {
        if (!m.isDirectory() || !m.name.endsWith('.git')) continue;
        const mirror = join(repos, owner.name, m.name);
        const repo = `${owner.name}/${m.name.slice(0, -4)}`;
        const marker = join(mirror, IDLE_MARKER);
        if (liveRepos.has(repo)) {
          await rm(marker, { force: true });
        } else {
          const read = async (f: string) => Date.parse((await readFile(f, 'utf8').catch(() => '')).trim());
          const since = await read(marker);
          if (Number.isNaN(since)) {
            await writeFile(marker, t.toISOString() + '\n');
          } else if (t.getTime() - since > MIRROR_IDLE_DAYS * DAY_MS) {
            await rm(mirror, { recursive: true, force: true });
            log.info({ repo }, 'janitor: deleted idle mirror');
            continue;
          }
        }
        if (gcDay) {
          await exec('git', ['gc', '--prune=now', '--quiet'], { cwd: mirror, timeoutMs: 30 * 60 * 1000 }).catch((e: Error) =>
            log.warn({ err: e.message, repo }, 'janitor: git gc failed'),
          );
        }
      }
    }
  }

  function start(): () => void {
    const run = (name: string, fn: () => Promise<void>) => () =>
      void fn().catch((e: Error) => log.error({ err: e.message }, `janitor: ${name} failed`));
    const sweepTimer = setInterval(run('sweep', sweep), deps.config.timing.sweepMin * 60_000);
    const dailyTimer = setInterval(run('daily', daily), DAY_MS);
    const kick = setTimeout(() => {
      run('sweep', sweep)();
      run('daily', daily)();
    }, 0);
    return () => {
      clearInterval(sweepTimer);
      clearInterval(dailyTimer);
      clearTimeout(kick);
    };
  }

  return { sweep, daily, start };
}

async function newestMtime(p: string): Promise<number> {
  const s = await stat(p);
  if (!s.isDirectory()) return s.mtimeMs;
  let newest = s.mtimeMs;
  for (const e of await readdir(p)) newest = Math.max(newest, await newestMtime(join(p, e)));
  return newest;
}

function weekday(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(d);
}

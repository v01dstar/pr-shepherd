// Bare mirrors + per-PR worktrees (DESIGN §5.4, §5.8, §7.2). Paths are stable: session records are keyed by cwd.
// G3 review worktrees hang off their own mirror (/data/review-repos), so untrusted code never shares a git dir
// (hooks, config) with the shepherd's worktrees.
import { appendFile, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Exec, PrRef, Repos, Store, WorkspaceKind } from './contracts.js';
import { defaultExec } from './github.js';
import { log } from './log.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
// Agent notes dir (DESIGN §5.4), git-excluded in every worktree.
const NOTES_DIR = '.pr-shepherd/';

// Git config forced onto every harness and shepherd git call: repository hooks and fsmonitor never execute, so a
// planted hook or config cannot run with our environment.
export const GIT_SAFE_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
} as const;

export type RepoPaths = {
  mirror(repo: string, kind?: WorkspaceKind): string;
  mirrorsRoot(kind: WorkspaceKind): string;
  worktree(kind: WorkspaceKind, ref: PrRef): string;
  tmp(kind: WorkspaceKind, ref: PrRef): string;
  root(kind: WorkspaceKind): string;
};

export function repoPaths(dataDir: string): RepoPaths {
  const base = resolve(dataDir);
  const slug = (ref: PrRef) => `${split(ref.repo).join('-')}-${ref.number}`;
  const root = (kind: WorkspaceKind) => join(base, kind === 'shepherd' ? 'worktrees' : 'review-worktrees');
  const mirrorsRoot = (kind: WorkspaceKind) => join(base, kind === 'shepherd' ? 'repos' : 'review-repos');
  return {
    mirror: (repo, kind = 'shepherd') => join(mirrorsRoot(kind), ...split(repo)) + '.git',
    mirrorsRoot,
    worktree: (kind, ref) => join(root(kind), slug(ref)),
    tmp: (kind, ref) => join(base, 'tmp', `${kind}-${slug(ref)}`),
    root,
  };
}

function split(repo: string): [string, string] {
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new Error(`invalid repo ${JSON.stringify(repo)}`);
  return repo.split('/') as [string, string];
}

const exists = (p: string) => stat(p).then(() => true, () => false);

export function createRepos(opts: {
  dataDir: string;
  store: Store;
  exec?: Exec;
  remoteUrl?: (repo: string) => string;
}): Repos {
  const exec = opts.exec ?? defaultExec;
  const remoteUrl = opts.remoteUrl ?? ((repo: string) => `https://github.com/${repo}.git`);
  const paths = repoPaths(opts.dataDir);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...GIT_SAFE_ENV };
  const git = (cwd: string, args: string[]) => exec('git', args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS }).then((r) => r.stdout);

  // Serialize git operations per mirror: several PRs of one repo share it.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(kind: WorkspaceKind, repoName: string, fn: () => Promise<T>): Promise<T> {
    const repo = `${kind}:${repoName}`;
    const prev = locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(repo, next);
    void next.finally(() => { if (locks.get(repo) === next) locks.delete(repo); }).catch(() => {});
    return next;
  }

  async function ensureMirror(repo: string, kind: WorkspaceKind): Promise<string> {
    const mirror = paths.mirror(repo, kind);
    if (await exists(join(mirror, 'HEAD'))) return mirror;
    await mkdir(resolve(mirror, '..'), { recursive: true });
    await exec('git', ['clone', '--bare', remoteUrl(repo), mirror], { env, timeoutMs: GIT_TIMEOUT_MS });
    // A bare clone has no fetch refspec; add one so `git fetch`/`git push` from worktrees track origin/*.
    await git(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    return mirror;
  }

  async function fetchPr(mirror: string, ref: PrRef, headRef?: string) {
    const specs = [`+refs/pull/${ref.number}/head:refs/remotes/pr/${ref.number}`];
    if (headRef) specs.push(`+refs/heads/${headRef}:refs/remotes/origin/${headRef}`);
    await git(mirror, ['fetch', '--no-tags', 'origin', ...specs]);
  }

  async function excludeNotes(wt: string) {
    const rel = (await git(wt, ['rev-parse', '--git-path', 'info/exclude'])).trim();
    const file = resolve(wt, rel);
    const cur = await readFile(file, 'utf8').catch(() => '');
    if (cur.split('\n').includes(NOTES_DIR)) return;
    await mkdir(resolve(file, '..'), { recursive: true });
    await appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${NOTES_DIR}\n`);
  }

  async function ensureWorktree(kind: WorkspaceKind, ref: PrRef, headRef: string): Promise<string> {
    if (kind === 'shepherd' && (!/^[A-Za-z0-9._\/-]+$/.test(headRef) || headRef.startsWith('-'))) throw new Error(`invalid head ref ${JSON.stringify(headRef)}`);
    const wt = paths.worktree(kind, ref);
    await withLock(kind, ref.repo, async () => {
      const mirror = await ensureMirror(ref.repo, kind);
      await fetchPr(mirror, ref, kind === 'shepherd' ? headRef : undefined);
      if (await exists(wt)) return;
      await mkdir(paths.root(kind), { recursive: true });
      await git(mirror, ['worktree', 'prune']);
      if (kind === 'shepherd') {
        // Real branch tracking origin so the agent can commit and `git push` as usual.
        await git(mirror, ['worktree', 'add', '--track', '-B', headRef, wt, `refs/remotes/origin/${headRef}`]);
      } else {
        await git(mirror, ['worktree', 'add', '--detach', wt, `refs/remotes/pr/${ref.number}`]);
      }
      log.info({ repo: ref.repo, number: ref.number, kind, path: wt }, 'worktree created');
    });
    await excludeNotes(wt);
    await opts.store.upsertWorkspace({ ...ref, kind, path: wt });
    return wt;
  }

  async function refreshReviewWorktree(ref: PrRef): Promise<string> {
    const wt = paths.worktree('review', ref);
    if (!(await exists(wt))) return ensureWorktree('review', ref, '');
    await withLock('review', ref.repo, async () => {
      await fetchPr(await ensureMirror(ref.repo, 'review'), ref);
      await git(wt, ['reset', '--hard', `refs/remotes/pr/${ref.number}`]);
      // Keep ignored files (deps, build output, .pr-shepherd/) across rounds.
      await git(wt, ['clean', '-fd']);
    });
    await opts.store.upsertWorkspace({ ...ref, kind: 'review', path: wt });
    return wt;
  }

  async function cleanup(kind: WorkspaceKind, ref: PrRef): Promise<void> {
    const ws = (await opts.store.liveWorkspaces()).find((w) => w.kind === kind && w.repo === ref.repo && w.number === ref.number);
    if (!ws) throw new Error(`refusing to clean ${kind} ${ref.repo}#${ref.number}: no live workspace registered`);
    const wt = resolve(ws.path);
    const root = paths.root(kind);
    if (!wt.startsWith(root + sep) || wt.slice(root.length + 1).includes(sep)) {
      throw new Error(`refusing to clean ${ws.path}: not directly under ${root}`);
    }
    const mirror = paths.mirror(ref.repo, kind);
    const hasMirror = await exists(join(mirror, 'HEAD'));

    await withLock(kind, ref.repo, async () => {
      let branch: string | undefined;
      if (await exists(wt)) {
        try {
          const status = (await git(wt, ['status', '--porcelain'])).split('\n').filter(Boolean);
          const head = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          if (head && head !== 'HEAD') branch = head;
          log.info({ repo: ref.repo, number: ref.number, kind, branch, dirty: status.length, status: status.slice(0, 20) }, 'workspace status before cleanup');
        } catch (e) {
          log.warn({ err: (e as Error).message, path: wt }, 'git status failed before cleanup');
        }
        if (hasMirror) await git(mirror, ['worktree', 'remove', '--force', '--force', wt]).catch((e: Error) => log.warn({ err: e.message }, 'worktree remove failed; deleting directory'));
        await rm(wt, { recursive: true, force: true });
      }
      if (hasMirror) {
        await git(mirror, ['worktree', 'prune']);
        if (branch) await git(mirror, ['branch', '-D', branch]).catch(() => {});
        await git(mirror, ['update-ref', '-d', `refs/remotes/pr/${ref.number}`]).catch(() => {});
      }
    });
    await rm(paths.tmp(kind, ref), { recursive: true, force: true });
    await opts.store.markWorkspaceCleaned(ws.id);
    log.info({ repo: ref.repo, number: ref.number, kind }, 'workspace cleaned');
  }

  return { ensureWorktree, refreshReviewWorktree, cleanup };
}

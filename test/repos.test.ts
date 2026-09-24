import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Store, Workspace } from '../src/contracts.js';
import { createRepos } from '../src/repos.js';

// Isolate from the developer's git config (signing, hooks, default branch).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fakeStore() {
  const rows: Workspace[] = [];
  const store = {
    async upsertWorkspace(w: Omit<Workspace, 'id' | 'lastUsedAt' | 'cleanedAt'>) {
      let row = rows.find((r) => r.kind === w.kind && r.repo === w.repo && r.number === w.number);
      if (!row) rows.push((row = { ...w, id: rows.length + 1, lastUsedAt: new Date(), cleanedAt: null }));
      Object.assign(row, { path: w.path, lastUsedAt: new Date(), cleanedAt: null });
      return row;
    },
    async liveWorkspaces() {
      return rows.filter((r) => !r.cleanedAt);
    },
    async markWorkspaceCleaned(id: number) {
      rows.find((r) => r.id === id)!.cleanedAt = new Date();
    },
  };
  return { store: store as unknown as Store, rows };
}

let root: string;
let origin: string;
let dataDir: string;
let prSha1: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-shepherd-repos-')));
  origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.txt'), 'base\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  git(origin, 'checkout', '-qb', 'feat');
  writeFileSync(join(origin, 'a.txt'), 'feat\n');
  git(origin, 'commit', '-qam', 'feat');
  prSha1 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/1/head', prSha1);
  git(origin, 'checkout', '-q', 'main');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
beforeEach(() => {
  dataDir = join(root, `data${n++}`);
});

const ref = { repo: 'acme/widget', number: 1 };
const mk = (store: Store) => createRepos({ dataDir, store, remoteUrl: () => origin });

describe('repos (real git)', () => {
  it('shepherd worktree: stable path, real branch tracking origin, notes excluded, registered, pushable', async () => {
    const { store, rows } = fakeStore();
    const repos = mk(store);
    const wt = await repos.ensureWorktree('shepherd', ref, 'feat');
    expect(wt).toBe(join(dataDir, 'worktrees', 'acme-widget-1'));
    expect(existsSync(join(dataDir, 'repos', 'acme', 'widget.git', 'HEAD'))).toBe(true);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(git(wt, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha1);
    const exclude = readFileSync(join(git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude')), 'utf8');
    expect(exclude.split('\n')).toContain('.pr-shepherd/');
    mkdirSync(join(wt, '.pr-shepherd'));
    writeFileSync(join(wt, '.pr-shepherd', 'notes.md'), 'n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(rows).toMatchObject([{ kind: 'shepherd', repo: 'acme/widget', number: 1, path: wt }]);

    // The agent can commit and push the head branch.
    writeFileSync(join(wt, 'b.txt'), 'x\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-qm', 'agent fix');
    git(wt, 'push', '-q');
    expect(git(origin, 'rev-parse', 'feat')).toBe(git(wt, 'rev-parse', 'HEAD'));

    // Reuse: same path, work preserved, exclude not duplicated.
    const excludeFile = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
    writeFileSync(join(wt, 'wip.txt'), 'wip');
    expect(await repos.ensureWorktree('shepherd', ref, 'feat')).toBe(wt);
    expect(existsSync(join(wt, 'wip.txt'))).toBe(true);
    expect(await repos.ensureWorktree('shepherd', ref, 'feat')).toBe(wt);
    const exclude2 = readFileSync(excludeFile, 'utf8').split('\n');
    expect(exclude2.filter((l) => l === '.pr-shepherd/')).toHaveLength(1);
    expect(rows).toHaveLength(1);

    // Restore origin for other tests.
    git(origin, 'update-ref', 'refs/heads/feat', prSha1);
  });

  it('review worktree: detached at PR head, refreshed to the latest head', async () => {
    const { store } = fakeStore();
    const repos = mk(store);
    const wt = await repos.ensureWorktree('review', ref, 'ignored');
    expect(wt).toBe(join(dataDir, 'review-worktrees', 'acme-widget-1'));
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha1);

    // New push to the PR (via a temp branch in origin), plus local junk in the review worktree.
    git(origin, 'checkout', '-q', 'feat');
    writeFileSync(join(origin, 'a.txt'), 'round2\n');
    git(origin, 'commit', '-qam', 'round2');
    const sha2 = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'update-ref', 'refs/pull/1/head', sha2);
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(wt, 'a.txt'), 'local edit');
    writeFileSync(join(wt, 'untracked.txt'), 'x');
    mkdirSync(join(wt, '.pr-shepherd'));
    writeFileSync(join(wt, '.pr-shepherd', 'notes.md'), 'keep');

    expect(await repos.refreshReviewWorktree(ref)).toBe(wt);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(sha2);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('round2\n');
    expect(existsSync(join(wt, 'untracked.txt'))).toBe(false);
    expect(readFileSync(join(wt, '.pr-shepherd', 'notes.md'), 'utf8')).toBe('keep');

    git(origin, 'update-ref', 'refs/pull/1/head', prSha1);
    git(origin, 'update-ref', 'refs/heads/feat', prSha1);
  });

  it('refreshReviewWorktree creates the worktree when missing', async () => {
    const { store, rows } = fakeStore();
    const wt = await mk(store).refreshReviewWorktree(ref);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha1);
    expect(rows).toMatchObject([{ kind: 'review' }]);
  });

  it('cleanup: removes worktree, local branch, pr ref and tmp; marks cleaned', async () => {
    const { store, rows } = fakeStore();
    const repos = mk(store);
    const wt = await repos.ensureWorktree('shepherd', ref, 'feat');
    const review = await repos.ensureWorktree('review', ref, '');
    writeFileSync(join(wt, 'dirty.txt'), 'x');
    const tmp = join(dataDir, 'tmp', 'shepherd-acme-widget-1');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'f'), 'x');
    const mirror = join(dataDir, 'repos', 'acme', 'widget.git');

    await repos.cleanup('shepherd', ref);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(git(mirror, 'branch', '--list', 'feat')).toBe('');
    expect(git(mirror, 'worktree', 'list')).not.toContain(wt);
    expect(rows.find((r) => r.kind === 'shepherd')!.cleanedAt).toBeInstanceOf(Date);
    // The review worktree is untouched.
    expect(existsSync(review)).toBe(true);
    expect(rows.find((r) => r.kind === 'review')!.cleanedAt).toBeNull();

    await repos.cleanup('review', ref);
    expect(existsSync(review)).toBe(false);
    expect(() => git(mirror, 'rev-parse', '--verify', '-q', 'refs/remotes/pr/1')).toThrow();

    // Idempotent-ish: once cleaned it is no longer registered, so a second call refuses.
    await expect(repos.cleanup('review', ref)).rejects.toThrow(/no live workspace/);
  });

  it('cleanup refuses unregistered PRs and paths outside the worktree roots', async () => {
    const { store, rows } = fakeStore();
    const repos = mk(store);
    await expect(repos.cleanup('shepherd', { repo: 'acme/widget', number: 9 })).rejects.toThrow(/no live workspace/);

    const victim = join(root, 'victim');
    mkdirSync(victim, { recursive: true });
    for (const path of [victim, join(dataDir, 'worktrees'), join(dataDir, 'worktrees', '..', 'repos'), join(dataDir, 'review-worktrees', 'x')]) {
      rows.length = 0;
      rows.push({ id: 1, kind: 'shepherd', repo: 'acme/widget', number: 9, path, lastUsedAt: new Date(), cleanedAt: null });
      await expect(repos.cleanup('shepherd', { repo: 'acme/widget', number: 9 })).rejects.toThrow(/refusing/);
    }
    expect(existsSync(victim)).toBe(true);
  });

  it('rejects unsafe repo names and head refs', async () => {
    const { store } = fakeStore();
    const repos = mk(store);
    await expect(repos.ensureWorktree('review', { repo: '../etc', number: 1 }, '')).rejects.toThrow(/invalid repo/);
    await expect(repos.ensureWorktree('review', { repo: 'a/..', number: 1 }, '')).rejects.toThrow(/invalid repo/);
    await expect(repos.ensureWorktree('shepherd', ref, '--upload-pack=x')).rejects.toThrow(/invalid head ref/);
  });

  it('review worktrees use their own mirror; repository hooks never run for harness git', async () => {
    const { store } = fakeStore();
    const repos = mk(store);
    const wt = await repos.ensureWorktree('shepherd', ref, 'feat');
    const review = await repos.ensureWorktree('review', ref, '');
    expect(git(review, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(join(dataDir, 'review-repos', 'acme', 'widget.git'));
    expect(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(join(dataDir, 'repos', 'acme', 'widget.git'));

    const marker = join(root, `hook-ran-${n}`);
    const hook = join(dataDir, 'repos', 'acme', 'widget.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await repos.cleanup('shepherd', ref);
    await repos.ensureWorktree('shepherd', ref, 'feat');
    expect(existsSync(marker)).toBe(false);
  });

});

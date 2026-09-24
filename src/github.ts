// GitHub via the gh CLI (DESIGN §2.4, §5.2, §5.8, §6.5, §7.2). Metadata reads, merge, G3 reviews, gh_read proxy.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Exec, GithubPort, GithubReview, PrMeta, PrRef } from './contracts.js';
import { log } from './log.js';

const EXEC_TIMEOUT_MS = 60_000;
const TOKEN_CACHE_MS = 60 * 60 * 1000;
const TOKEN_CACHE_MAX = 256;
const STATES_BATCH = 100;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          // Only the subcommand goes into the message; args may carry request bodies.
          const what = [cmd, ...args.slice(0, 2)].join(' ');
          reject(new Error(`${what} failed: ${(stderr || err.message).trim()}`));
        } else resolve({ stdout, stderr });
      },
    );
    // Always close stdin so tools that optionally read it (gh --body-file -) never hang.
    child.stdin?.end(opts.input ?? '');
  });

// Removes the handoff block (DESIGN §6.1) from a PR body; used for the squash-merge body.
export function stripHandoff(body: string): string {
  return body
    .replace(/<!--\s*pr-shepherd:handoff v1[\s\S]*?<!--\s*\/pr-shepherd:handoff\s*-->[ \t]*\r?\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function checkRepo(repo: string): [string, string] {
  if (!REPO_RE.test(repo) || repo.includes('..')) throw new Error(`invalid repo ${JSON.stringify(repo)}`);
  const [owner, name] = repo.split('/') as [string, string];
  return [owner, name];
}

const PR_META_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  state isDraft title body headRefName headRefOid authorAssociation author{login}}}}`;

type PrNode = {
  state: PrMeta['state']; isDraft: boolean; title: string; body: string; headRefName: string; headRefOid: string;
  authorAssociation: string; author: { login: string } | null;
};

// ---------- gh_read allowlist (DESIGN §7.2) ----------

const READ_SUBCOMMANDS: Record<string, string[] | '*'> = {
  pr: ['view', 'diff', 'checks', 'list'],
  issue: ['view', 'list'],
  repo: ['view'],
  run: ['view', 'list'],
  search: '*',
};
const BANNED_FLAGS = new Set(['--web', '-w', '--watch', '--hostname']);
const API_BODY_FLAGS = ['--field', '--raw-field', '--input'];
// gh api shorthands: -i --include; -X method, -H header, -q jq, -t template, -p preview, -f/-F fields.
const SHORT_BOOL = new Set(['i']);
const LONG_BOOL = new Set(['--include', '--paginate', '--silent', '--slurp', '--verbose']);
const LONG_VALUE = new Set(['--method', '--header', '--jq', '--template', '--preview', '--cache']);
const SHORT_VALUE = new Set(['X', 'H', 'q', 't', 'p', 'f', 'F']);

// Returns an error message, or null when the invocation is read-only.
export function checkGhRead(args: string[]): string | null {
  const [cmd, sub] = args;
  if (!cmd) return 'gh_read: missing command';
  if (cmd === 'api') return checkApi(args.slice(1));
  const subs = READ_SUBCOMMANDS[cmd];
  if (!subs) return `gh_read: "${cmd}" is not allowed; allowed: pr view|diff|checks|list, issue view|list, repo view, search, run view|list, api (GET)`;
  if (subs !== '*' && (!sub || !subs.includes(sub))) return `gh_read: "${cmd} ${sub ?? ''}" is not allowed; allowed: ${cmd} ${subs.join('|')}`;
  for (const a of args) {
    const flag = a.split('=', 1)[0]!;
    if (BANNED_FLAGS.has(flag)) return `gh_read: flag ${flag} is not allowed`;
  }
  return null;
}

function checkApi(rest: string[]): string | null {
  if (!rest[0] || rest[0].startsWith('-')) return 'gh_read: api needs an endpoint path first';
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') return 'gh_read: "--" is not allowed in api';
    if (a.startsWith('--')) {
      const [flag, inline] = splitLong(a);
      if (API_BODY_FLAGS.includes(flag)) return `gh_read: api ${flag} is not allowed (read-only)`;
      if (LONG_BOOL.has(flag)) continue;
      if (!LONG_VALUE.has(flag)) return `gh_read: api flag ${flag} is not allowed`;
      // Consume the value so a flag-looking value can't hide the next arg from this scan.
      const v = inline ?? rest[++i] ?? '';
      if (flag === '--method' && v.toUpperCase() !== 'GET') return `gh_read: api --method ${v} is not allowed (GET only)`;
      if (flag === '--header' && /method-override/i.test(v)) return 'gh_read: method override headers are not allowed';
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // pflag shorthand cluster, e.g. -iXPOST or -q.title: booleans until the first value-taking flag,
      // whose value is the rest of the cluster or the next arg.
      for (let k = 1; k < a.length; k++) {
        const c = a[k]!;
        if (SHORT_BOOL.has(c)) continue;
        if (!SHORT_VALUE.has(c)) return `gh_read: api flag -${c} is not allowed`;
        if (c === 'f' || c === 'F') return `gh_read: api -${c} is not allowed (read-only)`;
        const v = a.slice(k + 1) || rest[++i] || '';
        if (c === 'X' && v.toUpperCase() !== 'GET') return `gh_read: api -X ${v} is not allowed (GET only)`;
        if (c === 'H' && /method-override/i.test(v)) return 'gh_read: method override headers are not allowed';
        break;
      }
    }
  }
  return null;
}

// gh_read runs with my token, which reads every repo I can; a G3 run may only read the PR's own repo (DESIGN §7.2).
// Returns an error message, or null. Non-api commands must name the repo (--repo or a URL): the harness's cwd
// is not the PR's checkout.
// G3 gh_read scope (DESIGN §7.2): any repo in the org, nothing outside it. Every command must name its repo
// (--repo, a github.com URL, `repo view <repo>`, an `api repos/<org>/...` path, or an org-scoped search).
export function checkGhScope(args: string[], org: string): string | null {
  const want = org.toLowerCase();
  const deny = `gh_read: only ${org}/* repositories are readable from this review`;
  const norm = (v: string) => v.toLowerCase().replace(/^(?:https?:\/\/)?github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const inOrg = (v: string) => /^[\w.-]+\/[\w.-]+$/.test(norm(v)) && norm(v).split('/')[0] === want;
  let named = false;
  for (const a of args) {
    for (const m of a.matchAll(/github\.com[/:]([\w.-]+\/[\w.-]+)/gi)) {
      if (!inOrg(m[1]!)) return deny;
      named = true;
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let v: string | undefined;
    if (a === '--repo' || a === '-R') v = args[i + 1] ?? '';
    else if (a.startsWith('--repo=')) v = a.slice('--repo='.length);
    else if (a.startsWith('-R') && a.length > 2) v = a.slice(2).replace(/^=/, '');
    if (v === undefined) continue;
    if (!inOrg(v)) return deny;
    named = true;
  }
  const [cmd, sub] = args;
  if (cmd === 'api') {
    const endpoint = (args[1] ?? '').replace(/^\/+/, '').split('?')[0]!.toLowerCase();
    return endpoint.startsWith(`repos/${want}/`) ? null : `${deny} (api endpoints must start with repos/${org}/)`;
  }
  if (cmd === 'repo' && sub === 'view') {
    const target = args.slice(2).find((a) => !a.startsWith('-'));
    if (target !== undefined) {
      if (!inOrg(target)) return deny;
      named = true;
    }
  }
  if (cmd === 'search') {
    // Qualifiers may only point inside the org; the search itself must be scoped (--repo, --owner or an org/repo qualifier).
    for (const a of args) {
      for (const m of a.matchAll(/(?:^|\s)-?(repo|org|user|owner):(\S+)/gi)) {
        const [kind, val] = [m[1]!.toLowerCase(), m[2]!.toLowerCase()];
        if (kind === 'repo' ? !inOrg(val) : val !== want) return deny;
        named = true;
      }
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const v = a === '--owner' ? args[i + 1] : a.startsWith('--owner=') ? a.slice('--owner='.length) : undefined;
      if (v === undefined) continue;
      if (v.toLowerCase() !== want) return deny;
      named = true;
    }
    if (!named) return `${deny} (scope the search with --owner ${org} or --repo ${org}/<repo>)`;
  }
  return named ? null : `gh_read: pass --repo ${org}/<repo>`;
}

function splitLong(a: string): [string, string | undefined] {
  const eq = a.indexOf('=');
  return eq < 0 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)];
}

// ---------- factory ----------

export function createGithub(opts: {
  config: Config;
  exec?: Exec;
  fetch?: typeof fetch;
  now?: () => number;
}): GithubPort {
  const exec = opts.exec ?? defaultExec;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const tokenCache = new Map<string, { ok: boolean; at: number }>();
  let loginP: Promise<string> | undefined;

  const gh = (args: string[], input?: string) => exec('gh', args, { input, timeoutMs: EXEC_TIMEOUT_MS });

  async function graphql<T>(query: string, vars: Record<string, string | number> = {}): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
    const { stdout } = await gh(args);
    const res = JSON.parse(stdout) as { data?: T; errors?: { message: string }[] };
    if (!res.data) throw new Error(`graphql: ${res.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    return res.data;
  }

  return {
    async verifyOwnerToken(token) {
      if (!token) return false;
      const key = createHash('sha256').update(token).digest('hex');
      const hit = tokenCache.get(key);
      if (hit && now() - hit.at < TOKEN_CACHE_MS) return hit.ok;
      let res: Response;
      try {
        res = await doFetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pr-shepherd' },
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'verifyOwnerToken: GitHub unreachable');
        return false; // not cached: transient
      }
      let ok = false;
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { login?: string };
        ok = body.login === opts.config.owner.github;
      } else if (res.status >= 500 || res.status === 429) {
        return false; // transient; don't cache
      }
      // Bounded: /prs is public, so random tokens must not grow the cache without limit.
      const t = now();
      for (const [k, v] of tokenCache) if (t - v.at >= TOKEN_CACHE_MS) tokenCache.delete(k);
      // Maps iterate in insertion order: drop the oldest when full.
      while (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value!);
      tokenCache.set(key, { ok, at: t });
      return ok;
    },

    async prMeta(ref) {
      const [owner, name] = checkRepo(ref.repo);
      const data = await graphql<{ repository: { pullRequest: PrNode | null } | null }>(PR_META_QUERY, { owner, name, number: ref.number });
      const pr = data.repository?.pullRequest;
      if (!pr) throw new Error(`PR ${ref.repo}#${ref.number} not found`);
      return {
        repo: ref.repo,
        number: ref.number,
        state: pr.state,
        author: pr.author?.login ?? '',
        isDraft: pr.isDraft,
        title: pr.title,
        body: pr.body,
        headRef: pr.headRefName,
        headSha: pr.headRefOid,
        authorIsOrgMember: pr.authorAssociation === 'MEMBER' || pr.authorAssociation === 'OWNER',
      };
    },

    async prStates(refs) {
      const out = new Map<string, PrMeta['state']>();
      const uniq = [...new Map(refs.map((r) => [`${r.repo}#${r.number}`, r])).values()];
      for (let i = 0; i < uniq.length; i += STATES_BATCH) {
        const batch = uniq.slice(i, i + STATES_BATCH);
        const parts = batch.map((r, j) => {
          const [owner, name] = checkRepo(r.repo);
          if (!Number.isInteger(r.number) || r.number <= 0) throw new Error(`invalid PR number ${r.number}`);
          return `p${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${r.number}) { state } }`;
        });
        const data = await graphql<Record<string, { pullRequest: { state: PrMeta['state'] } | null } | null>>(`query { ${parts.join('\n')} }`);
        batch.forEach((r, j) => {
          const state = data[`p${j}`]?.pullRequest?.state;
          if (state) out.set(`${r.repo}#${r.number}`, state);
        });
      }
      return out;
    },

    async merge(ref, sha, subject, body) {
      checkRepo(ref.repo);
      try {
        await gh(
          ['pr', 'merge', String(ref.number), '--repo', ref.repo, '--squash', '--delete-branch', '--match-head-commit', sha, '--subject', subject, '--body-file', '-'],
          body,
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async postReview(ref: PrRef, review: GithubReview) {
      const [owner, name] = checkRepo(ref.repo);
      const payload: Record<string, unknown> = {
        event: review.event,
        body: review.body,
        comments: (review.comments ?? []).map((c) => ({ path: c.path, line: c.line, body: c.body, side: 'RIGHT' })),
      };
      if (review.commitId) payload.commit_id = review.commitId;
      const { stdout } = await gh(['api', `repos/${owner}/${name}/pulls/${ref.number}/reviews`, '--method', 'POST', '--input', '-'], JSON.stringify(payload));
      const url = (JSON.parse(stdout) as { html_url?: string }).html_url;
      if (!url) throw new Error('postReview: response has no html_url');
      return { url };
    },

    async comment(ref, body) {
      checkRepo(ref.repo);
      await gh(['pr', 'comment', String(ref.number), '--repo', ref.repo, '--body-file', '-'], body);
    },

    async ghRead(args) {
      const err = checkGhRead(args);
      if (err) throw new Error(err);
      const { stdout } = await gh(args);
      return stdout;
    },

    login() {
      loginP ??= gh(['api', 'user', '--jq', '.login']).then(
        ({ stdout }) => stdout.trim(),
        (e) => {
          loginP = undefined;
          throw e;
        },
      );
      return loginP;
    },
  };
}

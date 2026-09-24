import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { Exec } from '../src/contracts.js';
import { checkGhRead, checkGhScope, createGithub, defaultExec, stripHandoff } from '../src/github.js';

const config = { owner: { github: 'owner-login', slack: 'U1' } } as Config;

type Call = { cmd: string; args: string[]; input?: string };
function fakeExec(respond: (c: Call) => string | Error = () => '') {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const c = { cmd, args, input: opts?.input };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return { stdout: r, stderr: '' };
  };
  return { exec, calls };
}

describe('stripHandoff', () => {
  it('removes the handoff block including the ### Handoff section', () => {
    const body = [
      'Fixes the flaky retry.',
      '',
      '<!-- pr-shepherd:handoff v1',
      'agent: claude-code',
      'session: abc',
      '-->',
      '### Handoff',
      '**Intent**: x',
      '**Rejected**: -',
      '<!-- /pr-shepherd:handoff -->',
      '',
      '## Test plan',
      '- unit',
    ].join('\n');
    expect(stripHandoff(body)).toBe('Fixes the flaky retry.\n\n## Test plan\n- unit');
  });
  it('leaves bodies without a block alone', () => {
    expect(stripHandoff('hello\n\nworld')).toBe('hello\n\nworld');
  });
  it('handles a body that is only the block', () => {
    expect(stripHandoff('<!-- pr-shepherd:handoff v1\n-->\n### Handoff\n<!-- /pr-shepherd:handoff -->\n')).toBe('');
  });
  it('never pairs mismatched markers', () => {
    const mismatched = 'a\n<!-- pr-shepherd:handoff v1\n-->\nx\n<!-- /other:handoff -->\nb';
    expect(stripHandoff(mismatched)).toBe(mismatched);
  });
});

describe('defaultExec', () => {
  it('runs without a shell, passes stdin, and rejects with stderr', async () => {
    const r = await defaultExec('cat', [], { input: 'a $(b) c' });
    expect(r.stdout).toBe('a $(b) c');
    await expect(defaultExec('sh', ['-c', 'echo boom >&2; exit 3'])).rejects.toThrow(/boom/);
  });
});

describe('prMeta', () => {
  it('parses one GraphQL call', async () => {
    const { exec, calls } = fakeExec(() =>
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              state: 'OPEN', isDraft: false, title: 'T', body: 'B', headRefName: 'feat', headRefOid: 'abc',
              authorAssociation: 'MEMBER', author: { login: 'owner-login' },
            },
          },
        },
      }),
    );
    const gh = createGithub({ config, exec });
    const m = await gh.prMeta({ repo: 'your-org/example-cli', number: 271 });
    expect(m).toEqual({
      repo: 'your-org/example-cli', number: 271, state: 'OPEN', author: 'owner-login', isDraft: false, title: 'T', body: 'B',
      headRef: 'feat', headSha: 'abc', authorIsOrgMember: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]!.args).toContain('owner=your-org');
    expect(calls[0]!.args).toContain('number=271');
  });
  it('flags non-members and missing PRs', async () => {
    const node = { state: 'OPEN', isDraft: true, title: '', body: '', headRefName: 'x', headRefOid: 'y', authorAssociation: 'CONTRIBUTOR', author: null };
    let pr: unknown = node;
    const { exec } = fakeExec(() => JSON.stringify({ data: { repository: { pullRequest: pr } } }));
    const gh = createGithub({ config, exec });
    const m = await gh.prMeta({ repo: 'o/r', number: 1 });
    expect(m.authorIsOrgMember).toBe(false);
    expect(m.author).toBe('');
    pr = null;
    await expect(gh.prMeta({ repo: 'o/r', number: 1 })).rejects.toThrow(/not found/);
  });
  it('rejects bad repo names before calling gh', async () => {
    const { exec, calls } = fakeExec();
    const gh = createGithub({ config, exec });
    await expect(gh.prMeta({ repo: 'o/r"){x}', number: 1 })).rejects.toThrow(/invalid repo/);
    expect(calls).toHaveLength(0);
  });
});

describe('prStates', () => {
  it('batches 100 per query with aliases and keys by repo#n', async () => {
    const { exec, calls } = fakeExec((c) => {
      const q = c.args[3]!;
      const aliases = [...q.matchAll(/(p\d+): repository/g)].map((m) => m[1]!);
      const data: Record<string, unknown> = {};
      for (const a of aliases) data[a] = { pullRequest: { state: a === 'p0' ? 'MERGED' : 'OPEN' } };
      data.p1 = { pullRequest: null }; // missing PR → omitted
      return JSON.stringify({ data });
    });
    const gh = createGithub({ config, exec });
    const refs = Array.from({ length: 150 }, (_, i) => ({ repo: 'o/r', number: i + 1 }));
    const m = await gh.prStates([...refs, refs[0]!]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[3]).toContain('p99: repository(owner: "o", name: "r") { pullRequest(number: 100)');
    expect(calls[0]!.args[3]).not.toContain('p100:');
    expect(m.get('o/r#1')).toBe('MERGED');
    expect(m.get('o/r#101')).toBe('MERGED');
    expect(m.has('o/r#2')).toBe(false);
    expect(m.get('o/r#3')).toBe('OPEN');
    expect(m.size).toBe(148);
  });
  it('empty input makes no call; gh failure throws', async () => {
    const { exec, calls } = fakeExec(() => new Error('gh api graphql failed: rate limited'));
    const gh = createGithub({ config, exec });
    expect((await gh.prStates([])).size).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(gh.prStates([{ repo: 'o/r', number: 1 }])).rejects.toThrow(/rate limited/);
  });
});

describe('merge / postReview / comment / login', () => {
  it('merge: squash, delete branch, SHA lock, body on stdin', async () => {
    const { exec, calls } = fakeExec();
    const gh = createGithub({ config, exec });
    expect(await gh.merge({ repo: 'o/r', number: 5 }, 'abc123', 'Fix it (#5)', 'body `x`')).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      cmd: 'gh',
      args: ['pr', 'merge', '5', '--repo', 'o/r', '--squash', '--delete-branch', '--match-head-commit', 'abc123', '--subject', 'Fix it (#5)', '--body-file', '-'],
      input: 'body `x`',
    });
  });
  it('merge: gh failure becomes {ok:false}', async () => {
    const { exec } = fakeExec(() => new Error('gh pr merge failed: Head branch was modified'));
    const gh = createGithub({ config, exec });
    const r = await gh.merge({ repo: 'o/r', number: 5 }, 'abc', 's', 'b');
    expect(r).toEqual({ ok: false, error: 'gh pr merge failed: Head branch was modified' });
  });
  it('postReview: POSTs JSON via stdin with RIGHT-side comments', async () => {
    const { exec, calls } = fakeExec(() => JSON.stringify({ html_url: 'https://github.com/o/r/pull/5#pullrequestreview-1' }));
    const gh = createGithub({ config, exec });
    const r = await gh.postReview({ repo: 'o/r', number: 5 }, {
      event: 'COMMENT', body: 'B', commitId: 'sha1', comments: [{ path: 'a.ts', line: 3, body: 'x' }],
    });
    expect(r.url).toBe('https://github.com/o/r/pull/5#pullrequestreview-1');
    expect(calls[0]!.args).toEqual(['api', 'repos/o/r/pulls/5/reviews', '--method', 'POST', '--input', '-']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({
      event: 'COMMENT', body: 'B', commit_id: 'sha1', comments: [{ path: 'a.ts', line: 3, body: 'x', side: 'RIGHT' }],
    });
  });
  it('postReview: APPROVE without commit id omits commit_id', async () => {
    const { exec, calls } = fakeExec(() => JSON.stringify({ html_url: 'u' }));
    await createGithub({ config, exec }).postReview({ repo: 'o/r', number: 5 }, { event: 'APPROVE', body: 'LGTM' });
    expect(JSON.parse(calls[0]!.input!)).toEqual({ event: 'APPROVE', body: 'LGTM', comments: [] });
  });
  it('comment uses gh pr comment with stdin body', async () => {
    const { exec, calls } = fakeExec();
    await createGithub({ config, exec }).comment({ repo: 'o/r', number: 5 }, 'hi');
    expect(calls[0]).toEqual({ cmd: 'gh', args: ['pr', 'comment', '5', '--repo', 'o/r', '--body-file', '-'], input: 'hi' });
  });
  it('login is cached, and retried after a failure', async () => {
    let fail = true;
    const { exec, calls } = fakeExec(() => (fail ? new Error('down') : 'owner-login\n'));
    const gh = createGithub({ config, exec });
    await expect(gh.login()).rejects.toThrow('down');
    fail = false;
    expect(await gh.login()).toBe('owner-login');
    expect(await gh.login()).toBe('owner-login');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(['api', 'user', '--jq', '.login']);
  });
});

describe('verifyOwnerToken', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it('true iff login matches owner; cached by hash for 1h', async () => {
    let t = 0;
    const fetchFn = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === 'Bearer good' ? res(200, { login: 'owner-login' }) : res(200, { login: 'someone' });
    });
    const gh = createGithub({ config, exec: fakeExec().exec, fetch: fetchFn as typeof fetch, now: () => t });
    expect(await gh.verifyOwnerToken('good')).toBe(true);
    expect(await gh.verifyOwnerToken('good')).toBe(true);
    expect(await gh.verifyOwnerToken('other')).toBe(false);
    expect(await gh.verifyOwnerToken('other')).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.github.com/user');
    t = 60 * 60 * 1000 + 1;
    expect(await gh.verifyOwnerToken('good')).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('401 is false and cached; network errors and 5xx are false and not cached', async () => {
    const seq: (() => Response)[] = [() => res(401, {}), () => { throw new Error('ECONNRESET'); }, () => res(502, {}), () => res(200, { login: 'owner-login' })];
    const fetchFn = vi.fn(async () => seq.shift()!());
    const gh = createGithub({ config, exec: fakeExec().exec, fetch: fetchFn as unknown as typeof fetch });
    expect(await gh.verifyOwnerToken('bad')).toBe(false);
    expect(await gh.verifyOwnerToken('bad')).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await gh.verifyOwnerToken('t2')).toBe(false);
    expect(await gh.verifyOwnerToken('t2')).toBe(false);
    expect(await gh.verifyOwnerToken('t2')).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
  it('empty token is rejected without a request', async () => {
    const fetchFn = vi.fn();
    const gh = createGithub({ config, exec: fakeExec().exec, fetch: fetchFn as unknown as typeof fetch });
    expect(await gh.verifyOwnerToken('')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('ghRead allowlist', () => {
  const allowed = [
    ['pr', 'view', '5', '--repo', 'o/r', '--json', 'title,body'],
    ['pr', 'view', '5', '--comments'],
    ['pr', 'diff', '5', '-R', 'o/r'],
    ['pr', 'checks', '5'],
    ['pr', 'list', '--author', 'x'],
    ['issue', 'view', '12'],
    ['issue', 'list', '--label', 'bug'],
    ['repo', 'view', 'o/r'],
    ['search', 'code', 'foo', '--repo', 'o/r'],
    ['search', 'prs', '--author', 'x'],
    ['run', 'view', '123', '--log-failed'],
    ['run', 'list', '--branch', 'feat'],
    ['api', 'repos/o/r/pulls/5/comments'],
    ['api', 'repos/o/r/pulls/5/reviews', '--paginate', '--jq', '.[].body'],
    ['api', 'repos/o/r/pulls/5', '-X', 'GET'],
    ['api', 'repos/o/r/pulls/5', '-XGET'],
    ['api', 'repos/o/r/pulls/5', '--method', 'get'],
    ['api', 'repos/o/r/pulls/5', '--method=GET'],
    ['api', 'repos/o/r/pulls/5', '-q', '.title'],
    ['api', 'repos/o/r/pulls/5', '-q.files'],
    ['api', 'repos/o/r/pulls/5', '-i', '-H', 'Accept: application/vnd.github.diff'],
    ['api', 'repos/o/r/contents/a.ts', '--header=Accept: application/vnd.github.raw'],
  ];
  const rejected = [
    [],
    ['pr', 'merge', '5'],
    ['pr', 'comment', '5', '--body', 'x'],
    ['pr', 'review', '5', '--approve'],
    ['pr', 'edit', '5'],
    ['pr', 'close', '5'],
    ['pr', 'checkout', '5'],
    ['pr'],
    ['pr', 'view', '5', '--web'],
    ['pr', 'checks', '5', '--watch'],
    ['issue', 'create'],
    ['issue', 'comment', '1'],
    ['repo', 'delete', 'o/r'],
    ['repo', 'clone', 'o/r'],
    ['run', 'rerun', '1'],
    ['run', 'cancel', '1'],
    ['workflow', 'run', 'x'],
    ['secret', 'list'],
    ['auth', 'token'],
    ['auth', 'status'],
    ['config', 'set', 'x', 'y'],
    ['release', 'create'],
    ['gist', 'create'],
    ['extension', 'install', 'x'],
    ['alias', 'set', 'x', 'y'],
    ['api'],
    ['api', '--method', 'GET', 'repos/o/r'],
    ['api', 'repos/o/r/issues', '-X', 'POST'],
    ['api', 'repos/o/r/issues', '-XPOST'],
    ['api', 'repos/o/r/issues', '-iXPOST'],
    ['api', 'repos/o/r/issues', '--method', 'DELETE'],
    ['api', 'repos/o/r/issues', '--method=PATCH'],
    ['api', 'repos/o/r/issues', '-X'],
    ['api', 'repos/o/r/issues', '-f', 'title=x'],
    ['api', 'repos/o/r/issues', '-ftitle=x'],
    ['api', 'repos/o/r/issues', '-F', 'n=1'],
    ['api', 'repos/o/r/issues', '-if', 'title=x'],
    ['api', 'repos/o/r/issues', '--field', 'a=1'],
    ['api', 'repos/o/r/issues', '--field=a=1'],
    ['api', 'repos/o/r/issues', '--raw-field', 'a=1'],
    ['api', 'repos/o/r/issues', '--input', 'x.json'],
    ['api', 'repos/o/r/issues', '--input=-'],
    ['api', 'graphql', '-f', 'query=mutation{x}'],
    ['api', 'repos/o/r/issues', '-X', 'GET', '-f', 'a=1'],
    ['api', 'repos/o/r/issues', '--jq', '-q', '-fa=1'], // value consumed correctly, so -fa=1 is still seen
    ['api', 'repos/o/r/issues', '-q', '.x', '-Fa=1'],
    ['api', 'repos/o/r/issues', '-H', 'X-HTTP-Method-Override: DELETE'],
    ['api', 'repos/o/r/issues', '--hostname', 'evil.example'],
    ['api', 'repos/o/r/issues', '--unknown-flag'],
    ['api', 'repos/o/r/issues', '-z'],
    ['api', 'repos/o/r/issues', '--', '-f'],
  ];
  it.each(allowed.map((a) => [a.join(' '), a]))('allows: %s', (_n, a) => {
    expect(checkGhRead(a as string[])).toBeNull();
  });
  it.each(rejected.map((a) => [a.join(' ') || '(empty)', a]))('rejects: %s', (_n, a) => {
    expect(checkGhRead(a as string[])).toMatch(/^gh_read: /);
  });
  it('ghRead runs allowed commands and throws on rejected ones without running gh', async () => {
    const { exec, calls } = fakeExec(() => 'out');
    const gh = createGithub({ config, exec });
    expect(await gh.ghRead(['pr', 'view', '5'])).toBe('out');
    await expect(gh.ghRead(['pr', 'merge', '5'])).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([{ cmd: 'gh', args: ['pr', 'view', '5'], input: undefined }]);
  });
});

describe('review-fix regressions', () => {
  it('verifyOwnerToken cache stays bounded under a spray of random tokens', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const gh = createGithub({ config, exec: fakeExec().exec, fetch: fetchFn as unknown as typeof fetch });
    for (let i = 0; i < 300; i++) await gh.verifyOwnerToken(`t${i}`);
    // the oldest entries were evicted, so t0 is looked up again; the newest is still cached
    await gh.verifyOwnerToken('t0');
    await gh.verifyOwnerToken('t299');
    expect(fetchFn).toHaveBeenCalledTimes(301);
  });

  it('checkGhScope allows any repo in the org and nothing outside it', () => {
    const ok = [
      ['pr', 'view', '5', '--repo', 'your-org/example-cli', '--json', 'reviews'],
      ['pr', 'view', '528', '--repo', 'your-org/example-api'],
      ['pr', 'diff', '5', '-R', 'YOUR-ORG/cli'],
      ['pr', 'view', 'https://github.com/your-org/example-e2e/pull/141'],
      ['api', 'repos/your-org/example-cli/pulls/5/comments'],
      ['api', '/repos/your-org/example-api/contents/src/a.ts'],
      ['run', 'view', '123', '--log', '--repo=your-org/example-cli'],
      ['repo', 'view', 'your-org/example-cli'],
      ['search', 'prs', 'fix', '--repo', 'your-org/example-cli'],
      ['search', 'code', 'feedbackAssertion', '--owner', 'your-org'],
      ['search', 'prs', 'delegated zones org:your-org'],
      ['search', 'code', 'x repo:your-org/example-api'],
    ];
    for (const a of ok) expect(checkGhScope(a, 'your-org'), a.join(' ')).toBeNull();
    const bad = [
      ['api', 'repos/Other/private-infra/contents/secrets.env'],
      ['api', 'repos/your-org'],
      ['api', 'gists'],
      ['api', 'user'],
      ['api', 'graphql'],
      ['pr', 'view', '5', '--repo', 'Other/x'],
      ['pr', 'view', 'https://github.com/Other/x/pull/1'],
      ['pr', 'view', '5'],
      ['repo', 'view', 'Other/x'],
      ['search', 'code', 'secret org:Other', '--repo', 'your-org/example-cli'],
      ['search', 'code', 'secret user:someone', '--owner', 'your-org'],
      ['search', 'code', 'secret', '--owner', 'Other'],
      ['search', 'code', 'secret'],
      ['issue', 'list', '-ROther/x'],
    ];
    for (const a of bad) expect(checkGhScope(a, 'your-org'), a.join(' ')).not.toBeNull();
  });
});

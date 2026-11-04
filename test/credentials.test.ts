import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (a: unknown) => query(a) }));
const ghOut = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: ghOut() as string, stderr: '' }),
}));
const { checkClaude, checkGithub } = await import('../src/credentials.js');

async function* result(subtype: string) {
  yield { type: 'result', subtype };
}

describe('checkClaude', () => {
  beforeEach(() => query.mockReset());

  it('checks the configured model, so a retired model fails the check', async () => {
    query.mockReturnValue(result('success'));
    const r = await checkClaude('claude-opus-5-5');
    expect(query.mock.calls[0]![0].options.model).toBe('claude-opus-5-5');
    expect(r).toMatchObject({ ok: true, detail: 'claude-opus-5-5: result=success' });
  });

  it('leaves the model to Claude Code when none is configured', async () => {
    query.mockReturnValue(result('success'));
    await checkClaude();
    expect(query.mock.calls[0]![0].options).not.toHaveProperty('model');
  });

  it('reports which model failed', async () => {
    query.mockReturnValue(
      (async function* () {
        throw new Error('model not found');
      })(),
    );
    const r = await checkClaude('claude-old-1');
    expect(r).toMatchObject({ ok: false, detail: 'claude check failed (claude-old-1): model not found' });
  });
});

describe('checkGithub with an instabox Secret placeholder', () => {
  const body = '\r\n{"login":"owner"}';

  it('accepts a fine-grained token, which has no x-oauth-scopes header', async () => {
    ghOut.mockReturnValue(`HTTP/2 200\r\ngithub-authentication-token-expiration: 2027-01-01 00:00:00 UTC\r\n${body}`);
    expect(await checkGithub('owner', 'ibsec_abc')).toMatchObject({ ok: true });
  });

  it('refuses a classic or OAuth token behind the placeholder', async () => {
    ghOut.mockReturnValue(`HTTP/2 200\r\nx-oauth-scopes: repo\r\n${body}`);
    expect(await checkGithub('owner', 'ibsec_abc')).toMatchObject({ ok: false, detail: expect.stringContaining('fine-grained') });
  });

  it('still refuses a raw classic token', async () => {
    expect(await checkGithub('owner', 'ghp_abc')).toMatchObject({ ok: false });
  });
});

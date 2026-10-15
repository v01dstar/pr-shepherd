import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (a: unknown) => query(a) }));
const { checkClaude } = await import('../src/credentials.js');

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

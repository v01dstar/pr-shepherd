import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrRef } from '../src/contracts.js';
import type { RegisterResult } from '../src/control.js';
import type { CredentialStatus } from '../src/credentials.js';
import { createHttp } from '../src/http.js';

let server: Server;
let base: string;
let registered: PrRef[];
let result: RegisterResult;
let dbUp: boolean;
let creds: CredentialStatus | undefined;

beforeEach(async () => {
  registered = [];
  result = { code: 202, body: { status: 'registered', prId: 1 } };
  dbUp = true;
  creds = {
    github: { ok: true, detail: 'secret-detail', checkedAt: 't' },
    slack: { ok: true, detail: '', checkedAt: 't' },
    claude: { ok: true, detail: '', checkedAt: 't' },
  };
  server = createHttp({
    dataDir: '.',
    db: {
      query: async () => {
        if (!dbUp) throw new Error('db down');
        return { rows: [] };
      },
    },
    credentials: () => creds,
    github: { verifyOwnerToken: async (t) => t === 'good' },
    register: async (ref) => {
      registered.push(ref);
      return result;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: string, token?: string) =>
  fetch(`${base}/prs`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });

describe('POST /prs', () => {
  const body = JSON.stringify({ url: 'https://github.com/your-org/example-cli/pull/271' });

  it('registers with a valid owner token', async () => {
    const res = await post(body, 'good');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'registered', prId: 1 });
    expect(registered).toEqual([{ repo: 'your-org/example-cli', number: 271 }]);
  });

  it('401 without or with a bad token', async () => {
    expect((await post(body)).status).toBe(401);
    expect((await post(body, 'bad')).status).toBe(401);
    expect(registered).toEqual([]);
  });

  it('400 on bad JSON or a non-PR url', async () => {
    expect((await post('{', 'good')).status).toBe(400);
    expect((await post(JSON.stringify({ url: 'https://example.com' }), 'good')).status).toBe(400);
    expect((await post('null', 'good')).status).toBe(400);
  });

  it('passes through register codes', async () => {
    result = { code: 409, body: { error: 'PR is a draft' } };
    const res = await post(body, 'good');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'PR is a draft' });
  });

  it('413 over 16KB', async () => {
    const res = await post(JSON.stringify({ url: 'x'.repeat(17 * 1024) }), 'good');
    expect(res.status).toBe(413);
  });

  it('404 elsewhere; /healthz does not leak credential details', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const h = await fetch(`${base}/healthz`);
    const text = await h.text();
    expect(text).not.toContain('secret-detail');
    expect(JSON.parse(text)).toMatchObject({ db: true });
  });
});

describe('GET /livez', () => {
  it('200 when the DB answers, even before credential checks finish or when they fail', async () => {
    const failed = { ...creds!, github: { ok: false, detail: 'expired', checkedAt: 't' } };
    creds = undefined;
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    creds = failed;
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it('503 when the DB does not answer', async () => {
    dbUp = false;
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: false });
  });

  it('only GET', async () => {
    expect((await fetch(`${base}/livez`, { method: 'POST' })).status).toBe(404);
  });
});

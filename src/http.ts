// HTTP surface (DESIGN §5.2, §11): GET /livez, GET /healthz and POST /prs. TLS terminates at the platform ingress.
// /livez = process up and DB answering (platform healthcheck; not blocked by the async credential checks);
// /healthz = full readiness (DB, credentials, disk).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { statfs } from 'node:fs/promises';
import { parsePrRef } from './commands.js';
import type { Db, GithubPort, PrRef } from './contracts.js';
import type { RegisterResult } from './control.js';
import type { CredentialStatus } from './credentials.js';
import { log } from './log.js';

const MAX_BODY = 16 * 1024;

export type HttpDeps = {
  dataDir: string;
  db: Db;
  credentials: () => CredentialStatus | undefined;
  github: Pick<GithubPort, 'verifyOwnerToken'>;
  register: (ref: PrRef) => Promise<RegisterResult>;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function livez(deps: HttpDeps) {
  const db = await deps.db.query('select 1').then(() => true, () => false);
  return { status: db ? 200 : 503, body: { ok: db, db } };
}

async function healthz(deps: HttpDeps) {
  const db = await deps.db.query('select 1').then(() => true, () => false);
  const fs = await statfs(deps.dataDir).catch(() => undefined);
  const diskFreePct = fs ? Math.round((fs.bavail / fs.blocks) * 100) : null;
  const credentials = deps.credentials();
  const credsOk = !!credentials && Object.values(credentials).every((c) => c.ok);
  const ok = db && credsOk && diskFreePct !== null && diskFreePct >= 20;
  // Details only say what failed, never secret values or PR data.
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      db,
      diskFreePct,
      credentials: credentials && Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, { ok: v.ok, checkedAt: v.checkedAt, ...(v.expiresAt && { expiresAt: v.expiresAt, estimated: !!v.estimated }) }])),
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function postPrs(req: IncomingMessage, deps: HttpDeps): Promise<{ status: number; body: unknown }> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'body too large');
  // The token is only ever hashed for the cache (github.ts); never logged.
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const raw = await readBody(req);
  if (!token || !(await deps.github.verifyOwnerToken(token))) throw new HttpError(401, 'unauthorized');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const prUrl = (body as { url?: unknown } | null)?.url;
  const ref = typeof prUrl === 'string' ? parsePrRef(prUrl) : null;
  if (!ref) throw new HttpError(400, 'body must be {"url": "<GitHub PR URL>"}');
  const r = await deps.register(ref);
  return { status: r.code, body: r.body };
}

export function createHttp(deps: HttpDeps): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/livez') {
        const { status, body } = await livez(deps);
        return json(res, status, body);
      }
      if (req.method === 'GET' && path === '/healthz') {
        const { status, body } = await healthz(deps);
        return json(res, status, body);
      }
      if (req.method === 'POST' && path === '/prs') {
        const { status, body } = await postPrs(req, deps);
        return json(res, status, body);
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) {
        res.setHeader('connection', 'close');
        return json(res, e.status, { error: e.message });
      }
      log.error({ err: e, path: req.url }, 'http handler failed');
      json(res, 500, { error: 'internal error' });
    }
  });
}

export function startHttp(port: number, deps: HttpDeps): Server {
  const server = createHttp(deps);
  server.listen(port);
  return server;
}

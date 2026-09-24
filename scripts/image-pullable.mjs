#!/usr/bin/env node
// Exit 0 when <image> can be pulled anonymously — what an InstaCloud template deploy needs — else 1.
// Registry v2 protocol: HEAD the manifest, and on 401 fetch an anonymous bearer token and retry.
// Usage: node scripts/image-pullable.mjs ghcr.io/owner/pr-shepherd:0.0.1
const image = process.argv[2];
if (!image) {
  console.error('usage: image-pullable.mjs <image>');
  process.exit(2);
}

let [host, ...rest] = image.split('/');
if (rest.length === 0 || !/[.:]/.test(host) && host !== 'localhost') {
  rest = [host, ...rest];
  host = 'docker.io';
}
let path = rest.join('/');
let ref = 'latest';
const at = path.indexOf('@');
if (at >= 0) {
  ref = path.slice(at + 1);
  path = path.slice(0, at);
} else {
  const colon = path.lastIndexOf(':');
  if (colon > path.lastIndexOf('/')) {
    ref = path.slice(colon + 1);
    path = path.slice(0, colon);
  }
}
if (host === 'docker.io') {
  host = 'registry-1.docker.io';
  if (!path.includes('/')) path = `library/${path}`;
}

const url = `https://${host}/v2/${path}/manifests/${ref}`;
const accept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const head = (auth) =>
  fetch(url, {
    method: 'HEAD',
    headers: { Accept: accept, ...(auth ? { Authorization: auth } : {}) },
    signal: AbortSignal.timeout(10_000),
  });

try {
  let res = await head();
  const challenge = res.headers.get('www-authenticate') ?? '';
  if (res.status === 401 && /^bearer /i.test(challenge)) {
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set('service', params.service);
    tokenUrl.searchParams.set('scope', params.scope ?? `repository:${path}:pull`);
    const tok = await fetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
    if (!tok.ok) process.exit(1);
    const body = await tok.json();
    const token = body.token ?? body.access_token;
    if (!token) process.exit(1);
    res = await head(`Bearer ${token}`);
  }
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}

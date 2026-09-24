// Startup / healthz credential checks (DESIGN §12.1). Results are cached; failures DM the owner (wired in M1).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseGithubExpiry } from './expiry.js';

const run = promisify(execFile);

export type CheckResult = {
  ok: boolean;
  detail: string;
  checkedAt: string;
  expiresAt?: string; // ISO; set by the expiry tracker (DESIGN §11.1)
  estimated?: boolean; // expiry inferred (Claude token: one year from first use)
  githubExpiry?: string; // raw github-authentication-token-expiration header
};
export type CredentialStatus = Record<'github' | 'slack' | 'claude', CheckResult>;

const now = () => new Date().toISOString();
const CHECK_TIMEOUT_MS = 30_000;

// GH_TOKEN must be a fine-grained PAT (DESIGN §4): only fine-grained tokens can be limited to the org
// and denied the Workflows permission. Classic/OAuth tokens (ghp_, gho_) fail the check.
export async function checkGithub(expectedLogin: string, token = process.env.GH_TOKEN): Promise<CheckResult> {
  if (!token?.startsWith('github_pat_')) {
    return { ok: false, detail: 'GH_TOKEN is not a fine-grained PAT (github_pat_…)', checkedAt: now() };
  }
  try {
    const { stdout } = await run('gh', ['api', '-i', 'user'], { timeout: 15_000 });
    const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(stdout)?.[1]?.trim() ?? '';
    const login = /"login"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
    if (login !== expectedLogin) return { ok: false, detail: `login is ${login ?? 'unknown'}, expected ${expectedLogin}`, checkedAt: now() };
    if (scopes.split(/,\s*/).includes('workflow')) return { ok: false, detail: 'token has workflow scope', checkedAt: now() };
    const githubExpiry = /^github-authentication-token-expiration:\s*(.*)$/im.exec(stdout)?.[1]?.trim();
    const result: CheckResult = { ok: true, detail: `login=${login} fine-grained`, checkedAt: now() };
    if (githubExpiry && parseGithubExpiry(githubExpiry)) result.githubExpiry = githubExpiry;
    return result;
  } catch (e) {
    return { ok: false, detail: `gh api user failed: ${(e as Error).message}`, checkedAt: now() };
  }
}

export async function checkSlack(token = process.env.SLACK_BOT_TOKEN): Promise<CheckResult> {
  if (!token) return { ok: false, detail: 'SLACK_BOT_TOKEN missing', checkedAt: now() };
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = (await res.json()) as { ok: boolean; error?: string; user?: string };
    return { ok: body.ok, detail: body.ok ? `bot=${body.user}` : `auth.test: ${body.error}`, checkedAt: now() };
  } catch (e) {
    return { ok: false, detail: `auth.test failed: ${(e as Error).message}`, checkedAt: now() };
  }
}

// One tiny Haiku call; proves CLAUDE_CODE_OAUTH_TOKEN works headless.
export async function checkClaude(timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    for await (const m of query({
      prompt: 'Reply with exactly: OK',
      options: { model: 'claude-haiku-4-5-20251001', maxTurns: 1, tools: [], settingSources: [], persistSession: false, abortController },
    })) {
      if (m.type === 'result') {
        return { ok: m.subtype === 'success', detail: `result=${m.subtype}`, checkedAt: now() };
      }
    }
    return { ok: false, detail: 'no result message', checkedAt: now() };
  } catch (e) {
    const detail = abortController.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : (e as Error).message;
    return { ok: false, detail: `claude check failed: ${detail}`, checkedAt: now() };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAll(ownerGithub: string): Promise<CredentialStatus> {
  const [github, slack, claude] = await Promise.all([checkGithub(ownerGithub), checkSlack(), checkClaude()]);
  return { github, slack, claude };
}

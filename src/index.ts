// Process entry (DESIGN §5.7, §11): config → migrations → git credentials → credential checks → wiring →
// HTTP + Slack → boot reconciliation → loops. SIGTERM: stop intake, interrupt runs (≤30s), disconnect.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createActuator } from './actuator.js';
import { loadConfig } from './config.js';
import type { Command, Db, SlackMessage } from './contracts.js';
import { createControl, type Control } from './control.js';
import { checkAll, type CredentialStatus } from './credentials.js';
import { parseGithubExpiry, trackExpiry } from './expiry.js';
import { migrate, pool } from './db.js';
import { createG3 } from './g3.js';
import { createGithub } from './github.js';
import { startHttp } from './http.js';
import { createInbox } from './inbox.js';
import { createJanitor } from './janitor.js';
import { log } from './log.js';
import { createRepos } from './repos.js';
import { scheduleReport } from './report.js';
import { createScheduler } from './scheduler.js';
import { createSlack } from './slack.js';
import { createStore } from './store.js';

const run = promisify(execFile);
const CREDENTIAL_RECHECK_MS = 6 * 60 * 60 * 1000;
// How to replace each credential: edit deploy.env, then push the value with scripts/update-secret.sh.
const ROTATE_HINT: Record<keyof CredentialStatus, string> = {
  github: 'update `GH_TOKEN` in deploy.env, then `scripts/update-secret.sh GH_TOKEN`',
  slack: 'update `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` in deploy.env, then `scripts/update-secret.sh SLACK_BOT_TOKEN SLACK_APP_TOKEN`',
  claude: 'update `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) in deploy.env, then `scripts/update-secret.sh <that name>`',
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const config = loadConfig();
  const dataDir = process.env.DATA_DIR ?? '/data';
  await migrate();
  // gh reads GH_TOKEN from env; this makes `git push` use it too.
  await run('gh', ['auth', 'setup-git']);
  await configureGitIdentity();

  const db = pool as unknown as Db;
  const store = createStore(db);
  const github = createGithub({ config });
  const repos = createRepos({ dataDir, store });

  // Slack needs its handlers up front; they delegate to modules that need the Slack port, so bind late.
  let inbox: ReturnType<typeof createInbox> | undefined;
  let control: Control | undefined;
  const slack = await createSlack({
    config,
    botToken: env('SLACK_BOT_TOKEN'),
    appToken: env('SLACK_APP_TOKEN'),
    handlers: {
      onThreadReply: async (msg: SlackMessage) => inbox?.onThreadReply(msg),
      onCommand: async (cmd: Command, msg: SlackMessage) => control?.onCommand(cmd, msg),
    },
  });

  const actuator = createActuator({ config, store, slack, github, repos });
  // holdUntilStart: intake starts before boot reconciliation; runs wait for control.recover() → scheduler.start().
  const scheduler = createScheduler({
    config, store, github, repos, actuator, slack, dataDir, appRoot: process.env.APP_ROOT ?? process.cwd(), holdUntilStart: true,
  });
  const g3 = createG3({ config, store, slack, github, repos, scheduler });
  control = createControl({ config, store, github, repos, slack, scheduler, actuator, g3 });
  const ctl = control;
  inbox = createInbox({ config, store, scheduler, wakeByOwner: (prId) => ctl.wake(prId) });
  const janitor = createJanitor({ config, store, github, repos, scheduler, slack, dataDir });

  let credentials: CredentialStatus | undefined;
  const recheck = async () => {
    const checked = await checkAll(config.owner.github);
    await remindExpiry(checked).catch((e) => log.error({ err: e }, 'expiry tracking failed'));
    credentials = checked;
    const failed = Object.entries(credentials).filter(([, v]) => !v.ok) as [keyof CredentialStatus, CredentialStatus[keyof CredentialStatus]][];
    if (!failed.length) return log.info('credentials ok');
    log.error({ failed: failed.map(([k, v]) => ({ k, detail: v.detail })) }, 'credential check failed');
    const text = failed.map(([k, v]) => `• ${k}: ${v.detail} — ${ROTATE_HINT[k]}`).join('\n');
    await slack.dm(config.owner.slack, `${config.bot.name} credential check failed:\n${text}`).catch((e) => log.error({ err: e }, 'credential DM failed'));
  };
  // Advance warning before a token expires (DESIGN §11.1); each threshold is announced once per token.
  const remindExpiry = async (checked: CredentialStatus) => {
    const now = new Date();
    const tracked: [keyof CredentialStatus, string | undefined, Date | null | undefined][] = [
      ['github', process.env.GH_TOKEN, parseGithubExpiry(checked.github.githubExpiry) ?? null],
      ['claude', process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined],
    ];
    for (const [name, token, expiresAt] of tracked) {
      if (!token || !checked[name].ok) continue;
      const r = await trackExpiry(db, { name: name as 'github' | 'claude', token, expiresAt }, now);
      if (r.expiresAt) Object.assign(checked[name], { expiresAt: r.expiresAt.toISOString(), estimated: r.estimated });
      if (r.remindDays === null || !r.expiresAt) continue;
      const when = r.expiresAt.toISOString().slice(0, 10);
      const what = name === 'github' ? `GitHub token expires in ${r.remindDays} days (${when})` : `Claude token is ~${r.remindDays} days from its one-year expiry (estimated ${when})`;
      await slack.dm(config.owner.slack, `:hourglass: ${what} — ${ROTATE_HINT[name]}`).catch((e) => log.error({ err: e }, 'expiry DM failed'));
    }
  };
  // Not awaited: a hanging check must not keep intake and recovery down (each check has its own timeout).
  void recheck().catch((e) => log.error({ err: e }, 'credential check failed'));
  const credTimer = setInterval(() => void recheck(), CREDENTIAL_RECHECK_MS);

  const port = Number(process.env.PORT ?? 8080);
  const server = startHttp(port, { dataDir, db, credentials: () => credentials, github, register: (ref) => ctl.register(ref) });
  await slack.start();
  await control.recover(inbox);
  const stopTimers = control.startTimers();
  const stopJanitor = janitor.start();
  const stopReport = scheduleReport({ store, config, slack, credentials: () => credentials });
  log.info({ port, bot: config.bot.name }, 'pr-shepherd started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    clearInterval(credTimer);
    stopTimers();
    stopJanitor();
    stopReport();
    server.close();
    await scheduler.interruptAll().catch((e) => log.error({ err: e }, 'interruptAll failed'));
    await slack.stop().catch((e) => log.error({ err: e }, 'slack stop failed'));
    await pool.end();
    process.exit(0);
  };
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Commits are authored as me (DESIGN §4), using the GitHub noreply address when my email is private.
async function configureGitIdentity() {
  const { stdout } = await run('gh', ['api', 'user', '--jq', '[.id, .login, .name // .login, .email // ""] | @tsv']);
  const [id, login, name, email] = stdout.trim().split('\t');
  await run('git', ['config', '--global', 'user.name', name ?? login ?? 'unknown']);
  await run('git', ['config', '--global', 'user.email', email || `${id}+${login}@users.noreply.github.com`]);
}

main().catch((e) => {
  log.fatal({ err: e }, 'startup failed');
  process.exit(1);
});

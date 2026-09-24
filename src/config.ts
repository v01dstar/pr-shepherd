// Loads and validates the config (DESIGN §11). Invalid config fails startup.
// Source: the PR_SHEPHERD_CONFIG env var (YAML text, or a one-line JSON object, set from a secret) when non-empty,
// else the file at CONFIG_PATH (default config.yaml).
// PR_SHEPHERD_* env overrides (ENV_OVERRIDES) are applied on top, for template deploys.
// config.example.yaml is the committed template.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

const bot = z.object({ name: z.string(), slack: z.string(), request: z.string() });
const reviewer = bot.extend({ rerequest: z.string() });

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// Model / reasoning effort for agent runs (DESIGN §11). Unset = the Claude Code default. `shepherd` and
// `review` override the shared values for that kind of run.
const agentModel = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
});
const agentSettings = agentModel.extend({
  fallbackModel: z.string().min(1).optional(),
  shepherd: agentModel.default({}),
  review: agentModel.default({}),
});

const DEFAULT_LIMITS = { maxRounds: 4, maxRunsPerPr: 30, maxTurns: 60, shepherdConcurrency: 1, reviewConcurrency: 2 };
const DEFAULT_TIMING = {
  debounceSec: 30, ackTimeoutMin: 15, replyTimeoutMin: 120, sweepMin: 30, reviewIdleDays: 7, reportAt: '09:00', timezone: 'America/Los_Angeles',
};

export const configSchema = z
  .object({
    // This deployment's display name (Slack messages, PR comments, commit trailer). The product is pr-shepherd.
    bot: z.object({ name: z.string().min(1).default('pr-shepherd') }).default({ name: 'pr-shepherd' }),
    org: z.string(),
    // name: display name used in messages to the agent; defaults to the GitHub login.
    owner: z.object({ github: z.string(), slack: z.string(), name: z.string().min(1).optional() }),
    reviewChannel: z.string(),
    // Every PR tags all of them (the owner can narrow one PR with `set <pr> reviewers=…`).
    reviewers: z.array(reviewer).min(1),
    // Who can approve the owner's PRs (GitHub does not allow self-approval). request_approve asks all of them
    // unless the agent names a subset; the first approval wins.
    approvers: z.array(bot).min(1),
    excludeRepos: z.array(z.string()).default([]),
    agent: agentSettings.default({ shepherd: {}, review: {} }),
    limits: z
      .object({
        maxRounds: z.number().int().positive().default(DEFAULT_LIMITS.maxRounds),
        maxRunsPerPr: z.number().int().positive().default(DEFAULT_LIMITS.maxRunsPerPr),
        maxTurns: z.number().int().positive().default(DEFAULT_LIMITS.maxTurns),
        shepherdConcurrency: z.number().int().positive().default(DEFAULT_LIMITS.shepherdConcurrency),
        reviewConcurrency: z.number().int().positive().default(DEFAULT_LIMITS.reviewConcurrency),
      })
      .default(DEFAULT_LIMITS),
    timing: z
      .object({
        debounceSec: z.number().nonnegative().default(DEFAULT_TIMING.debounceSec),
        ackTimeoutMin: z.number().positive().default(DEFAULT_TIMING.ackTimeoutMin),
        replyTimeoutMin: z.number().positive().default(DEFAULT_TIMING.replyTimeoutMin),
        sweepMin: z.number().positive().default(DEFAULT_TIMING.sweepMin),
        reviewIdleDays: z.number().positive().default(DEFAULT_TIMING.reviewIdleDays),
        reportAt: z.string().regex(/^\d{2}:\d{2}$/).default(DEFAULT_TIMING.reportAt),
        timezone: z.string().default(DEFAULT_TIMING.timezone),
      })
      .default(DEFAULT_TIMING),
  })
  .superRefine((c, ctx) => {
    const reviewerNames = c.reviewers.map((r) => r.name);
    if (new Set(reviewerNames).size !== reviewerNames.length) ctx.addIssue({ code: 'custom', path: ['reviewers'], message: 'reviewer names must be unique' });
    const approverNames = c.approvers.map((a) => a.name);
    if (new Set(approverNames).size !== approverNames.length) ctx.addIssue({ code: 'custom', path: ['approvers'], message: 'approver names must be unique' });
  })
  .transform((c) => ({
    ...c,
    owner: { ...c.owner, name: c.owner.name ?? c.owner.github },
  }));

export type Config = z.output<typeof configSchema>;
export type ReviewerConfig = Config['reviewers'][number];

// SDK options for one kind of run: the role's value wins over the shared one; unset keys are omitted.
export function agentOptions(config: Pick<Config, 'agent'>, role: 'shepherd' | 'review') {
  const a = config.agent;
  const model = a[role].model ?? a.model;
  const effort = a[role].effort ?? a.effort;
  return {
    ...(model && { model }),
    ...(effort && { effort }),
    ...(a.fallbackModel && { fallbackModel: a.fallbackModel }),
  };
}

// Env var → config path. Non-empty values override the YAML.
export const ENV_OVERRIDES: Record<string, [string] | [string, string]> = {
  PR_SHEPHERD_BOT_NAME: ['bot', 'name'],
  PR_SHEPHERD_ORG: ['org'],
  PR_SHEPHERD_OWNER_GITHUB: ['owner', 'github'],
  PR_SHEPHERD_OWNER_SLACK: ['owner', 'slack'],
  PR_SHEPHERD_OWNER_NAME: ['owner', 'name'],
  PR_SHEPHERD_REVIEW_CHANNEL: ['reviewChannel'],
  PR_SHEPHERD_MODEL: ['agent', 'model'],
  PR_SHEPHERD_EFFORT: ['agent', 'effort'],
};

function applyEnv(raw: unknown, env: Env): unknown {
  const entries = Object.entries(ENV_OVERRIDES).filter(([k]) => env[k]?.trim());
  if (!entries.length) return raw;
  const out: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  for (const [k, path] of entries) {
    const value = env[k]!.trim();
    if (path.length === 1) out[path[0]] = value;
    else {
      const cur = out[path[0]];
      out[path[0]] = { ...(cur && typeof cur === 'object' ? cur : {}), [path[1]]: value };
    }
  }
  return out;
}

// YAML is a JSON superset, so a one-line JSON object parses here too.
export function parseConfig(yamlText: string, env: Env = {}): Config {
  return configSchema.parse(applyEnv(parse(yamlText), env));
}

// An explicit path always reads that file; with no argument, PR_SHEPHERD_CONFIG
// wins over CONFIG_PATH. Env overrides apply in every case.
export function loadConfig(path?: string, env: Env = process.env): Config {
  const fromEnv = env.PR_SHEPHERD_CONFIG?.trim() ? env.PR_SHEPHERD_CONFIG : undefined;
  const text = path === undefined ? fromEnv : undefined;
  return parseConfig(text ?? readFileSync(path ?? env.CONFIG_PATH ?? 'config.yaml', 'utf8'), env);
}

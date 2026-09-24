import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';

const MINIMAL = `
org: acme
owner: { github: octo, slack: UOWNER }
reviewChannel: pr-review
reviewers:
  - { name: bot-a, slack: UA, request: "<@{slack}> review {url}", rerequest: "<@{slack}> review {url}" }
  - { name: bot-b, slack: UB, request: "<@{slack}> review {url}", rerequest: "<@{slack}> review {url}" }
approvers:
  - { name: bot-a, slack: UA, request: "<@{slack}> approve {url}" }
`;

describe('config.example.yaml', () => {
  it('parses and validates', () => {
    const c = loadConfig('config.example.yaml', {});
    expect(c.bot).toEqual({ name: 'pr-shepherd' });
    expect(c.owner).toEqual({ github: 'owner-login', slack: 'UOWNER', name: 'Owner' });
    expect(c.reviewers.map((r) => r.name)).toEqual(['review-bot', 'codex-bot']);
    expect(c.approvers.map((a) => a.name)).toEqual(['review-bot', 'codex-bot']);
  });

  it('its optional values are exactly the defaults', () => {
    const full = loadConfig('config.example.yaml', {});
    const min = parseConfig(`org: your-org
owner: { github: owner-login, slack: UOWNER }
reviewChannel: pr-review
reviewers: ${JSON.stringify(full.reviewers)}
approvers: ${JSON.stringify(full.approvers)}
`);
    expect(min.limits).toEqual(full.limits);
    expect(min.timing).toEqual(full.timing);
    expect(min.excludeRepos).toEqual(full.excludeRepos);
    expect(min.bot).toEqual(full.bot);
  });
});

describe('defaults', () => {
  it('a minimal config gets bot name, owner name, reviewers, limits, timing', () => {
    const c = parseConfig(MINIMAL);
    expect(c.bot.name).toBe('pr-shepherd');
    expect(c.owner.name).toBe('octo');
    expect(c.excludeRepos).toEqual([]);
    expect(c.limits).toEqual({ maxRounds: 4, maxRunsPerPr: 30, maxTurns: 60, shepherdConcurrency: 1, reviewConcurrency: 2 });
    expect(c.timing).toEqual({
      debounceSec: 30, ackTimeoutMin: 15, replyTimeoutMin: 120, sweepMin: 30, reviewIdleDays: 7, reportAt: '09:00', timezone: 'America/Los_Angeles',
    });
  });

  it('partial limits / timing keep the other defaults', () => {
    const c = parseConfig(`${MINIMAL}limits: { maxRounds: 2 }\ntiming: { timezone: UTC }\n`);
    expect(c.limits.maxRounds).toBe(2);
    expect(c.limits.maxTurns).toBe(60);
    expect(c.timing.timezone).toBe('UTC');
    expect(c.timing.reportAt).toBe('09:00');
  });

  it('explicit bot and owner names win', () => {
    const c = parseConfig(MINIMAL.replace('owner: { github: octo, slack: UOWNER }', 'bot: { name: my-bot }\nowner: { github: octo, slack: UOWNER, name: Octo Cat }'));
    expect(c.bot.name).toBe('my-bot');
    expect(c.owner.name).toBe('Octo Cat');
  });

  it('rejects duplicate reviewers and missing required keys', () => {
    expect(() => parseConfig(MINIMAL.replace('  - { name: bot-b', '  - { name: bot-a'))).toThrow(/unique/);
    expect(() => parseConfig(MINIMAL.replace('reviewChannel: pr-review\n', ''))).toThrow();
  });
});

describe('env overrides', () => {
  const env = {
    PR_SHEPHERD_BOT_NAME: 'team-bot',
    PR_SHEPHERD_ORG: 'other-org',
    PR_SHEPHERD_OWNER_GITHUB: 'alice',
    PR_SHEPHERD_OWNER_SLACK: 'UALICE',
    PR_SHEPHERD_OWNER_NAME: 'Alice',
    PR_SHEPHERD_REVIEW_CHANNEL: 'reviews',
  };

  it('apply on top of the YAML', () => {
    const c = parseConfig(MINIMAL, env);
    expect(c.bot.name).toBe('team-bot');
    expect(c.org).toBe('other-org');
    expect(c.owner).toEqual({ github: 'alice', slack: 'UALICE', name: 'Alice' });
    expect(c.reviewChannel).toBe('reviews');
  });

  it('owner name defaults to the overridden GitHub login; empty values are ignored', () => {
    const c = parseConfig(MINIMAL, { PR_SHEPHERD_OWNER_GITHUB: 'bob', PR_SHEPHERD_ORG: '  ', PR_SHEPHERD_BOT_NAME: '' });
    expect(c.owner).toEqual({ github: 'bob', slack: 'UOWNER', name: 'bob' });
    expect(c.org).toBe('acme');
    expect(c.bot.name).toBe('pr-shepherd');
  });

  it('can supply required keys the YAML leaves out', () => {
    const c = parseConfig(MINIMAL.replace('org: acme\n', '').replace('owner: { github: octo, slack: UOWNER }\n', ''), env);
    expect(c.org).toBe('other-org');
    expect(c.owner.github).toBe('alice');
  });

  it('apply through loadConfig, including with an explicit path', () => {
    expect(loadConfig('config.example.yaml', { PR_SHEPHERD_BOT_NAME: 'x-bot' }).bot.name).toBe('x-bot');
    expect(loadConfig(undefined, { PR_SHEPHERD_CONFIG: MINIMAL, PR_SHEPHERD_ORG: 'o2' }).org).toBe('o2');
  });
});

describe('loadConfig sources', () => {
  const yaml = readFileSync('config.example.yaml', 'utf8');

  it('parses PR_SHEPHERD_CONFIG as YAML text when set', () => {
    const c = loadConfig(undefined, { PR_SHEPHERD_CONFIG: yaml.replace('reviewChannel: pr-review', 'reviewChannel: from-env'), CONFIG_PATH: 'missing.yaml' });
    expect(c.reviewChannel).toBe('from-env');
  });

  it('accepts a one-line JSON object', () => {
    const json = JSON.stringify(parseConfig(MINIMAL));
    expect(json).not.toContain('\n');
    const c = loadConfig(undefined, { PR_SHEPHERD_CONFIG: json, CONFIG_PATH: 'missing.yaml' });
    expect(c).toEqual(parseConfig(MINIMAL));
    const tiny = JSON.stringify({ org: 'acme', owner: { github: 'octo', slack: 'U1' }, reviewChannel: 'c', reviewers: parseConfig(MINIMAL).reviewers, approvers: parseConfig(MINIMAL).approvers });
    expect(loadConfig(undefined, { PR_SHEPHERD_CONFIG: tiny }).reviewers.map((r) => r.name)).toEqual(['bot-a', 'bot-b']);
  });

  it('ignores an empty PR_SHEPHERD_CONFIG', () => {
    expect(loadConfig(undefined, { PR_SHEPHERD_CONFIG: ' ', CONFIG_PATH: 'config.example.yaml' }).reviewChannel).toBe('pr-review');
  });

  it('falls back to CONFIG_PATH when PR_SHEPHERD_CONFIG is empty', () => {
    expect(loadConfig(undefined, { PR_SHEPHERD_CONFIG: '', CONFIG_PATH: 'config.example.yaml' }).reviewChannel).toBe('pr-review');
    expect(() => loadConfig(undefined, { CONFIG_PATH: 'missing.yaml' })).toThrow(/ENOENT/);
  });

  it('an explicit path ignores the env config text', () => {
    expect(loadConfig('config.example.yaml', { PR_SHEPHERD_CONFIG: MINIMAL }).org).toBe('your-org');
  });

  it('rejects invalid YAML config from the env', () => {
    expect(() => loadConfig(undefined, { PR_SHEPHERD_CONFIG: 'org: acme\n' })).toThrow();
  });
});

describe('approvers', () => {
  it('rejects duplicate approver names and an empty list', () => {
    const dup = MINIMAL + '  - { name: bot-a, slack: UB, request: "x" }\n';
    expect(() => parseConfig(dup)).toThrow(/unique/);
    expect(() => parseConfig(MINIMAL.replace(/approvers:\n  - .*\n/, 'approvers: []\n'))).toThrow();
  });
});

describe('agent model and effort', () => {
  it('is empty by default, so the Claude Code defaults apply', async () => {
    const { agentOptions } = await import('../src/config.js');
    const c = parseConfig(MINIMAL);
    expect(c.agent).toEqual({ shepherd: {}, review: {} });
    expect(agentOptions(c, 'shepherd')).toEqual({});
  });

  it('role values override shared ones; env overrides the shared ones', async () => {
    const { agentOptions } = await import('../src/config.js');
    const c = parseConfig(`${MINIMAL}agent:
  model: claude-opus-5-5
  effort: high
  fallbackModel: claude-sonnet-5
  review: { model: claude-sonnet-5, effort: medium }
`);
    expect(agentOptions(c, 'shepherd')).toEqual({ model: 'claude-opus-5-5', effort: 'high', fallbackModel: 'claude-sonnet-5' });
    expect(agentOptions(c, 'review')).toEqual({ model: 'claude-sonnet-5', effort: 'medium', fallbackModel: 'claude-sonnet-5' });
    const e = parseConfig(MINIMAL, { PR_SHEPHERD_MODEL: 'claude-sonnet-5', PR_SHEPHERD_EFFORT: 'low' });
    expect(agentOptions(e, 'review')).toEqual({ model: 'claude-sonnet-5', effort: 'low' });
  });

  it('rejects an unknown effort', () => {
    expect(() => parseConfig(`${MINIMAL}agent: { effort: extreme }\n`)).toThrow();
  });
});


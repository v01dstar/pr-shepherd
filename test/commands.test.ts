import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helpText, ownerOnly, parseCommand, parsePrRef } from '../src/commands.js';

type G3Case = { from: string; text: string; expect: { kind: 'review' | 'approve'; pr: string; context?: string } };
const fx = JSON.parse(readFileSync('test/fixtures/slack/verdicts.json', 'utf8')) as { g3_commands: G3Case[] };
const ref = (s: string) => {
  const [repo, n] = s.split('#');
  return { repo: repo!, number: Number(n) };
};
const BOT = 'BOT';

describe('parsePrRef', () => {
  const pr = { repo: 'your-org/example-cli', number: 288 };
  it.each([
    'https://github.com/your-org/example-cli/pull/288',
    'https://github.com/your-org/example-cli/pull/288/files',
    'https://github.com/your-org/example-cli/pull/288#pullrequestreview-1',
    '<https://github.com/your-org/example-cli/pull/288>',
    '<https://github.com/your-org/example-cli/pull/288|example-cli#288>',
    'your-org/example-cli#288',
    ' your-org/example-cli#288, ',
  ])('%s', (s) => expect(parsePrRef(s)).toEqual(pr));

  it.each(['', 'example-cli#288', 'https://github.com/your-org/example-cli/issues/288', '<https://example.com/x>', 'owner/repo#0'])(
    'rejects %j',
    (s) => expect(parsePrRef(s)).toBeNull(),
  );
});

describe('parseCommand — G3 request forms seen in the review channel', () => {
  for (const c of fx.g3_commands) {
    it(`${c.from}: ${c.text.split('\n')[0]}`, () => {
      const cmd = parseCommand(c.text, BOT);
      expect(cmd.kind).toBe(c.expect.kind === 'review' ? 'g3_review' : 'g3_approve');
      if (cmd.kind !== 'g3_review' && cmd.kind !== 'g3_approve') return;
      expect(cmd.pr).toEqual(ref(c.expect.pr));
      if (c.expect.context !== undefined) expect(cmd.context).toBe(c.expect.context);
    });
  }

  it('same-line " - note" becomes context', () => {
    expect(parseCommand('<@BOT> please approve <https://github.com/o/r/pull/1> - workflow approved', BOT)).toEqual({
      kind: 'g3_approve',
      pr: { repo: 'o/r', number: 1 },
      context: 'workflow approved',
    });
  });

  it('re-review keeps following lines as context', () => {
    const cmd = parseCommand('<@BOT> pushed fixes, please re-review: <https://github.com/o/r/pull/4>\nline one\nline two', BOT);
    expect(cmd).toEqual({ kind: 'g3_review', pr: { repo: 'o/r', number: 4 }, context: 'line one\nline two' });
  });

  it('accepts trailing "again", owner/repo#N, and labelled links', () => {
    expect(parseCommand('<@BOT> review o/r#9 again', BOT)).toEqual({ kind: 'g3_review', pr: { repo: 'o/r', number: 9 }, context: '' });
    expect(parseCommand('<@BOT> review <https://github.com/o/r/pull/9|r#9> again', BOT)).toMatchObject({ kind: 'g3_review', context: '' });
    expect(parseCommand('<@BOT|pr-shepherd> Review this <https://github.com/o/r/pull/9>', BOT)).toMatchObject({ kind: 'g3_review' });
  });

  it('review without a PR is unknown', () => {
    expect(parseCommand('<@BOT> review the thing', BOT).kind).toBe('unknown');
    expect(parseCommand('<@BOT> review', BOT).kind).toBe('unknown');
  });
});

describe('parseCommand — owner forms', () => {
  const pr = { repo: 'o/r', number: 3 };
  it('status', () => {
    expect(parseCommand('<@BOT> status', BOT)).toEqual({ kind: 'status' });
    expect(parseCommand('status o/r#3', BOT)).toEqual({ kind: 'status', pr });
    expect(parseCommand('status nope', BOT).kind).toBe('unknown');
  });

  it('track / untrack / merge', () => {
    expect(parseCommand('<@BOT> track <https://github.com/o/r/pull/3>', BOT)).toEqual({ kind: 'track', pr });
    expect(parseCommand('untrack o/r#3', BOT)).toEqual({ kind: 'untrack', pr });
    expect(parseCommand('MERGE o/r#3', BOT)).toEqual({ kind: 'merge', pr });
    expect(parseCommand('merge', BOT).kind).toBe('unknown');
  });

  it('tell keeps the rest verbatim, including newlines', () => {
    expect(parseCommand('<@BOT> tell o/r#3 skip the flaky test\nand rebase', BOT)).toEqual({
      kind: 'tell',
      pr,
      text: 'skip the flaky test\nand rebase',
    });
    expect(parseCommand('tell o/r#3', BOT).kind).toBe('unknown');
  });

  it('set with any subset, quoted reviewer names', () => {
    expect(parseCommand('set o/r#3 rounds=6 reviewers=review-bot,codex-bot auto_merge=off', BOT)).toEqual({
      kind: 'set',
      pr,
      rounds: 6,
      reviewers: ['review-bot', 'codex-bot'],
      autoMerge: false,
    });
    expect(parseCommand('set o/r#3 auto_merge=on', BOT)).toEqual({ kind: 'set', pr, autoMerge: true });
    expect(parseCommand('set o/r#3 reviewers="summary-bot-a,summary-bot-b"', BOT)).toEqual({
      kind: 'set',
      pr,
      reviewers: ['summary-bot-a', 'summary-bot-b'],
    });
  });

  it.each([
    'set o/r#3',
    'set o/r#3 rounds=0',
    'set o/r#3 rounds=x',
    'set o/r#3 auto_merge=maybe',
    'set o/r#3 color=red',
    'set o/r#3 reviewers=summary bot',
  ])('set rejects %j', (s) => expect(parseCommand(s, BOT).kind).toBe('unknown'));

  it('pause / resume', () => {
    expect(parseCommand('pause all', BOT)).toEqual({ kind: 'pause', pr: 'all' });
    expect(parseCommand('resume o/r#3', BOT)).toEqual({ kind: 'resume', pr });
    expect(parseCommand('pause', BOT).kind).toBe('unknown');
  });

  it('report / help / empty / unknown', () => {
    expect(parseCommand('<@BOT> report', BOT)).toEqual({ kind: 'report' });
    expect(parseCommand('<@BOT> help', BOT)).toEqual({ kind: 'help' });
    expect(parseCommand('<@BOT>', BOT)).toEqual({ kind: 'help' });
    expect(parseCommand('<@BOT> make coffee', BOT)).toEqual({ kind: 'unknown', text: 'make coffee' });
  });
});

describe('ownerOnly', () => {
  const pr = { repo: 'o/r', number: 1 };
  it('owner commands', () => {
    for (const k of ['track', 'untrack', 'merge'] as const) expect(ownerOnly({ kind: k, pr })).toBe(true);
    expect(ownerOnly({ kind: 'tell', pr, text: 'x' })).toBe(true);
    expect(ownerOnly({ kind: 'set', pr })).toBe(true);
    expect(ownerOnly({ kind: 'pause', pr: 'all' })).toBe(true);
    expect(ownerOnly({ kind: 'resume', pr })).toBe(true);
    expect(ownerOnly({ kind: 'report' })).toBe(true);
  });
  it('public commands', () => {
    expect(ownerOnly({ kind: 'g3_review', pr, context: '' })).toBe(false);
    expect(ownerOnly({ kind: 'g3_approve', pr, context: '' })).toBe(false);
    expect(ownerOnly({ kind: 'status' })).toBe(false);
    expect(ownerOnly({ kind: 'help' })).toBe(false);
    expect(ownerOnly({ kind: 'unknown', text: '' })).toBe(false);
  });
  it('HELP_TEXT mentions every verb', () => {
    for (const v of ['review', 'approve', 'status', 'track', 'untrack', 'tell', 'set', 'merge', 'pause', 'resume', 'report', 'help']) {
      expect(helpText("x")).toContain(`\`${v}`);
    }
  });
});

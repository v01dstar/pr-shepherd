// Slack command parsing (DESIGN §7.1 G3 forms, §9 owner commands). Pure: no I/O.
import type { Command, PrRef } from './contracts.js';

const PR_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

// Accepts https URL, Slack-escaped <url> / <url|label>, and owner/repo#N.
export function parsePrRef(s: string): PrRef | null {
  let t = s.trim();
  const angle = /^<([^>|]+)(?:\|([^>]*))?>$/.exec(t);
  if (angle) {
    const fromUrl = parsePrRef(angle[1]!);
    if (fromUrl) return fromUrl;
    return angle[2] ? parsePrRef(angle[2]) : null;
  }
  t = t.replace(/[.,;:)]+$/, '');
  const m = PR_URL.exec(t) ?? PR_SHORT.exec(t);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: `${m[1]}/${m[2]}`, number };
}

// First token of `s`: a whole <...> Slack link or a whitespace-delimited word.
function takeToken(s: string): { token: string; rest: string } | null {
  const m = /^\s*(<[^>]*>|\S+)([\s\S]*)$/.exec(s);
  return m ? { token: m[1]!, rest: m[2]! } : null;
}

function takePr(s: string): { pr: PrRef; rest: string } | null {
  const t = takeToken(s);
  if (!t) return null;
  const pr = parsePrRef(t.token);
  return pr ? { pr, rest: t.rest } : null;
}

// Text after the PR link: same-line remainder (minus a leading "-" / "again") plus following lines.
function contextOf(rest: string): string {
  const nl = rest.indexOf('\n');
  let line = nl < 0 ? rest : rest.slice(0, nl);
  const after = nl < 0 ? '' : rest.slice(nl + 1);
  line = line.trim().replace(/^again\b\s*/i, '').replace(/^[-–—:]\s*/, '');
  return [line.trim(), after.trim()].filter(Boolean).join('\n');
}

const G3 = /^(?:pushed fixes,?\s+)?(?:please\s+)?(re-?review|review|approve)(?:\s+again)?(?:\s+this)?(?:\s+again)?\s*:?(?=\s)/i;

export function parseCommand(text: string, botUserId: string): Command {
  const mention = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g');
  // Drop our mention anywhere and any other leading mentions (e.g. "<@OTHER> <@BOT> please review: …").
  const body = text.replace(mention, ' ').replace(/^(?:\s*<[@!][^>]*>)+/, '').trim();
  const unknown: Command = { kind: 'unknown', text: body };
  if (!body) return { kind: 'help' };

  const g3 = G3.exec(body);
  if (g3) {
    const p = takePr(body.slice(g3[0].length));
    if (!p) return unknown;
    const kind = g3[1]!.toLowerCase() === 'approve' ? 'g3_approve' : 'g3_review';
    return { kind, pr: p.pr, context: contextOf(p.rest) };
  }

  const head = takeToken(body);
  if (!head) return unknown;
  const verb = head.token.toLowerCase();
  const rest = head.rest;
  const onlyWs = (s: string) => s.trim() === '';

  switch (verb) {
    case 'help':
    case 'report':
      return onlyWs(rest) ? { kind: verb } : unknown;
    case 'status': {
      if (onlyWs(rest)) return { kind: 'status' };
      const p = takePr(rest);
      return p && onlyWs(p.rest) ? { kind: 'status', pr: p.pr } : unknown;
    }
    case 'track':
    case 'untrack':
    case 'merge': {
      const p = takePr(rest);
      return p && onlyWs(p.rest) ? { kind: verb, pr: p.pr } : unknown;
    }
    case 'pause':
    case 'resume': {
      const t = takeToken(rest);
      if (!t || !onlyWs(t.rest)) return unknown;
      if (t.token.toLowerCase() === 'all') return { kind: verb, pr: 'all' };
      const pr = parsePrRef(t.token);
      return pr ? { kind: verb, pr } : unknown;
    }
    case 'tell': {
      const p = takePr(rest);
      const said = p?.rest.trim();
      return p && said ? { kind: 'tell', pr: p.pr, text: said } : unknown;
    }
    case 'set': {
      const p = takePr(rest);
      return p ? (parseSet(p.pr, p.rest) ?? unknown) : unknown;
    }
    default:
      return unknown;
  }
}

function parseSet(pr: PrRef, s: string): Command | null {
  const cmd: Extract<Command, { kind: 'set' }> = { kind: 'set', pr };
  const kv = /\s*([a-z_]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/iy;
  let pos = 0;
  let any = false;
  const src = s.trimEnd();
  while (pos < src.length) {
    kv.lastIndex = pos;
    const m = kv.exec(src);
    if (!m) return null;
    pos = kv.lastIndex;
    const key = m[1]!.toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key === 'rounds') {
      if (!/^\d+$/.test(val) || Number(val) <= 0) return null;
      cmd.rounds = Number(val);
    } else if (key === 'reviewers') {
      const names = val.split(',').map((n) => n.trim()).filter(Boolean);
      if (!names.length) return null;
      cmd.reviewers = names;
    } else if (key === 'auto_merge' || key === 'automerge') {
      const v = val.toLowerCase();
      if (v === 'on' || v === 'true') cmd.autoMerge = true;
      else if (v === 'off' || v === 'false') cmd.autoMerge = false;
      else return null;
    } else return null;
    any = true;
  }
  return any ? cmd : null;
}

export function ownerOnly(cmd: Command): boolean {
  switch (cmd.kind) {
    case 'track':
    case 'untrack':
    case 'merge':
    case 'tell':
    case 'set':
    case 'pause':
    case 'resume':
    case 'report':
      return true;
    default:
      return false;
  }
}

export const helpText = (botName: string) => [
  `*${botName} commands* (\`<pr>\` = PR link or \`owner/repo#N\`)`,
  '• `review <pr>` / `please review: <pr>` / `pushed fixes, please re-review: <pr>` — review a PR (anyone)',
  '• `approve <pr>` / `please approve <pr> - <note>` — approve a PR (anyone)',
  '• `status [<pr>]` — shepherded PRs and their state (anyone)',
  '• `help` — this list (anyone)',
  'Owner only (also by DM):',
  '• `track <pr>` / `untrack <pr>` — start / stop shepherding',
  '• `tell <pr> <text>` — pass a note to the agent',
  '• `set <pr> rounds=N reviewers=A,B auto_merge=on|off` — per-PR policy (any subset; quote names with spaces)',
  '• `merge <pr>` — release a merge waiting for confirmation',
  '• `pause <pr>|all` / `resume <pr>|all` — pause / resume (all = global stop)',
  '• `report` — send the daily report now',
].join('\n');

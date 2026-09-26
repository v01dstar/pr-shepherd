// Postgres persistence over migrations/*.sql (DESIGN §10). Plain parameterized SQL, snake_case ↔ camelCase.
import type {
  Db, EventKind, InboxEvent, Job, Pr, PrRef, PrStatus, ReviewRequest, Run, RunStatus, Store, Timer, TimerKind, Workspace,
  WorkspaceKind,
} from './contracts.js';

type Row = Record<string, unknown>;

// Extras beyond the Store contract; the actuator uses them when present.
export type StoreExtras = {
  requestsForPr(prId: number): Promise<ReviewRequest[]>; // every request of the current lifecycle incl. done/superseded, oldest first
  unclaimEvents(eventIds: number[], runId: number): Promise<void>; // hand steered-but-unread events back to the inbox
  lastRunWithOutput(prId: number): Promise<Run | null>; // latest run that produced output (status line, DESIGN §5.9)
};

// pg returns int8 as string, pglite may return bigint; ids always fit in a JS number here.
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const dateOrNull = (v: unknown): Date | null => (v == null ? null : date(v));
const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

const toPr = (r: Row): Pr => ({
  id: num(r.id),
  repo: r.repo as string,
  number: num(r.number),
  status: r.status as PrStatus,
  reason: (r.reason as string | null) ?? null,
  sessionId: (r.session_id as string | null) ?? null,
  reviewers: (r.reviewers as string[]) ?? [],
  maxRounds: num(r.max_rounds),
  autoMerge: Boolean(r.auto_merge),
  pendingMerge: r.pending_merge == null ? null : json<{ sha: string; title: string }>(r.pending_merge),
  dmChannel: (r.dm_channel as string | null) ?? null,
  dmTs: (r.dm_ts as string | null) ?? null,
  runCount: num(r.run_count),
  createdAt: date(r.created_at),
  updatedAt: date(r.updated_at),
  closedAt: dateOrNull(r.closed_at),
});

const toEvent = (r: Row): InboxEvent => ({
  id: num(r.id),
  prId: numOrNull(r.pr_id),
  kind: r.kind as EventKind,
  payload: json<Record<string, unknown>>(r.payload) ?? {},
  dedupeKey: (r.dedupe_key as string | null) ?? null,
  createdAt: date(r.created_at),
  runId: numOrNull(r.run_id),
});

const toRun = (r: Row): Run => ({
  id: num(r.id),
  prId: numOrNull(r.pr_id),
  jobId: numOrNull(r.job_id),
  sessionId: (r.session_id as string | null) ?? null,
  status: r.status as RunStatus,
  turns: numOrNull(r.turns),
  usage: r.usage == null ? null : json<Record<string, unknown>>(r.usage),
  output: r.output == null ? null : json<Run['output']>(r.output),
  startedAt: date(r.started_at),
  endedAt: dateOrNull(r.ended_at),
  appliedAt: dateOrNull(r.applied_at),
});

const toRequest = (r: Row): ReviewRequest => ({
  id: num(r.id),
  prId: num(r.pr_id),
  runId: numOrNull(r.run_id),
  kind: r.kind as ReviewRequest['kind'],
  bot: r.bot as string,
  round: num(r.round),
  resend: Boolean(r.resend),
  channel: r.channel as string,
  requestTs: r.request_ts as string,
  sentAt: date(r.sent_at),
  lastActivityAt: dateOrNull(r.last_activity_at),
  acked: Boolean(r.acked),
  doneAt: dateOrNull(r.done_at),
  reviewUrl: (r.review_url as string | null) ?? null,
  firstLine: (r.first_line as string | null) ?? null,
  superseded: Boolean(r.superseded),
  headSha: (r.head_sha as string | null) ?? null,
});

const toJob = (r: Row): Job => ({
  id: num(r.id),
  kind: r.kind as Job['kind'],
  repo: r.repo as string,
  number: num(r.number),
  requestedBy: r.requested_by as string,
  channel: r.channel as string,
  threadTs: r.thread_ts as string,
  status: r.status as Job['status'],
  verdict: (r.verdict as string | null) ?? null,
  createdAt: date(r.created_at),
  endedAt: dateOrNull(r.ended_at),
});

const toTimer = (r: Row): Timer => ({
  id: num(r.id),
  prId: num(r.pr_id),
  kind: r.kind as TimerKind,
  refId: numOrNull(r.ref_id),
  fireAt: date(r.fire_at),
  firedAt: dateOrNull(r.fired_at),
  note: (r.note as string | null) ?? null,
});

const toWorkspace = (r: Row): Workspace => ({
  id: num(r.id),
  kind: r.kind as WorkspaceKind,
  repo: r.repo as string,
  number: num(r.number),
  path: r.path as string,
  lastUsedAt: date(r.last_used_at),
  cleanedAt: dateOrNull(r.cleaned_at),
});

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// Builds "col = $n, ..." from a camelCase patch. Columns are whitelisted; jsonb values are serialized explicitly
// because node-pg would turn JS arrays into pg array literals.
function setClause(patch: Record<string, unknown>, allowed: readonly string[], jsonCols: readonly string[], start: number) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !allowed.includes(k)) continue;
    const col = snake(k);
    params.push(jsonCols.includes(k) && v !== null ? JSON.stringify(v) : v);
    sets.push(`${col} = $${start + params.length - 1}${jsonCols.includes(k) ? '::jsonb' : ''}`);
  }
  return { sets, params };
}

const PR_COLS = ['status', 'reason', 'sessionId', 'reviewers', 'maxRounds', 'autoMerge', 'pendingMerge', 'runCount', 'updatedAt', 'closedAt'] as const;
const RUN_COLS = ['sessionId', 'status', 'turns', 'usage', 'output', 'endedAt', 'appliedAt'] as const;
const REQ_COLS = ['requestTs', 'lastActivityAt', 'acked', 'doneAt', 'reviewUrl', 'firstLine', 'superseded'] as const;
const JOB_COLS = ['status', 'verdict', 'endedAt'] as const;

export function createStore(db: Db): Store & StoreExtras {
  const q = async (text: string, params?: unknown[]): Promise<Row[]> => (await db.query<Row>(text, params)).rows;
  const one = async (text: string, params?: unknown[]): Promise<Row | null> => (await q(text, params))[0] ?? null;

  const getPrByRef = async (ref: PrRef) => {
    const r = await one('select * from prs where repo = $1 and number = $2', [ref.repo, ref.number]);
    return r ? toPr(r) : null;
  };

  return {
    async upsertPr(ref, reviewers, maxRounds) {
      const inserted = await one(
        `insert into prs (repo, number, status, reviewers, max_rounds) values ($1, $2, 'active', $3, $4)
         on conflict (repo, number) do nothing returning *`,
        [ref.repo, ref.number, reviewers, maxRounds],
      );
      if (inserted) return { pr: toPr(inserted), created: true };
      const existing = await getPrByRef(ref);
      if (!existing) throw new Error(`pr ${ref.repo}#${ref.number} vanished during upsert`);
      if (existing.status !== 'merged' && existing.status !== 'closed') return { pr: existing, created: false };
      // Re-tracking a PR that was untracked/closed starts a fresh lifecycle with the new policy: a new session
      // (the old one may be pruned), and rounds/approve counts start over (queries filter on tracked_at).
      await q(`update review_requests set superseded = true where pr_id = $1 and done_at is null and not superseded`, [existing.id]);
      const r = await one(
        `update prs set status = 'active', reason = null, reviewers = $2, max_rounds = $3, run_count = 0, session_id = null,
           pending_merge = null, closed_at = null, tracked_at = now(), updated_at = now() where id = $1 returning *`,
        [existing.id, reviewers, maxRounds],
      );
      return { pr: toPr(r!), created: true };
    },

    async getPr(id) {
      const r = await one('select * from prs where id = $1', [id]);
      return r ? toPr(r) : null;
    },

    getPrByRef,

    async claimDmThread(prId, channel, ts) {
      const won = await one(
        'update prs set dm_channel = $2, dm_ts = $3, updated_at = now() where id = $1 and dm_ts is null returning *',
        [prId, channel, ts],
      );
      const r = won ?? (await one('select * from prs where id = $1', [prId]));
      if (!r) throw new Error(`pr ${prId} not found`);
      return toPr(r);
    },

    async getPrByDmThread(channel, ts) {
      const r = await one('select * from prs where dm_channel = $1 and dm_ts = $2 order by id desc limit 1', [channel, ts]);
      return r ? toPr(r) : null;
    },

    async listPrs(statuses) {
      const rows = statuses
        ? await q('select * from prs where status = any($1::text[]) order by id', [statuses])
        : await q('select * from prs order by id');
      return rows.map(toPr);
    },

    async updatePr(id, patch) {
      const { sets, params } = setClause(patch, PR_COLS, ['pendingMerge'], 2);
      if (!('updatedAt' in patch)) sets.push('updated_at = now()');
      const r = await one(`update prs set ${sets.join(', ')} where id = $1 returning *`, [id, ...params]);
      if (!r) throw new Error(`pr ${id} not found`);
      return toPr(r);
    },

    async addEvent(e) {
      const r = await one(
        `insert into events (pr_id, kind, payload, dedupe_key) values ($1, $2, $3::jsonb, $4)
         on conflict (dedupe_key) do nothing returning *`,
        [e.prId, e.kind, JSON.stringify(e.payload ?? {}), e.dedupeKey ?? null],
      );
      return r ? toEvent(r) : null;
    },

    async pendingEvents(prId) {
      return (await q('select * from events where pr_id = $1 and run_id is null order by id', [prId])).map(toEvent);
    },

    async claimEvents(eventIds, runId) {
      if (eventIds.length === 0) return;
      await q('update events set run_id = $2 where id = any($1::bigint[]) and run_id is null', [eventIds, runId]);
    },

    async unclaimEvents(eventIds, runId) {
      if (eventIds.length === 0) return;
      await q('update events set run_id = null where id = any($1::bigint[]) and run_id = $2', [eventIds, runId]);
    },

    async createRun(r) {
      const row = await one(
        `insert into runs (pr_id, job_id, session_id, status) values ($1, $2, $3, 'running') returning *`,
        [r.prId ?? null, r.jobId ?? null, r.sessionId ?? null],
      );
      return toRun(row!);
    },

    async updateRun(id, patch) {
      const { sets, params } = setClause(patch, RUN_COLS, ['usage', 'output'], 2);
      const r = sets.length
        ? await one(`update runs set ${sets.join(', ')} where id = $1 returning *`, [id, ...params])
        : await one('select * from runs where id = $1', [id]);
      if (!r) throw new Error(`run ${id} not found`);
      return toRun(r);
    },

    async runsByStatus(statuses) {
      return (await q('select * from runs where status = any($1::text[]) order by id', [statuses])).map(toRun);
    },

    async unappliedRuns() {
      return (
        await q(`select * from runs where status = 'ok' and output is not null and applied_at is null order by id`)
      ).map(toRun);
    },

    async lastRun(prId) {
      const r = await one('select * from runs where pr_id = $1 order by id desc limit 1', [prId]);
      return r ? toRun(r) : null;
    },

    async lastRunWithOutput(prId) {
      const r = await one('select * from runs where pr_id = $1 and output is not null order by id desc limit 1', [prId]);
      return r ? toRun(r) : null;
    },

    async addReviewRequest(r) {
      const row = await one(
        `insert into review_requests (pr_id, run_id, kind, bot, round, resend, channel, request_ts, head_sha)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (run_id, bot) do nothing returning *`,
        [r.prId, r.runId, r.kind, r.bot, r.round, r.resend, r.channel, r.requestTs, r.headSha ?? null],
      );
      return row ? toRequest(row) : null;
    },

    async requestsByThread(channel, requestTs) {
      return (
        await q('select * from review_requests where channel = $1 and request_ts = $2 order by id', [channel, requestTs])
      ).map(toRequest);
    },

    async openRequests(prId) {
      const base = 'select * from review_requests where done_at is null and not superseded';
      const rows = prId === undefined ? await q(`${base} order by id`) : await q(`${base} and pr_id = $1 order by id`, [prId]);
      return rows.map(toRequest);
    },

    async requestsForPr(prId) {
      return (
        await q(
          `select rr.* from review_requests rr join prs p on p.id = rr.pr_id
           where rr.pr_id = $1 and rr.sent_at >= p.tracked_at order by rr.id`,
          [prId],
        )
      ).map(toRequest);
    },

    async updateRequest(id, patch) {
      const { sets, params } = setClause(patch, REQ_COLS, [], 2);
      if (sets.length) await q(`update review_requests set ${sets.join(', ')} where id = $1`, [id, ...params]);
    },

    async roundsByBot(prId) {
      const rows = await q(
        `select rr.bot, max(rr.round) as round from review_requests rr join prs p on p.id = rr.pr_id
         where rr.pr_id = $1 and rr.kind = 'review' and rr.sent_at >= p.tracked_at group by rr.bot`,
        [prId],
      );
      return Object.fromEntries(rows.map((r) => [r.bot as string, num(r.round)]));
    },

    async addTimer(t) {
      const r = await one(
        'insert into timers (pr_id, kind, ref_id, fire_at, note) values ($1, $2, $3, $4, $5) returning *',
        [t.prId, t.kind, t.refId ?? null, t.fireAt, t.note ?? null],
      );
      return toTimer(r!);
    },

    async dueTimers(now) {
      return (
        await q('select * from timers where fired_at is null and fire_at <= $1 order by fire_at, id', [now])
      ).map(toTimer);
    },

    async fireTimer(id) {
      await q('update timers set fired_at = now() where id = $1 and fired_at is null', [id]);
    },

    // Cancelled timers are simply deleted; only unfired ones, so fired history stays.
    async cancelTimers(prId, kind, refId) {
      const params: unknown[] = [prId];
      let sql = 'delete from timers where pr_id = $1 and fired_at is null';
      if (kind !== undefined) sql += ` and kind = $${params.push(kind)}`;
      if (refId !== undefined) sql += ` and ref_id = $${params.push(refId)}`;
      await q(sql, params);
    },

    async addJob(j) {
      const r = await one(
        `insert into jobs (kind, repo, number, requested_by, channel, thread_ts)
         select $1, $2, $3, $4, $5, $6
         where not exists (select 1 from jobs where repo = $2 and number = $3 and kind = $1 and status = 'queued')
         returning *`,
        [j.kind, j.repo, j.number, j.requestedBy, j.channel, j.threadTs],
      );
      return r ? toJob(r) : null;
    },

    async nextQueuedJob() {
      const r = await one(`select * from jobs where status = 'queued' order by id limit 1`);
      return r ? toJob(r) : null;
    },

    async updateJob(id, patch) {
      const { sets, params } = setClause(patch, JOB_COLS, [], 2);
      if (sets.length) await q(`update jobs set ${sets.join(', ')} where id = $1`, [id, ...params]);
    },

    async jobsSince(since) {
      return (await q('select * from jobs where created_at >= $1 order by id', [since])).map(toJob);
    },

    async upsertWorkspace(w) {
      const r = await one(
        `insert into workspaces (kind, repo, number, path) values ($1, $2, $3, $4)
         on conflict (kind, repo, number) do update set path = excluded.path, last_used_at = now(), cleaned_at = null
         returning *`,
        [w.kind, w.repo, w.number, w.path],
      );
      return toWorkspace(r!);
    },

    async liveWorkspaces() {
      return (await q('select * from workspaces where cleaned_at is null order by id')).map(toWorkspace);
    },

    async markWorkspaceCleaned(id) {
      await q('update workspaces set cleaned_at = now() where id = $1', [id]);
    },

    async runsSince(since) {
      return (
        await q('select * from runs where coalesce(ended_at, started_at) >= $1 order by id', [since])
      ).map(toRun);
    },
  };
}

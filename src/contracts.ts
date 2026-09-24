// Shared contracts between modules (DESIGN v0.6). Modules depend on these interfaces, not on each other,
// so they can be built and tested independently. Changing a contract means updating every implementer.
import type { ShepherdOutput, ReviewOutput } from './output.js';

// ---------- rows (mirror migrations/001_init.sql; camelCase in TS) ----------

export type PrStatus = 'active' | 'needs_human' | 'paused' | 'merged' | 'closed';
export type PrRef = { repo: string; number: number }; // repo = "owner/name"

export type Pr = PrRef & {
  id: number;
  status: PrStatus;
  reason: string | null;
  sessionId: string | null;
  reviewers: string[];
  maxRounds: number;
  autoMerge: boolean;
  pendingMerge: { sha: string; title: string } | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

export type EventKind =
  | 'registered' | 'updated' | 'review_done' | 'approve_done' | 'reviewer_error' | 'reviewer_stalled'
  | 'owner' | 'timer' | 'merge_failed' | 'continue' | 'restarted';

export type InboxEvent = {
  id: number;
  prId: number | null;
  kind: EventKind;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: Date;
  runId: number | null; // null = not yet delivered
};

export type ReviewRequest = {
  id: number;
  prId: number;
  runId: number | null;
  kind: 'review' | 'approve';
  bot: string;
  round: number;
  resend: boolean;
  channel: string;
  requestTs: string;
  sentAt: Date;
  lastActivityAt: Date | null;
  acked: boolean;
  doneAt: Date | null;
  reviewUrl: string | null;
  firstLine: string | null;
  superseded: boolean;
  headSha: string | null; // approve requests: the head they were sent for (DESIGN §5.5 per-head cap)
};

export type RunStatus = 'running' | 'ok' | 'interrupted' | 'error' | 'max_turns' | 'bad_output' | 'quota';
export type Run = {
  id: number;
  prId: number | null;
  jobId: number | null;
  sessionId: string | null;
  status: RunStatus;
  turns: number | null;
  usage: Record<string, unknown> | null;
  output: ShepherdOutput | ReviewOutput | null;
  startedAt: Date;
  endedAt: Date | null;
  appliedAt: Date | null;
};

export type Job = PrRef & {
  id: number;
  kind: 'review' | 'approve';
  requestedBy: string;
  channel: string;
  threadTs: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  verdict: string | null; // review: approved|request_changes; approve: approved|failed
  createdAt: Date;
  endedAt: Date | null;
};

export type TimerKind = 'wait' | 'ack_timeout' | 'reply_timeout';
export type Timer = {
  id: number;
  prId: number;
  kind: TimerKind;
  refId: number | null; // review_requests.id for timeouts
  fireAt: Date;
  firedAt: Date | null;
  note: string | null;
};

export type WorkspaceKind = 'shepherd' | 'review';
export type Workspace = PrRef & {
  id: number;
  kind: WorkspaceKind;
  path: string;
  lastUsedAt: Date;
  cleanedAt: Date | null;
};

// ---------- persistence (implemented by src/store.ts over pg) ----------

export interface Store {
  // prs
  upsertPr(ref: PrRef, reviewers: string[], maxRounds: number): Promise<{ pr: Pr; created: boolean }>;
  getPr(id: number): Promise<Pr | null>;
  getPrByRef(ref: PrRef): Promise<Pr | null>;
  listPrs(statuses?: PrStatus[]): Promise<Pr[]>;
  updatePr(id: number, patch: Partial<Omit<Pr, 'id' | 'repo' | 'number' | 'createdAt'>>): Promise<Pr>;

  // inbox
  addEvent(e: { prId: number | null; kind: EventKind; payload?: Record<string, unknown>; dedupeKey?: string }): Promise<InboxEvent | null>; // null = duplicate
  pendingEvents(prId: number): Promise<InboxEvent[]>; // runId null, oldest first
  claimEvents(eventIds: number[], runId: number): Promise<void>;

  // runs
  createRun(r: { prId?: number; jobId?: number; sessionId?: string | null }): Promise<Run>;
  updateRun(id: number, patch: Partial<Omit<Run, 'id' | 'prId' | 'jobId' | 'startedAt'>>): Promise<Run>;
  runsByStatus(statuses: RunStatus[]): Promise<Run[]>;
  unappliedRuns(): Promise<Run[]>; // status ok, output not null, appliedAt null
  lastRun(prId: number): Promise<Run | null>;

  // review requests
  addReviewRequest(r: Omit<ReviewRequest, 'id' | 'sentAt' | 'lastActivityAt' | 'acked' | 'doneAt' | 'reviewUrl' | 'firstLine' | 'superseded' | 'headSha'> & { headSha?: string | null }): Promise<ReviewRequest | null>; // null = (runId, bot) already sent
  requestsByThread(channel: string, requestTs: string): Promise<ReviewRequest[]>;
  openRequests(prId?: number): Promise<ReviewRequest[]>; // doneAt null and not superseded
  updateRequest(id: number, patch: Partial<Pick<ReviewRequest, 'requestTs' | 'lastActivityAt' | 'acked' | 'doneAt' | 'reviewUrl' | 'firstLine' | 'superseded'>>): Promise<void>;
  roundsByBot(prId: number): Promise<Record<string, number>>; // max(round) per bot, kind=review, current tracking lifecycle

  // timers
  addTimer(t: { prId: number; kind: TimerKind; refId?: number | null; fireAt: Date; note?: string }): Promise<Timer>;
  dueTimers(now: Date): Promise<Timer[]>;
  fireTimer(id: number): Promise<void>;
  cancelTimers(prId: number, kind?: TimerKind, refId?: number): Promise<void>;

  // G3 jobs
  addJob(j: Omit<Job, 'id' | 'status' | 'verdict' | 'createdAt' | 'endedAt'>): Promise<Job | null>; // null = same PR+kind already queued (not running)
  nextQueuedJob(): Promise<Job | null>;
  updateJob(id: number, patch: Partial<Pick<Job, 'status' | 'verdict' | 'endedAt'>>): Promise<void>;
  jobsSince(since: Date): Promise<Job[]>;

  // workspaces
  upsertWorkspace(w: PrRef & { kind: WorkspaceKind; path: string }): Promise<Workspace>;
  liveWorkspaces(): Promise<Workspace[]>;
  markWorkspaceCleaned(id: number): Promise<void>;

  // report
  runsSince(since: Date): Promise<Run[]>;
}

// ---------- Slack (implemented by src/slack.ts over Bolt) ----------

export type SlackMessage = { channel: string; ts: string; threadTs?: string; user?: string; botId?: string; text: string };

export interface SlackPort {
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string; permalink: string }>;
  react(channel: string, ts: string, emoji: string): Promise<void>;
  dm(userId: string, text: string): Promise<void>;
  replies(channel: string, threadTs: string): Promise<SlackMessage[]>; // for restart backfill
  channelId(name: string): Promise<string>;
}

// What slack.ts calls back into; implemented by inbox/g3 and wired in index.ts.
export interface SlackHandlers {
  onThreadReply(msg: SlackMessage): Promise<void>; // any reply inside a thread in reviewChannel
  onCommand(cmd: Command, msg: SlackMessage): Promise<void>; // parsed @bot mention or owner DM
}

export type Command =
  | { kind: 'g3_review'; pr: PrRef; context: string }
  | { kind: 'g3_approve'; pr: PrRef; context: string }
  | { kind: 'status'; pr?: PrRef }
  | { kind: 'track' | 'untrack' | 'merge'; pr: PrRef }
  | { kind: 'tell'; pr: PrRef; text: string }
  | { kind: 'set'; pr: PrRef; rounds?: number; reviewers?: string[]; autoMerge?: boolean }
  | { kind: 'pause' | 'resume'; pr: PrRef | 'all' }
  | { kind: 'report' | 'help' }
  | { kind: 'unknown'; text: string };

// ---------- GitHub (implemented by src/github.ts over gh) ----------

export type PrMeta = PrRef & {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  author: string;
  isDraft: boolean;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  authorIsOrgMember: boolean;
};

export type GithubReview = {
  event: 'COMMENT' | 'APPROVE';
  body: string;
  commitId?: string;
  comments?: { path: string; line: number; body: string }[];
};

export interface GithubPort {
  verifyOwnerToken(token: string): Promise<boolean>; // GET /user with that token == config.owner.github; cached by hash 1h
  prMeta(ref: PrRef): Promise<PrMeta>;
  prStates(refs: PrRef[]): Promise<Map<string, PrMeta['state']>>; // key `${repo}#${number}`; batched GraphQL
  merge(ref: PrRef, sha: string, subject: string, body: string): Promise<{ ok: true } | { ok: false; error: string }>;
  postReview(ref: PrRef, review: GithubReview): Promise<{ url: string }>;
  comment(ref: PrRef, body: string): Promise<void>;
  ghRead(args: string[]): Promise<string>; // read-only allowlist proxy for G3 (DESIGN §7.2)
  login(): Promise<string>; // my login, for "approved as <login>"
}

// ---------- repos / workspaces (implemented by src/repos.ts) ----------

export interface Repos {
  // Stable path per (kind, pr): /data/worktrees/<owner>-<repo>-<n> or /data/review-worktrees/<owner>-<repo>-<n>. Registers in workspaces.
  ensureWorktree(kind: WorkspaceKind, ref: PrRef, headRef: string): Promise<string>;
  refreshReviewWorktree(ref: PrRef): Promise<string>; // fetch + checkout latest head (G3)
  cleanup(kind: WorkspaceKind, ref: PrRef): Promise<void>; // DESIGN §5.8 steps; only registered paths
}

// ---------- agent runs (implemented by src/scheduler.ts over the Agent SDK) ----------

export type RunResult =
  | { status: 'ok'; output: ShepherdOutput | ReviewOutput; sessionId: string; turns: number; usage: Record<string, unknown> }
  | { status: Exclude<RunStatus, 'ok' | 'running'>; sessionId: string | null; error?: string; resetAt?: Date };

export interface Scheduler {
  // Called whenever a PR's inbox may have new work. Handles debounce, steer into a live run, pools.
  poke(prId: number): void;
  // G3 review run; resolves with the structured review.
  runReview(job: Job, cwd: string, context: string): Promise<RunResult>;
  interruptAll(): Promise<void>;
  isRunning(prId: number): boolean;
}

// ---------- actuator (implemented by src/actuator.ts) ----------

export interface Actuator {
  // Execute run.output.next with policy/budget checks; idempotent (DESIGN §5.5: record first, then act).
  apply(run: Run): Promise<void>;
  // Timer fired (wait / ack_timeout / reply_timeout) → events.
  onTimer(timer: Timer): Promise<void>;
}

// ---------- injectable primitives (so every module is testable without network) ----------

// Runs a command without a shell. Rejects on non-zero exit with stderr in the message.
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

// The subset of pg.Pool that store.ts uses; @electric-sql/pglite satisfies it too (tests).
export type Db = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };

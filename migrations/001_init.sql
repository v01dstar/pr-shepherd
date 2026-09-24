-- DESIGN.md §10
create table prs (
  id bigserial primary key, repo text not null, number int not null,
  status text not null,                    -- active|needs_human|paused|merged|closed
  reason text,                             -- why the PR needs a human
  session_id text,
  reviewers text[] not null,
  max_rounds int not null default 4,
  auto_merge bool not null default true,
  pending_merge jsonb,                     -- {sha, title} awaiting owner confirmation when auto_merge=off
  run_count int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closed_at timestamptz,
  unique (repo, number)
);

create table review_requests (             -- one row per request to each bot
  id bigserial primary key, pr_id bigint not null references prs, run_id bigint,
  kind text not null,                      -- review|approve
  bot text not null, round int not null, resend bool not null default false,
  channel text not null, request_ts text not null,
  sent_at timestamptz not null default now(), last_activity_at timestamptz, acked bool not null default false,
  done_at timestamptz, review_url text, first_line text,
  superseded bool not null default false,
  unique (run_id, bot)                     -- dedupe when a run is replayed
);
create index on review_requests (channel, request_ts);

create table events (                      -- inbox
  id bigserial primary key, pr_id bigint references prs, kind text not null,
  payload jsonb not null default '{}', dedupe_key text unique,
  created_at timestamptz not null default now(), run_id bigint   -- run it was delivered to; null = pending
);

create table runs (
  id bigserial primary key, pr_id bigint references prs, job_id bigint,
  session_id text, status text not null,   -- running|ok|interrupted|error|max_turns|bad_output|quota
  turns int, usage jsonb, output jsonb,
  started_at timestamptz not null default now(), ended_at timestamptz, applied_at timestamptz
);

create table jobs (                        -- G3
  id bigserial primary key, kind text not null, repo text not null, number int not null,
  requested_by text not null, channel text not null, thread_ts text not null,
  status text not null default 'queued',   -- queued|running|done|failed
  verdict text,                            -- review: approved|request_changes；approve: approved|failed
  created_at timestamptz not null default now(), ended_at timestamptz
);

create table timers (
  id bigserial primary key, pr_id bigint not null references prs,
  kind text not null,                      -- wait|ack_timeout|reply_timeout
  ref_id bigint,                           -- review_requests.id this timeout belongs to
  fire_at timestamptz not null, fired_at timestamptz, note text
);

create table workspaces (
  id bigserial primary key, kind text not null,   -- shepherd|review
  repo text not null, number int not null, path text not null unique,
  last_used_at timestamptz not null default now(), cleaned_at timestamptz,
  unique (kind, repo, number)
);

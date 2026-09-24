-- DESIGN §11.1: advance warning before a credential expires. One row per credential; a new token
-- (different fingerprint) resets first_seen_at and the reminders already sent.
create table credential_expiry (
  name text primary key,                    -- github | claude
  fingerprint text not null,                -- sha256 prefix of the token, never the token
  first_seen_at timestamptz not null default now(),
  expires_at timestamptz,                   -- null = no known expiry
  reminded int[] not null default '{}',     -- thresholds (days) already announced
  updated_at timestamptz not null default now()
);

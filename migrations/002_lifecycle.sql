-- DESIGN §5.5: request_approve is capped per head SHA, so each approve request records the head it was sent for.
alter table review_requests add column head_sha text;
-- Re-tracking a closed PR starts a fresh lifecycle (§5.2); rounds and approve counts only look at requests since then.
alter table prs add column tracked_at timestamptz;
update prs set tracked_at = created_at;
alter table prs alter column tracked_at set not null;
alter table prs alter column tracked_at set default now();

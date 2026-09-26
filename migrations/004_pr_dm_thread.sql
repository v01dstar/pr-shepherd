-- DESIGN §5.6: each PR has one DM thread with the owner. The first DM about a PR starts it, later ones reply in
-- it, and anything the owner writes in it reaches the PR's agent as an `owner` event.
alter table prs add column dm_channel text;
alter table prs add column dm_ts text;
create index on prs (dm_channel, dm_ts);

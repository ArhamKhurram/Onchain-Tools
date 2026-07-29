-- Missed-runner alerts: make the dedupe row refreshable.
--
-- recordAlert used a plain INSERT against the expression unique index
-- (user_id, lower(token_address)). The first alert for a token inserted fine;
-- once its cooldown elapsed the re-insert hit 23505, was swallowed, and the
-- stale row was never refreshed — so a user/token pair could alert at most
-- once, ever. The poller now UPSERTs instead, but PostgREST's on_conflict can
-- only name plain columns, not the lower() expression. The writer has always
-- lowercased token_address, so promote that convention into the schema:
-- normalize any stray rows, then replace the expression index with a column
-- unique constraint the upsert can target.

update public.missed_runner_alerts
  set token_address = lower(token_address)
  where token_address <> lower(token_address);

-- If normalizing created duplicates, keep the most recent alert per pair.
delete from public.missed_runner_alerts a
  using public.missed_runner_alerts b
  where a.user_id = b.user_id
    and a.token_address = b.token_address
    and a.id <> b.id
    and (a.triggered_at < b.triggered_at
         or (a.triggered_at = b.triggered_at and a.id < b.id));

drop index if exists public.idx_missed_runner_alerts_user_token;

alter table public.missed_runner_alerts
  add constraint missed_runner_alerts_user_token_key
  unique (user_id, token_address);

-- The unique key is only meaningful while addresses stay normalized.
alter table public.missed_runner_alerts
  add constraint missed_runner_alerts_token_address_lowercase
  check (token_address = lower(token_address));

-- FOMO new-join alerts: global poll cursor.
--
-- The join watcher (backend/src/fomo/joinWatcher.ts) polls fomo.family's own
-- social feed for `user_with_smart_following` items — notable accounts that
-- just joined — and raises a global fomo_join signal. This single-row table
-- persists its place so a restart neither re-alerts a backlog nor loses it:
--
--   last_feed_id   -- newest feed item id seen (the feed's pagination cursor)
--   seen_user_ids  -- bounded jsonb array of recently alerted fomo user ids;
--                     dedupe backstop for when the same user resurfaces under
--                     a new feed id (feed re-ranking, lost cursor write)
--   seeded         -- cold-start guard: until seeded, record newest and fire
--                     nothing (mirrors pump_callout_poll_state.seeded)
--
-- Service-role only, like the other poller-state singletons.

create table public.fomo_join_poll_state (
  id boolean primary key default true,   -- single-row table: id is always true
  last_feed_id text,
  seen_user_ids jsonb not null default '[]'::jsonb,
  seeded boolean not null default false,
  last_polled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint fomo_join_poll_state_singleton check (id)
);
insert into public.fomo_join_poll_state (id) values (true) on conflict (id) do nothing;

-- Written/read exclusively by the backend service role (which bypasses RLS).
-- RLS is enabled with no policies so direct client access is denied by default.
alter table public.fomo_join_poll_state enable row level security;

create trigger fomo_join_poll_state_updated_at
  before update on public.fomo_join_poll_state
  for each row execute function public.update_updated_at();

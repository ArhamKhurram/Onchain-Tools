-- Pump.fun KOL callout tracking (fan-out-on-write).
--
-- Users follow pump.fun callers by @username; the caller is stored by WALLET
-- ADDRESS (pump uses the wallet pubkey as the user id, which is exactly the
-- `userId` carried on every callout in the global feed). A single global poll of
-- frontend-api-v3.pump.fun/callout/recent drives fan-out: each new callout whose
-- caller is followed is pushed to every OCT user following that caller. The feed
-- is keyless, so there is no shared service credential to persist (unlike FOMO).
--
--   pump_tracked_callers     -- per-user follows (client-facing, RLS'd)
--   pump_callout_poll_state  -- single-row global cursor (service-role only)

-- ---------------------------------------------------------------------------
-- pump_tracked_callers: which pump callers each OCT user follows.
-- ---------------------------------------------------------------------------
create table public.pump_tracked_callers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  caller_address text not null,          -- wallet pubkey == callout.userId (match key)
  username text,
  display_name text,
  avatar text,
  source text not null default 'follow', -- 'follow' | 'leaderboard' | 'kol'
  notify_pushover boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, caller_address)
);
create index idx_pump_tracked_callers_user on public.pump_tracked_callers(user_id);
-- Reverse fan-out: "who follows this caller?" runs on every matched callout.
create index idx_pump_tracked_callers_address on public.pump_tracked_callers(caller_address);

-- ---------------------------------------------------------------------------
-- pump_callout_poll_state: single-row cursor persisting global poll progress so
-- a restart neither re-fires a backlog nor loses its place. `seeded` guards the
-- first run: until the cursor is seeded, the poll records the newest id and
-- fires nothing (never pings a cold-start backlog).
-- ---------------------------------------------------------------------------
create table public.pump_callout_poll_state (
  id boolean primary key default true,   -- single-row table: id is always true
  last_callout_id text,
  seeded boolean not null default false,
  last_polled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint pump_callout_poll_state_singleton check (id)
);
insert into public.pump_callout_poll_state (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.pump_tracked_callers    enable row level security;
alter table public.pump_callout_poll_state enable row level security;

-- Clients manage only their own follows (mirrors fomo_tracked_users).
create policy "Users manage own pump tracked callers"
  on public.pump_tracked_callers for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Admins read all pump tracked callers"
  on public.pump_tracked_callers for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- pump_callout_poll_state is written/read exclusively by the backend service
-- role (which bypasses RLS). RLS is enabled with no policies so direct client
-- access is denied by default.

create trigger pump_callout_poll_state_updated_at
  before update on public.pump_callout_poll_state
  for each row execute function public.update_updated_at();

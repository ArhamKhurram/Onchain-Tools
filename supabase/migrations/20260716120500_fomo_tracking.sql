-- FOMO (fomo.family) user tracking (fan-out-on-write).
--
-- Users track FOMO traders by username. A single global poll of FOMO's
-- trading-activity feed drives fan-out: each trade is routed to every OCT user
-- tracking that FOMO user. Auth is a single shared FOMO service account.
--
--   fomo_tracked_users  -- per-user subscriptions (client-facing, RLS'd)
--   fomo_trade_events   -- dispatched-trade log / history (service-role only)
--   fomo_poll_state     -- single-row global poll cursor (service-role only)

-- ---------------------------------------------------------------------------
-- fomo_tracked_users: which FOMO traders each OCT user follows.
-- ---------------------------------------------------------------------------
create table public.fomo_tracked_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fomo_user_id text not null,          -- stable FOMO id (used for reverse fan-out)
  fomo_handle text,
  display_name text,
  notify_pushover boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, fomo_user_id)
);
create index idx_fomo_tracked_users_user on public.fomo_tracked_users(user_id);
-- Reverse fan-out: "who tracks this FOMO user?" runs on every dispatched trade.
create index idx_fomo_tracked_users_fomo_user on public.fomo_tracked_users(fomo_user_id);

-- ---------------------------------------------------------------------------
-- fomo_trade_events: log of trades the backend has dispatched. Written by the
-- poller (service role). trade_id is FOMO's own id and drives dedup.
-- ---------------------------------------------------------------------------
create table public.fomo_trade_events (
  id uuid primary key default gen_random_uuid(),
  fomo_user_id text not null,
  fomo_handle text,
  side text,                            -- 'buy' | 'sell'
  token_address text,
  token_symbol text,
  network_id bigint,
  usd_value numeric,
  raw jsonb,                            -- full raw trade payload for later verification
  trade_id text,                        -- FOMO's id for dedup (nullable if unknown)
  created_at timestamptz not null default now()
);
create index idx_fomo_trade_events_fomo_user on public.fomo_trade_events(fomo_user_id);
create index idx_fomo_trade_events_created_at on public.fomo_trade_events(created_at desc);
-- Dedup guard: never dispatch/insert the same FOMO trade twice.
create unique index uniq_fomo_trade_events_trade_id
  on public.fomo_trade_events(trade_id) where trade_id is not null;

-- ---------------------------------------------------------------------------
-- fomo_poll_state: single-row cursor persisting global poll progress and the
-- (rotating) shared refresh token so restarts don't lose the cursor or creds.
-- ---------------------------------------------------------------------------
create table public.fomo_poll_state (
  id boolean primary key default true,  -- single-row table: id is always true
  last_trade_id text,
  last_polled_at timestamptz,
  refresh_token text,                   -- persisted rotated Privy refresh token
  updated_at timestamptz not null default now(),
  constraint fomo_poll_state_singleton check (id)
);
insert into public.fomo_poll_state (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.fomo_tracked_users enable row level security;
alter table public.fomo_trade_events  enable row level security;
alter table public.fomo_poll_state    enable row level security;

-- Clients manage only their own tracked FOMO users (mirrors user_tracked_wallets).
create policy "Users manage own fomo tracked users"
  on public.fomo_tracked_users for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Admins read all fomo tracked users"
  on public.fomo_tracked_users for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- fomo_trade_events and fomo_poll_state are written/read exclusively by the
-- backend service role (which bypasses RLS). RLS is enabled with no policies so
-- direct client (anon/authenticated) access is denied by default.

create trigger fomo_poll_state_updated_at
  before update on public.fomo_poll_state
  for each row execute function public.update_updated_at();

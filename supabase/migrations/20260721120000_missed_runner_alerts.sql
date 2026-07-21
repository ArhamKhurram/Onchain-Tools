-- Missed-runner alert dedupe + extend wallet chains (base, robinhood).

create table public.missed_runner_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_address text not null,
  triggered_at timestamptz not null default now(),
  cooldown_until timestamptz not null,
  mc_at_call numeric,
  mc_now numeric,
  multiplier numeric,
  channel_name text,
  token_symbol text
);

create unique index idx_missed_runner_alerts_user_token
  on public.missed_runner_alerts (user_id, lower(token_address));

create index idx_missed_runner_alerts_cooldown
  on public.missed_runner_alerts (user_id, cooldown_until);

alter table public.missed_runner_alerts enable row level security;

create policy "Users read own missed runner alerts"
  on public.missed_runner_alerts for select
  using (auth.uid() = user_id);

-- Inserts/updates are backend-only via service role (bypasses RLS).

-- Extend tracked wallet chains (base + robinhood for HOOD feed).
alter table public.user_tracked_wallets
  drop constraint if exists user_tracked_wallets_chain_check;

alter table public.user_tracked_wallets
  add constraint user_tracked_wallets_chain_check
  check (chain in ('bsc', 'ethereum', 'solana', 'base', 'robinhood'));

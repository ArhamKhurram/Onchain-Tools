-- Revival alert log + 24h outcome tracking.
--
-- Every fired revival ignition alert is persisted here (revival is the app's
-- rarest, loudest signal — a missed banner must be reviewable later, with the
-- mcap it fired at). The peak_* columns are the outcome tracker's state: the
-- poller keeps watching the token's candles for 24h after the alert and
-- updates the peak on improvement, so "did the alert matter" survives
-- restarts. outcome_window_closed_at is null while tracking is live.
--
-- Same trust model as missed_runner_alerts: users read their own rows via
-- RLS; inserts/updates are backend-only via the service role (bypasses RLS).

create table public.revival_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mint text not null,
  symbol text,
  network text not null default 'solana',
  price_usd numeric,
  mcap_usd numeric,
  atr_z numeric not null default 0,
  rvol numeric not null default 0,
  triggered_at timestamptz not null default now(),
  peak_price_usd numeric,
  peak_mcap_usd numeric,
  peak_multiple numeric,
  peak_at timestamptz,
  outcome_window_closed_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_revival_alerts_user_time
  on public.revival_alerts (user_id, triggered_at desc);

-- Resume-on-boot scan: open outcome windows only.
create index idx_revival_alerts_open
  on public.revival_alerts (triggered_at)
  where outcome_window_closed_at is null;

alter table public.revival_alerts enable row level security;

create policy "Users read own revival alerts"
  on public.revival_alerts for select
  using (auth.uid() = user_id);

-- Inserts/updates are backend-only via service role (bypasses RLS).

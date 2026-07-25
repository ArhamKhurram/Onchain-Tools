-- Per-trader poll cursors + per-subscriber delivery log for FOMO fan-out.
--
-- One global poll per unique fomo_user_id; each new swap is stored once in
-- fomo_trade_events, then delivered to every OCT user tracking that trader.

-- ---------------------------------------------------------------------------
-- fomo_activity_cursors: global poll progress per FOMO trader (not per OCT user).
-- ---------------------------------------------------------------------------
create table public.fomo_activity_cursors (
  fomo_user_id text primary key,
  last_activity_id text,
  cursor_seeded boolean not null default false,
  updated_at timestamptz not null default now()
);

create trigger fomo_activity_cursors_updated_at
  before update on public.fomo_activity_cursors
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- fomo_trade_deliveries: which OCT users received which stored trade event.
-- ---------------------------------------------------------------------------
create table public.fomo_trade_deliveries (
  id uuid primary key default gen_random_uuid(),
  trade_event_id uuid not null references public.fomo_trade_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  unique (trade_event_id, user_id)
);

create index idx_fomo_trade_deliveries_user on public.fomo_trade_deliveries(user_id);
create index idx_fomo_trade_deliveries_trade on public.fomo_trade_deliveries(trade_event_id);

alter table public.fomo_activity_cursors enable row level security;
alter table public.fomo_trade_deliveries enable row level security;

-- Price Alerts v1 — operator-set levels on operator-chosen tokens.
--
-- The inverse of revival/breakout: no detection, no scoring, no discovery. The
-- operator names the token and the number ("ping me if FTR crosses 150K mcap");
-- the poller reports only the CROSSING. Revival structurally cannot cover this
-- — its universe is built from contracts detected in the user's own feed and
-- gated on dormancy vs the token's prior 72h peak, so a token nobody posted is
-- invisible to it by design. See backend/src/priceAlerts/.
--
-- last_seen_usd is the crossing state. It starts NULL and the poller's FIRST
-- observation only records it (never fires), so an alert armed on a token that
-- is already past its target does not fire instantly. A fired alert is
-- one-shot: status flips to 'fired' and stays there.
--
-- 'disabled' is reserved — no v1 UI writes it, but the poller already skips it,
-- so a future park/re-arm toggle needs no migration.
--
-- Same trust model as journal_* / revival_alerts: users read their own rows via
-- RLS; inserts/updates/deletes come from the backend via the service role
-- (bypasses RLS). This migration is applied BY HAND; the backend tolerates its
-- absence (warns once, price alerts idle) — see
-- storage/supabase/priceAlertsRepo.ts.

create table public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Solana only in v1; the column exists so another chain needs no migration.
  chain text not null default 'solana',
  mint text not null,
  symbol text,
  direction text not null check (direction in ('above', 'below')),
  -- The level, in USD, measured in `metric`.
  target_usd numeric not null check (target_usd > 0),
  -- 'mcap' by default: the operator thinks in market caps, not unit prices.
  metric text not null default 'mcap' check (metric in ('mcap', 'price')),
  status text not null default 'armed' check (status in ('armed', 'fired', 'disabled')),
  -- Why this level matters. Free text, echoed back in the alert itself.
  note text,
  -- Crossing state: last real observation, in `metric` units. NULL = never
  -- observed. A poll with no pair/price leaves this UNTOUCHED (abstain), so the
  -- next real observation is compared against the last real one.
  last_seen_usd numeric,
  last_seen_at timestamptz,
  fired_at timestamptz,
  fired_value_usd numeric,
  created_at timestamptz not null default now()
);

create index idx_price_alerts_user on public.price_alerts (user_id, created_at desc);
-- The poller's cross-user sweep: armed alerts only, so an operator with zero
-- armed alerts costs zero upstream requests.
create index idx_price_alerts_armed
  on public.price_alerts (status)
  where status = 'armed';

alter table public.price_alerts enable row level security;

create policy "Users read own price alerts"
  on public.price_alerts for select
  using (auth.uid() = user_id);

-- Inserts/updates/deletes are backend-only via service role (bypasses RLS).

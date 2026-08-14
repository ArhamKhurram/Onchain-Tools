-- Trade Journal v1 — the operator's OWN wallets (distinct from tracked/copy
-- wallets), their normalized swaps, and FIFO trade episodes.
--
-- journal_wallets   : per-user list of own Solana wallets + ingestion cursor.
-- journal_trades    : normalized swap legs (delta method over Helius Enhanced
--                     Transactions; see backend/src/journal/normalize.ts).
-- journal_positions : FIFO episodes per (wallet, token). id is the
--                     DETERMINISTIC episode key `${walletId}|${mint}|${openedAt}`
--                     (text, not uuid) so the pairing engine's rebuilds upsert
--                     in place. last_price_* are side-written by the
--                     volume-death poller.
--
-- Same trust model as revival_alerts: users read their own rows via RLS;
-- inserts/updates come from the backend via the service role (bypasses RLS).
-- This migration is applied BY HAND; the backend tolerates its absence
-- (warns once, journal idles) — see storage/supabase/journalRepo.ts.

create table public.journal_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  label text,
  chain text not null default 'solana',
  last_signature text,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, address)
);

create index idx_journal_wallets_user on public.journal_wallets (user_id);

create table public.journal_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null references public.journal_wallets(id) on delete cascade,
  wallet_address text not null,
  mint text not null,
  symbol text,
  side text not null check (side in ('buy', 'sell')),
  amount_token numeric not null,
  amount_sol numeric,
  amount_usd numeric,
  tx_signature text not null,
  dex text,
  ts timestamptz not null,
  created_at timestamptz not null default now(),
  -- Idempotent ingestion: cursor overlap / re-polls upsert-ignore on this key.
  unique (wallet_id, tx_signature, mint, side)
);

create index idx_journal_trades_user_time
  on public.journal_trades (user_id, ts desc);
create index idx_journal_trades_wallet_time
  on public.journal_trades (wallet_id, ts desc);

create table public.journal_positions (
  -- Deterministic episode key `${walletId}|${mint}|${openedAt}` — text on purpose.
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null references public.journal_wallets(id) on delete cascade,
  wallet_address text not null,
  mint text not null,
  symbol text,
  status text not null default 'open' check (status in ('open', 'closed')),
  acquired_token numeric not null default 0,
  remaining_token numeric not null default 0,
  cost_sol numeric not null default 0,
  cost_usd numeric,
  realized_pnl_sol numeric not null default 0,
  realized_pnl_usd numeric,
  pnl_incomplete boolean not null default false,
  opened_at timestamptz not null,
  closed_at timestamptz,
  last_trade_at timestamptz not null,
  -- Volume-death poller side-writes (current-value display, no extra requests).
  last_price_usd numeric,
  last_price_at timestamptz,
  updated_at timestamptz not null default now()
);

create index idx_journal_positions_user on public.journal_positions (user_id, last_trade_at desc);
-- The volume-death poller's cross-user sweep: open positions only.
create index idx_journal_positions_open
  on public.journal_positions (status)
  where status = 'open';

alter table public.journal_wallets enable row level security;
alter table public.journal_trades enable row level security;
alter table public.journal_positions enable row level security;

create policy "Users read own journal wallets"
  on public.journal_wallets for select
  using (auth.uid() = user_id);

create policy "Users read own journal trades"
  on public.journal_trades for select
  using (auth.uid() = user_id);

create policy "Users read own journal positions"
  on public.journal_positions for select
  using (auth.uid() = user_id);

-- Inserts/updates/deletes are backend-only via service role (bypasses RLS).

-- On-chain buy/sell movement alerting for Directory wallets (user_tracked_wallets).
--
-- Until now user_tracked_wallets is a passive watchlist: a user adds a Solana
-- wallet (directly, or via the pump "Track on-chain" action) and gets no ping when
-- it trades. The wallet-movement poller closes that gap by polling each distinct
-- tracked SOLANA wallet's recent swaps (keyless profile-api.pump.fun/transactions)
-- and fanning each NEW swap out to every user tracking that wallet.
--
-- This mirrors the pump_callout_poll_state model, NOT the fomo store-and-fan-out
-- one: dedup is by a single per-wallet cursor (the newest seen tx_hash), so a swap
-- is processed exactly once per poll cycle and there is no per-subscriber delivery
-- table to keep. One table is enough.
--
--   wallet_movement_cursors  -- per-wallet poll progress (service-role only)
--
-- EVM tracked wallets are out of scope for v1 — only chain = 'solana' rows are
-- polled — so this cursor is keyed by the bare Solana address.

-- ---------------------------------------------------------------------------
-- wallet_movement_cursors: global poll progress per tracked wallet (not per OCT
-- user). `seeded` guards the first run: until the cursor is seeded, the poll
-- records the newest tx_hash and fires nothing (never pings a cold-start backlog
-- of historical swaps).
-- ---------------------------------------------------------------------------
create table public.wallet_movement_cursors (
  wallet_address text primary key,        -- Solana wallet pubkey (base58)
  last_tx_hash text,                      -- newest swap tx_hash seen last poll
  cursor_seeded boolean not null default false,
  last_polled_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger wallet_movement_cursors_updated_at
  before update on public.wallet_movement_cursors
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- wallet_movement_cursors is written/read exclusively by the backend service role
-- (which bypasses RLS), exactly like pump_callout_poll_state. RLS is enabled with
-- NO policies so any direct client (PostgREST/anon/authenticated) access is denied
-- by default.
-- ---------------------------------------------------------------------------
alter table public.wallet_movement_cursors enable row level security;

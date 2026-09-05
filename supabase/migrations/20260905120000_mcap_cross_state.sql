-- Market-cap crossing state — the last market cap seen for each token the
-- chain-wide 750K crossing poller watches.
--
-- APPLIED BY HAND. The backend tolerates this migration being absent: the store
-- warns ONCE and falls back to an in-memory map, so the poller keeps working
-- and only loses the "crossings survive a restart" guarantee. See
-- backend/src/mcapCross/state.ts, and the same contract on network_scans
-- (20260812160000).
--
-- NO user_id, DELIBERATELY. "SOMECOIN crossed $750K" is a fact about the chain,
-- identical for every subscriber. One row per (address, network) keeps both the
-- table and the upstream reads independent of how many people are watching —
-- the same shape as token peaks and network_scans. Nothing here is personal
-- data: an address, a chain, a number and two timestamps.

create table if not exists public.mcap_cross_state (
  address text not null,
  network text not null,
  -- The last REAL observation. Never written on an abstain (no pair, no market
  -- cap, failed request), so the next reading is always compared against the
  -- last reading rather than against a gap.
  last_seen_mcap numeric not null,
  last_seen_at timestamptz not null,
  -- When this token last produced an alert. Drives the 24h cooldown that stops
  -- a market cap oscillating around the threshold from pinging every cycle —
  -- every one of those crossings is genuine, and all but the first are noise.
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (address, network)
);

-- The poller sweeps by "have any of these tokens fired recently"; the primary
-- key already covers the per-token read.
create index if not exists mcap_cross_state_fired_at_idx
  on public.mcap_cross_state (fired_at desc nulls last);

alter table public.mcap_cross_state enable row level security;

-- Read-only for signed-in users, so a console surface can be added later
-- without a second migration. No insert/update/delete policies: only the
-- backend writes, via the service role (which bypasses RLS).
drop policy if exists "Authenticated users can read mcap cross state" on public.mcap_cross_state;
create policy "Authenticated users can read mcap cross state"
  on public.mcap_cross_state for select
  to authenticated
  using (true);

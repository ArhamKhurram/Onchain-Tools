-- Flap RWA-stock watcher state — the set of underlying stock assets already
-- seen on each chain, plus the last block scanned.
--
-- APPLIED BY HAND. The backend tolerates this migration being absent: the store
-- warns ONCE and falls back to an in-memory map, so the poller keeps working
-- and only loses "the history seed survives a restart". Because a re-seed only
-- re-marks EXISTING assets WITHOUT alerting, the worst case of a missing table
-- is silence, never a false alert. See backend/src/flap/state.ts, and the same
-- contract on mcap_cross_state (20260905120000) and network_scans (20260812160000).
--
-- NO user_id, DELIBERATELY. "Flap listed $FXIon on BNB" is a fact about the
-- chain, identical for every subscriber. ONE row per chain — two rows total —
-- holds the known-asset set and the block cursor, keeping both the table and the
-- upstream RPC reads independent of how many people are watching. Nothing here
-- is personal data: a chain name, a block number and a list of token addresses.

create table if not exists public.flap_chain_state (
  -- 'bsc' | 'robinhood'. One row per watched chain.
  chain text primary key,
  -- Highest block scanned so far; the next poll resumes at +1.
  last_scanned_block bigint not null default 0,
  -- Has the initial history seed run? Until it has, nothing alerts — the seed
  -- marks every existing stock asset so day one does not dump the dozen Flap
  -- already lists.
  seeded boolean not null default false,
  -- The dedupe set: lowercased RWA asset addresses already seen. A first-seen
  -- asset is a NEW STOCK and alerts; a known one is another meme vs an existing
  -- stock and is ignored.
  known_assets jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.flap_chain_state enable row level security;

-- Read-only for signed-in users, so a console surface can be added later
-- without a second migration. No insert/update/delete policies: only the
-- backend writes, via the service role (which bypasses RLS).
drop policy if exists "Authenticated users can read flap chain state" on public.flap_chain_state;
create policy "Authenticated users can read flap chain state"
  on public.flap_chain_state for select
  to authenticated
  using (true);

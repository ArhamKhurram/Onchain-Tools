-- Global-first scan intelligence (Callers radar).
--
-- APPLIED BY HAND. The backend tolerates this migration being absent: the
-- network-scan pool warns once and idles, and contract writes retry without
-- the new columns (see backend/src/network/scanPool.ts and
-- backend/src/storage/supabase/contractsRepo.ts).
--
-- 1) network_scans — the anonymous cross-user first-scan pool.
--
--    PRIVACY IS STRUCTURAL: rows are unlinkable to users or groups by
--    construction. NO user_id, NO room/channel/guild/server ids, NO caller
--    names, NO message text — only the token address + chain, when the OCT
--    network first saw it, and the market cap at that moment if known.
--    First writer wins (insert .. on conflict do nothing); fdv_at_first may be
--    filled once, only by an enrichment that lands within ~2 minutes of
--    first_seen_at — never backfilled with a later market cap.

create table if not exists public.network_scans (
  address text not null,
  chain text not null default 'solana',
  first_seen_at timestamptz not null,
  fdv_at_first numeric,
  created_at timestamptz not null default now(),
  primary key (address, chain)
);

alter table public.network_scans enable row level security;

-- Read-only for signed-in users; the pool is a shared, anonymous dataset.
-- No insert/update/delete policies: only the backend writes, via the service
-- role (which bypasses RLS).
drop policy if exists "Authenticated users can read network scans" on public.network_scans;
create policy "Authenticated users can read network scans"
  on public.network_scans for select
  to authenticated
  using (true);

-- 2) Per-user contracts rows learn Rick's cross-server first-caller footer
--    ("espadabtw @ 49.3K · 86x · 10h"). This is Rick's public cross-server
--    data, stored on the user's OWN rows — unrelated to the anonymous pool.

alter table public.contracts
  add column if not exists first_caller_name text,
  add column if not exists first_call_mcap_usd numeric,
  add column if not exists first_call_at timestamptz;

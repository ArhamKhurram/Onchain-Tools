-- Wallet leaderboard: curated GLOBAL reference data (not tenant-scoped).
-- Replaces the JSON wallet import files. Client read-only; writes via service role.

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  chain text not null check (chain in ('bsc','ethereum','solana')),
  name text not null default '',
  emoji text not null default '',
  profile text not null default 'unclassified',
  created_at timestamptz not null default now(),
  unique (chain, address)
);
create index idx_wallets_chain on public.wallets(chain);

alter table public.wallets enable row level security;

-- Global read for everyone (anon + authenticated); no client write policy,
-- so only the service_role key can insert/update/delete.
create policy "Wallets are readable by anyone" on public.wallets
  for select using (true);

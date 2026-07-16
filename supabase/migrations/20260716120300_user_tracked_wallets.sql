-- Per-user tracked wallets (replaces global public wallets table).
-- Users can only read/write their own rows; admins can read all.

create table public.user_tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  chain text not null check (chain in ('bsc','ethereum','solana')),
  name text not null default '',
  emoji text not null default '',
  profile text not null default 'unclassified',
  alerts_on_toast boolean not null default true,
  alerts_on_feed boolean not null default true,
  alerts_on_bubble boolean not null default true,
  sound text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chain, address)
);

create index idx_user_tracked_wallets_user on public.user_tracked_wallets(user_id);
create index idx_user_tracked_wallets_chain on public.user_tracked_wallets(chain);

alter table public.user_tracked_wallets enable row level security;

create policy "Users manage own tracked wallets"
  on public.user_tracked_wallets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Admins read all tracked wallets"
  on public.user_tracked_wallets for select
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create trigger user_tracked_wallets_updated_at
  before update on public.user_tracked_wallets
  for each row execute function public.update_updated_at();

-- Retire global wallets table (was public read — incorrect for multi-tenant)
drop policy if exists "Wallets are readable by anyone" on public.wallets;
drop table if exists public.wallets;

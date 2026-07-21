-- Wallets the user trades from (missed-runner balance checks). Separate from whale watchlist.

create table public.user_holding_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  address text not null,
  chain text not null check (chain in ('bsc', 'ethereum', 'solana', 'base', 'robinhood')),
  label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chain, address)
);

create index idx_user_holding_wallets_user on public.user_holding_wallets (user_id);

alter table public.user_holding_wallets enable row level security;

create policy "Users manage own holding wallets"
  on public.user_holding_wallets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger user_holding_wallets_updated_at
  before update on public.user_holding_wallets
  for each row execute function public.update_updated_at();

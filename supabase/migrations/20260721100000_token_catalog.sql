-- Global token metadata cache (service-role writes; shared across tenants).

create table public.token_catalog (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  chain text not null,
  evm_chain text not null default '',
  symbol text,
  name text,
  pair text,
  fdv numeric,
  liq numeric,
  price_usd numeric,
  enriched_at timestamptz not null default now(),
  source text,
  confidence text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (address, chain, evm_chain)
);

create index idx_token_catalog_lookup
  on public.token_catalog (lower(address), chain, evm_chain);

create index idx_token_catalog_enriched_at
  on public.token_catalog (enriched_at desc);

alter table public.token_catalog enable row level security;

create trigger token_catalog_updated_at
  before update on public.token_catalog
  for each row execute function public.update_updated_at();

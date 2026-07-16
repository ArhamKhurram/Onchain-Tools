-- Enrich contracts with token metadata from Rick embeds / DexScreener.

alter table public.contracts
  add column if not exists token_name text,
  add column if not exists token_symbol text,
  add column if not exists token_pair text,
  add column if not exists description text,
  add column if not exists fdv_at_call numeric,
  add column if not exists fdv_at_call_display text,
  add column if not exists liquidity_usd numeric,
  add column if not exists liquidity_display text,
  add column if not exists volume_usd numeric,
  add column if not exists volume_display text,
  add column if not exists price_usd numeric,
  add column if not exists token_age text,
  add column if not exists enrichment_source text,
  add column if not exists enriched_at timestamptz;

create index if not exists idx_contracts_address_user
  on public.contracts(user_id, address);

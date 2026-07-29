-- Token high-water market cap (service-role writes; shared across tenants).
--
-- Input to caller quality scoring. A token's peak is a global fact, so this is
-- keyed by (address, chain) with no user_id — same shape as token_catalog. RLS
-- is enabled with no policies: only the service role reads/writes it, and the
-- backend fans the derived scores out per user.

create table public.token_peaks (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  chain text not null,
  evm_chain text,
  peak_mc numeric not null default 0,
  peak_at timestamptz not null default now(),
  last_mc numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (address, chain)
);

create index idx_token_peaks_lookup
  on public.token_peaks (lower(address), chain);

create index idx_token_peaks_updated_at
  on public.token_peaks (updated_at desc);

alter table public.token_peaks enable row level security;

create trigger token_peaks_updated_at
  before update on public.token_peaks
  for each row execute function public.update_updated_at();

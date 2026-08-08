-- pump.fun user session bearer, AES-256-GCM encrypted at rest.
--
-- This deliberately mirrors the discord_tokens scheme (app-level AES-256-GCM in
-- auth/encryption.ts, key in TOKEN_ENCRYPTION_KEY) rather than the sniper's Vault
-- scheme. The bearer is a read-only credential — it authorizes leaderboard reads
-- as the user, it does not spend — so it does not warrant the heavier Vault
-- machinery the money-moving venue token does. The columns are byte-for-byte the
-- same as discord_tokens (encrypted_token / token_iv / token_tag / token_mask),
-- which is what lets PumpSessionRepo be a near-verbatim sibling of TokensRepo.
--
-- Cardinality is the one difference from discord_tokens: a user has MANY Discord
-- tokens but exactly ONE pump session, so `unique (user_id)` and the repo upserts
-- a single row rather than maintaining a positional list.

create table if not exists public.pump_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_token text not null,   -- base64 ciphertext
  token_iv text not null,          -- base64 16-byte IV
  token_tag text not null,         -- base64 16-byte GCM auth tag
  token_mask text not null,        -- masked value for operator inspection only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);
create index if not exists idx_pump_sessions_user on public.pump_sessions(user_id);

comment on table public.pump_sessions is
  'Per-user pump.fun session bearer (a ~30-day JWT), AES-256-GCM encrypted at '
  'rest with the same scheme as discord_tokens. Exactly one row per user. The '
  'plaintext is never selected back through PostgREST — only the backend service '
  'role decrypts it, at the moment of an upstream leaderboard call.';

alter table public.pump_sessions enable row level security;

-- CREATE POLICY has no IF NOT EXISTS in Postgres 17, and these migrations are
-- applied by hand against two separate projects (dev and prod), so drop-then-
-- create keeps re-application idempotent.
drop policy if exists "Users manage own pump session" on public.pump_sessions;
create policy "Users manage own pump session" on public.pump_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Keep updated_at fresh on rotation. update_updated_at() is defined in the core
-- schema migration.
drop trigger if exists pump_sessions_updated_at on public.pump_sessions;
create trigger pump_sessions_updated_at
  before update on public.pump_sessions
  for each row execute function public.update_updated_at();

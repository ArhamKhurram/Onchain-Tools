-- Sniper venue credentials, stored in Supabase Vault rather than
-- app-level AES-GCM (see docs/architecture/sniper-security.md).
--
-- The difference from the existing Discord-token pattern (auth/encryption.ts,
-- a symmetric key in TOKEN_ENCRYPTION_KEY) is where the key lives and who ever
-- holds it: Vault's root key is managed by Supabase infrastructure and never
-- enters this repo, this backend's env, or this backend's process memory.
-- Decryption happens inside Postgres via vault.decrypted_secrets, so a leaked
-- Railway env can no longer decrypt a stored venue token by itself.
--
-- This does NOT fix T11 (a leaked SUPABASE_SERVICE_KEY already bypasses RLS
-- and can call sniper_get_venue_secret below) — that stays the single biggest
-- exposure and is tracked separately. What it removes is the app-level key as
-- a *second*, independent way to reach the same secret.
--
-- Vault ships enabled on hosted Supabase projects; the guarded CREATE EXTENSION
-- below is only for self-hosted/local Supabase where it may not be.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    create extension supabase_vault cascade;
  end if;
end
$$;

-- Only metadata lives in a PostgREST-visible table. The secret itself never
-- has a row anywhere queryable by REST — it exists only in vault.secrets,
-- referenced here by id.
create table if not exists public.sniper_venue_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  venue text not null check (venue in ('slotshark', 'gmgn_openapi')),
  secret_id uuid not null,
  wallet_address text,
  region text,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, venue)
);

comment on table public.sniper_venue_credentials is
  'Per-user, per-venue sniper API token metadata. The token itself lives in '
  'vault.secrets (referenced by secret_id) and is never selectable through '
  'this table or through PostgREST directly.';

alter table public.sniper_venue_credentials enable row level security;

-- Users may read their own connection metadata (which venues they've linked,
-- a masked wallet address, when) for a "connected accounts" UI. This policy
-- cannot leak the secret — the secret column does not exist on this table.
-- CREATE POLICY has no IF NOT EXISTS in Postgres 17, and these migrations are
-- applied by hand against two separate projects (dev and prod) — exactly the
-- situation where a file gets re-applied. Drop-then-create keeps it idempotent.
drop policy if exists "sniper_venue_credentials_select_own"
  on public.sniper_venue_credentials;

create policy "sniper_venue_credentials_select_own"
  on public.sniper_venue_credentials for select
  using (auth.uid() = user_id);

-- Deliberately no insert/update/delete policies. Every mutation goes through
-- one of the SECURITY DEFINER functions below, because a mutation here has to
-- also touch vault.secrets — a bare RLS-gated INSERT could create an orphaned
-- metadata row with no backing secret, or vice versa.

-- ---------------------------------------------------------------------------
-- Write: called by the USER'S OWN authenticated client, directly from the
-- browser/desktop app to Supabase. The plaintext venue token crosses the wire
-- to Supabase, never to the OCT backend (see docs/architecture/sniper-security.md
-- — this mirrors the existing direct RLS-scoped write pattern frontend/src
-- already uses for useTrackedWallets/useHoldingWallets).
--
-- p_user_id exists only so the backend can call this on a user's behalf during
-- local-mode testing or admin operations; when called as the service role it
-- is required, when called as an authenticated user it is ignored in favour
-- of auth.uid() so a user can never write another user's credential.
-- ---------------------------------------------------------------------------
create or replace function public.sniper_store_venue_credential(
  p_venue text,
  p_secret text,
  p_wallet_address text default null,
  p_region text default null,
  p_label text default null,
  p_user_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid;
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  if auth.role() = 'service_role' then
    if p_user_id is null then
      raise exception 'p_user_id is required when sniper_store_venue_credential is called as service_role';
    end if;
    v_user_id := p_user_id;
  else
    v_user_id := auth.uid();
    if v_user_id is null then
      raise exception 'Not authenticated';
    end if;
  end if;

  select secret_id into v_existing_secret_id
  from public.sniper_venue_credentials
  where user_id = v_user_id and venue = p_venue;

  -- Re-point at the secret by NAME if the metadata row is missing but the vault
  -- row survives. vault.secrets has a unique index on name, so blindly calling
  -- create_secret in that state raises a duplicate-key error and the user can
  -- never reconnect that venue. Also guards the mirror case (metadata row
  -- present, vault row gone), where update_secret would silently no-op and a
  -- "successful" rotation would store nothing.
  if v_existing_secret_id is not null
     and not exists (select 1 from vault.secrets where id = v_existing_secret_id) then
    v_existing_secret_id := null;
  end if;

  if v_existing_secret_id is null then
    select id into v_existing_secret_id
    from vault.secrets
    where name = v_user_id::text || ':' || p_venue;
  end if;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret, v_user_id::text || ':' || p_venue);
  end if;

  insert into public.sniper_venue_credentials
    (user_id, venue, secret_id, wallet_address, region, label, updated_at)
  values
    (v_user_id, p_venue, v_secret_id, p_wallet_address, p_region, p_label, now())
  on conflict (user_id, venue) do update
    set secret_id      = excluded.secret_id,
        wallet_address = excluded.wallet_address,
        region         = excluded.region,
        label          = excluded.label,
        updated_at     = now();

  return v_secret_id;
end;
$$;

comment on function public.sniper_store_venue_credential(text, text, text, text, text, uuid) is
  'Connect/rotate a per-user sniper venue token. Callable by an authenticated '
  'user for their own account, or by the service role with an explicit user id.';

revoke all on function public.sniper_store_venue_credential(text, text, text, text, text, uuid) from public;
revoke all on function public.sniper_store_venue_credential(text, text, text, text, text, uuid) from anon;
grant execute on function public.sniper_store_venue_credential(text, text, text, text, text, uuid) to authenticated;
grant execute on function public.sniper_store_venue_credential(text, text, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Read: the ONLY way to get a plaintext token back out. Service role only —
-- this is what the sniper's executeFire calls, and only at the moment it is
-- about to send, never cached beyond that call. No authenticated-role grant
-- exists: a user's own client can write their token but can never read it
-- back, which is deliberate (nothing legitimate needs to read your own token
-- back through the API; a UI shows the metadata row instead).
-- ---------------------------------------------------------------------------
create or replace function public.sniper_get_venue_secret(
  p_user_id uuid,
  p_venue text
) returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  -- NULL-SAFE on purpose. `auth.role()` reads request.jwt.claim.role with
  -- missing_ok, so it returns NULL for any caller without a PostgREST JWT
  -- context (a direct Postgres connection, the SQL editor, pg_cron, a
  -- non-JWT secret key). `NULL <> 'service_role'` is NULL, and plpgsql treats
  -- a NULL IF as FALSE — so the naive form SKIPS the raise and hands back a
  -- plaintext money-spending token. `is distinct from` over a coalesce fails
  -- CLOSED instead.
  --
  -- Note the REVOKE/GRANT set below is the real enforcement; this check is
  -- defence in depth, which is exactly why it must not be the fail-open kind.
  if coalesce(auth.jwt() ->> 'role', auth.role(), '') is distinct from 'service_role' then
    raise exception 'sniper_get_venue_secret is restricted to the service role';
  end if;

  select ds.decrypted_secret into v_secret
  from public.sniper_venue_credentials c
  join vault.decrypted_secrets ds on ds.id = c.secret_id
  where c.user_id = p_user_id and c.venue = p_venue;

  return v_secret;
end;
$$;

comment on function public.sniper_get_venue_secret(uuid, text) is
  'Decrypt a user''s sniper venue token. Service role only — called at fire '
  'time, never cached. Never grant this to authenticated/anon.';

revoke all on function public.sniper_get_venue_secret(uuid, text) from public;
revoke all on function public.sniper_get_venue_secret(uuid, text) from anon;
revoke all on function public.sniper_get_venue_secret(uuid, text) from authenticated;
grant execute on function public.sniper_get_venue_secret(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Delete: disconnect a venue account. Removes both the metadata row and the
-- underlying vault secret so nothing orphaned is left decryptable.
-- ---------------------------------------------------------------------------
create or replace function public.sniper_delete_venue_credential(
  p_venue text
) returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select secret_id into v_secret_id
  from public.sniper_venue_credentials
  where user_id = v_user_id and venue = p_venue;

  if v_secret_id is null then
    return false;
  end if;

  delete from public.sniper_venue_credentials
  where user_id = v_user_id and venue = p_venue;

  delete from vault.secrets where id = v_secret_id;

  return true;
end;
$$;

comment on function public.sniper_delete_venue_credential(text) is
  'Disconnect a sniper venue account: removes the metadata row and the vault secret.';

-- ---------------------------------------------------------------------------
-- Orphan cleanup. The metadata row can disappear by routes that do NOT go
-- through the function above — most importantly the
-- `references auth.users(id) on delete cascade` above, which fires on account
-- deletion. Without this trigger that leaves the user's venue API token live
-- and decryptable in vault.secrets forever.
--
-- It also prevents a permanent lockout: vault.secrets has a unique index on
-- `name`, so an orphaned secret named '<user>:<venue>' makes every future
-- vault.create_secret for that pair fail, and the user could never reconnect.
-- ---------------------------------------------------------------------------
create or replace function public.sniper_venue_credentials_purge_secret()
returns trigger
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;

drop trigger if exists sniper_venue_credentials_purge_secret_trg
  on public.sniper_venue_credentials;

create trigger sniper_venue_credentials_purge_secret_trg
  after delete on public.sniper_venue_credentials
  for each row execute function public.sniper_venue_credentials_purge_secret();

revoke all on function public.sniper_delete_venue_credential(text) from public;
revoke all on function public.sniper_delete_venue_credential(text) from anon;
grant execute on function public.sniper_delete_venue_credential(text) to authenticated;

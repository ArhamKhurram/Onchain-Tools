-- Outpost Discord bot: resolve an OCT account from a Discord user id.
--
-- Users who signed in with Discord already have their Discord identity stored by
-- Supabase in auth.identities, so the bot needs no linking flow (see
-- DISCORD_BOT_PLAN.md §2c). PostgREST does not expose the auth schema, so this
-- SECURITY DEFINER wrapper gives the backend (service role only) a narrow
-- read: one Discord id in, one user id out. It exposes nothing else about
-- auth.identities.
--
-- The Discord user id lands in identity_data under a provider-version-dependent
-- key, so check the known aliases. identity_data is used rather than the
-- provider_id column so this works across GoTrue versions.

create or replace function public.oct_user_id_by_discord_id(p_discord_id text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select i.user_id
  from auth.identities i
  where i.provider = 'discord'
    and coalesce(
      i.identity_data ->> 'provider_id',
      i.identity_data ->> 'sub',
      i.identity_data ->> 'id'
    ) = p_discord_id
  order by i.last_sign_in_at desc nulls last
  limit 1;
$$;

comment on function public.oct_user_id_by_discord_id(text) is
  'Outpost bot: maps a Discord user id to the owning OCT auth.users id. Service role only.';

-- Service role only — never callable by browser clients.
revoke all on function public.oct_user_id_by_discord_id(text) from public;
revoke all on function public.oct_user_id_by_discord_id(text) from anon;
revoke all on function public.oct_user_id_by_discord_id(text) from authenticated;
grant execute on function public.oct_user_id_by_discord_id(text) to service_role;

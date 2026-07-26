-- LP automation policy store (LP_AUTOMATION_PLAN.md §5, §9 points 1-2).
--
-- The policy is edited in the OCT dashboard and only ever READ by the signer
-- process (§9.1). Two properties from §5 drive the shape of this table:
--
--   1. VERSIONED, APPEND-ONLY. "Changing the default does not retroactively
--      touch open positions." An open position pins a version number, so a
--      version's contents must never change after it is written. Editing the
--      policy INSERTs a new row with version = max(version) + 1; nothing
--      rewrites an existing one. The only column that is ever updated is
--      `is_active`, and a trigger below enforces that.
--
--   2. THE ALLOWLIST IS PART OF THE POLICY, not a separate table.
--      `allowed_pools` is `text[]` on the policy row because it is a *value of
--      the version*, not an entity in its own right. Normalising it into a
--      child table would let a version's allowlist drift after that version was
--      pinned by an open position — exactly the retroactive change §5 forbids —
--      and would need its own immutability machinery to prevent it. There is
--      also no per-pool metadata to hang off such a table (pool details are
--      fetched live from Krystal) and the cardinality is tens of entries, so
--      normalising buys nothing. Pools land here only when a human ticks them
--      in the dashboard; Krystal never auto-admits one (§9.2).
--
-- Column names are snake_case mirrors of `AutomationPolicy` in
-- `lp-automation/src/types.ts`. The nested objects (poolSelectionCriteria,
-- compoundTrigger, rebalanceTrigger, switchingBuffer) are flattened into
-- prefixed scalar columns rather than stored as jsonb so that the CHECK
-- constraints below can restate the validator's bounds at the database level —
-- a jsonb blob would make the row's integrity depend entirely on application
-- code. `backend/src/api/routes/lp.ts` is the authoritative validator; these
-- constraints are the backstop, and they are deliberately the same numbers.

-- Every entry of `allowed_pools` must be a lowercase 0x-prefixed 20-byte
-- address. A CHECK cannot contain a subquery and may only call IMMUTABLE
-- functions (`array_to_string` is merely STABLE, so the obvious one-liner is
-- rejected outright), hence this helper. `~` on text is immutable, so the
-- assertion is honest.
create or replace function public.lp_is_pool_address_array(p_pools text[])
returns boolean
language sql
immutable
as $$
  select p_pools is not null
     and not exists (
       select 1 from unnest(p_pools) as pool(addr)
       where addr !~ '^0x[0-9a-f]{40}$'
     );
$$;

create table public.lp_automation_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Positive integers assigned in order, per user. Never reused.
  version integer not null check (version > 0),

  -- Exactly one active version per user (partial unique index below). Inactive
  -- rows are retained forever so a pinned version always resolves.
  is_active boolean not null default true,

  -- Phase 1 is single-chain by decision (plan §1/§10). The module's destination
  -- allowlist is chain-specific, so an unknown chain could only fail on-chain.
  chain text not null check (chain in ('robinhood')),

  max_position_size_usd numeric not null check (max_position_size_usd > 0),

  -- Mirrored on-chain in the Safe module; this value alone enforces nothing
  -- (plan §4). It exists so the off-chain side refuses first, cheaply.
  daily_spend_cap_usd numeric not null check (daily_spend_cap_usd > 0),

  -- Lowercase 0x-prefixed 20-byte addresses (normalized by the backend before
  -- insert). Empty is the correct default and an entirely valid state: an empty
  -- allowlist means the automation can do nothing at all, which is the right
  -- failure mode for a pool-discovery bug.
  allowed_pools text[] not null default '{}'
    check (public.lp_is_pool_address_array(allowed_pools)),

  -- poolSelectionCriteria — SURFACES candidates for manual selection (§9.2).
  -- Nothing here admits a pool; only `allowed_pools` does.
  min_tvl_usd numeric not null check (min_tvl_usd >= 0),
  min_24h_volume_usd numeric not null check (min_24h_volume_usd >= 0),
  max_il_risk_score numeric not null check (max_il_risk_score between 0 and 100),

  -- compoundTrigger. Hard floor of 1.0 on the ratio: compounding for less than
  -- the gas it costs is a net loss in every market condition.
  min_fees_vs_gas_ratio numeric not null check (min_fees_vs_gas_ratio >= 1),
  max_interval_hours numeric not null check (max_interval_hours > 0),

  -- rebalanceTrigger.
  range_exit_percent numeric not null check (range_exit_percent > 0),

  -- switchingBuffer. Zero delta is allowed (the sustained duration still gates
  -- the move); negative is not — it would authorize switching into a worse pool.
  -- Zero duration is not allowed: it removes the buffer that exists to stop a
  -- momentary one-tick crossover from triggering a move.
  min_efficiency_delta_percent numeric not null check (min_efficiency_delta_percent >= 0),
  sustained_duration_minutes numeric not null check (sustained_duration_minutes > 0),

  created_at timestamptz not null default now(),

  unique (user_id, version),

  -- Cross-field: a daily cap below one position's size is self-contradictory —
  -- every entry would be refused on-chain, after paying gas to find out.
  constraint lp_automation_policies_cap_covers_position
    check (daily_spend_cap_usd >= max_position_size_usd)
);

-- At most one active version per user. A partial unique index rather than a
-- trigger so concurrent writers cannot both believe they activated.
create unique index idx_lp_automation_policies_active
  on public.lp_automation_policies (user_id)
  where is_active;

-- Version lookups: "newest for this user" and "the version this position pins".
create index idx_lp_automation_policies_user_version
  on public.lp_automation_policies (user_id, version desc);

-- ---------------------------------------------------------------------------
-- Immutability: a written version's CONTENTS never change.
-- ---------------------------------------------------------------------------
-- Without this, the append-only property lives only in application code, and
-- the first `update ... set max_position_size_usd = ...` written by a future
-- hotfix would silently re-price every open position pinned to that version.
-- `is_active` is the sole mutable column.

create or replace function public.lp_automation_policies_immutable()
returns trigger
language plpgsql
as $$
begin
  if (new.id, new.user_id, new.version, new.chain, new.max_position_size_usd,
      new.daily_spend_cap_usd, new.allowed_pools, new.min_tvl_usd,
      new.min_24h_volume_usd, new.max_il_risk_score, new.min_fees_vs_gas_ratio,
      new.max_interval_hours, new.range_exit_percent,
      new.min_efficiency_delta_percent, new.sustained_duration_minutes,
      new.created_at)
     is distinct from
     (old.id, old.user_id, old.version, old.chain, old.max_position_size_usd,
      old.daily_spend_cap_usd, old.allowed_pools, old.min_tvl_usd,
      old.min_24h_volume_usd, old.max_il_risk_score, old.min_fees_vs_gas_ratio,
      old.max_interval_hours, old.range_exit_percent,
      old.min_efficiency_delta_percent, old.sustained_duration_minutes,
      old.created_at)
  then
    raise exception
      'lp_automation_policies is append-only: edit the policy by inserting a new version (only is_active may be updated)';
  end if;
  return new;
end;
$$;

create trigger lp_automation_policies_immutable
  before update on public.lp_automation_policies
  for each row execute function public.lp_automation_policies_immutable();

-- ---------------------------------------------------------------------------
-- RLS — scoped to auth.uid(), same shape as the other user-owned tables.
-- ---------------------------------------------------------------------------
-- Read + insert only for `authenticated`. There is deliberately NO update or
-- delete policy: flipping `is_active` and retaining history are backend
-- operations performed with the service role (which bypasses RLS), and the
-- lp-automation signer reads with the service role too. A browser client that
-- talks to Supabase directly can therefore see its own policies and append a
-- new version, but can never retire, rewrite, or delete one.

alter table public.lp_automation_policies enable row level security;

create policy "Users read own lp policies"
  on public.lp_automation_policies for select
  using (auth.uid() = user_id);

create policy "Users append own lp policies"
  on public.lp_automation_policies for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Atomic version append.
-- ---------------------------------------------------------------------------
-- Retiring the current version and inserting the new one must be ONE
-- transaction. Done as two client round-trips, a failure between them leaves
-- the user with no active version at all — which silently disables the
-- automation until they happen to save again. That failure is safe (the signer
-- does nothing without an active policy) but it is invisible, and invisible is
-- the wrong property for the row that holds the spend caps.
--
-- `for update` serialises concurrent saves for an existing user, so two browser
-- tabs cannot both read the same max(version). For a user's very first save
-- there are no rows to lock, so two truly simultaneous first-saves can both
-- compute version 1 — the `unique (user_id, version)` constraint rejects the
-- loser, which is the correct outcome rather than a silently dropped write.
create or replace function public.lp_append_policy(p_user_id uuid, p_policy jsonb)
returns public.lp_automation_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next    integer;
  v_result  public.lp_automation_policies;
begin
  perform 1 from public.lp_automation_policies
   where user_id = p_user_id
     for update;

  select coalesce(max(version), 0) + 1
    into v_next
    from public.lp_automation_policies
   where user_id = p_user_id;

  update public.lp_automation_policies
     set is_active = false
   where user_id = p_user_id
     and is_active;

  insert into public.lp_automation_policies (
    user_id, version, is_active, chain,
    max_position_size_usd, daily_spend_cap_usd, allowed_pools,
    min_tvl_usd, min_24h_volume_usd, max_il_risk_score,
    min_fees_vs_gas_ratio, max_interval_hours,
    range_exit_percent,
    min_efficiency_delta_percent, sustained_duration_minutes
  ) values (
    p_user_id,
    v_next,
    true,
    p_policy ->> 'chain',
    (p_policy ->> 'max_position_size_usd')::numeric,
    (p_policy ->> 'daily_spend_cap_usd')::numeric,
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(p_policy -> 'allowed_pools') as t(value)),
      '{}'::text[]
    ),
    (p_policy ->> 'min_tvl_usd')::numeric,
    (p_policy ->> 'min_24h_volume_usd')::numeric,
    (p_policy ->> 'max_il_risk_score')::numeric,
    (p_policy ->> 'min_fees_vs_gas_ratio')::numeric,
    (p_policy ->> 'max_interval_hours')::numeric,
    (p_policy ->> 'range_exit_percent')::numeric,
    (p_policy ->> 'min_efficiency_delta_percent')::numeric,
    (p_policy ->> 'sustained_duration_minutes')::numeric
  )
  returning * into v_result;

  return v_result;
end;
$$;

-- Backend/service-role only. A browser client still appends through the RLS
-- insert policy above (bounded by the CHECK constraints); it has no business
-- retiring versions, which is what this function does.
revoke all on function public.lp_append_policy(uuid, jsonb) from public;
revoke all on function public.lp_append_policy(uuid, jsonb) from anon;
revoke all on function public.lp_append_policy(uuid, jsonb) from authenticated;
grant execute on function public.lp_append_policy(uuid, jsonb) to service_role;

comment on table public.lp_automation_policies is
  'Versioned, append-only LP automation policy (LP_AUTOMATION_PLAN.md §5). One active version per user; open positions pin a version so rows are never rewritten. The signer process only reads.';

comment on column public.lp_automation_policies.allowed_pools is
  'Pool addresses a human explicitly ticked in the dashboard (plan §9.2). Empty means the automation can do nothing. Krystal candidate criteria never write here.';

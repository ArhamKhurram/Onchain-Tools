-- Add `rangeStrategy` to the LP automation policy (mirrors RebalanceTrigger in
-- lp-automation/src/types.ts).
--
-- The field controls WHERE a rebalance places the new range — narrow is the
-- tightest band (most fees, most rebalances), wide is a broader band, full is a
-- v2-style whole-range position that never needs rebalancing. Default is
-- 'narrow', the tightest choice and the one existing rows are assumed to have.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY TABLE — three coordinated changes, or the field goes nowhere.
-- ---------------------------------------------------------------------------
-- `lp_automation_policies` is versioned and append-only (see
-- 20260726160000_lp_automation_policies.sql). Adding a readable, writable column
-- means touching all three moving parts, not just the column:
--
--   1. The column itself, with a default so the rows that predate the field get
--      a sensible, safe value ('narrow') rather than NULL.
--   2. The immutability trigger's column list — otherwise the trigger, which
--      compares an EXPLICIT tuple of columns, would ignore range_strategy and a
--      future UPDATE could silently rewrite it on a pinned version.
--   3. The `lp_append_policy` insert — otherwise every newly-saved version would
--      fall back to the column default and the operator's choice would never be
--      persisted.
--
-- Both functions are recreated below by copying their CURRENT bodies forward
-- verbatim (from the 160000 migration) with the single field added — the bodies
-- are not rewritten from memory.

-- --- 1. Column ------------------------------------------------------------
-- `not null default 'narrow'` backfills existing rows in place; safe to run on a
-- dev DB that already holds policies. The CHECK restates the validator's enum at
-- the database level, the same backstop the other policy columns have.
alter table public.lp_automation_policies
  add column range_strategy text not null default 'narrow'
    check (range_strategy in ('narrow', 'wide', 'full'));

comment on column public.lp_automation_policies.range_strategy is
  'Where a rebalance places the new range: narrow (tightest, most fees/rebalances), wide, or full (whole-range, never rebalances). Mirrors RebalanceTrigger.rangeStrategy in lp-automation/src/types.ts. Default narrow.';

-- --- 2. Immutability trigger --------------------------------------------
-- Copied verbatim from 20260726160000_lp_automation_policies.sql, with
-- `range_strategy` added to BOTH tuples so an edit to it on an existing version
-- is rejected like every other content column. `is_active` remains the sole
-- mutable column.
create or replace function public.lp_automation_policies_immutable()
returns trigger
language plpgsql
as $$
begin
  if (new.id, new.user_id, new.version, new.chain, new.max_position_size_usd,
      new.daily_spend_cap_usd, new.allowed_pools, new.min_tvl_usd,
      new.min_24h_volume_usd, new.max_il_risk_score, new.min_fees_vs_gas_ratio,
      new.max_interval_hours, new.range_exit_percent, new.range_strategy,
      new.min_efficiency_delta_percent, new.sustained_duration_minutes,
      new.created_at)
     is distinct from
     (old.id, old.user_id, old.version, old.chain, old.max_position_size_usd,
      old.daily_spend_cap_usd, old.allowed_pools, old.min_tvl_usd,
      old.min_24h_volume_usd, old.max_il_risk_score, old.min_fees_vs_gas_ratio,
      old.max_interval_hours, old.range_exit_percent, old.range_strategy,
      old.min_efficiency_delta_percent, old.sustained_duration_minutes,
      old.created_at)
  then
    raise exception
      'lp_automation_policies is append-only: edit the policy by inserting a new version (only is_active may be updated)';
  end if;
  return new;
end;
$$;

-- --- 3. Atomic version append -------------------------------------------
-- Copied verbatim from 20260726160000_lp_automation_policies.sql, with
-- `range_strategy` added to the column list and the values list. It is read from
-- the jsonb payload with `coalesce(p_policy->>'range_strategy','narrow')` so an
-- older backend that does not send the key still produces the safe default
-- rather than a null-violation.
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
    range_exit_percent, range_strategy,
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
    coalesce(p_policy ->> 'range_strategy', 'narrow'),
    (p_policy ->> 'min_efficiency_delta_percent')::numeric,
    (p_policy ->> 'sustained_duration_minutes')::numeric
  )
  returning * into v_result;

  return v_result;
end;
$$;

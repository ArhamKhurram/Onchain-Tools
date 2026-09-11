-- Caller quality — refuse a dust MC@call as a denominator.
--
-- `caller_quality_aggregate` scored any call with `fdv_at_call > 0`, which is
-- not a test for "is this a market cap". Enrichment can and does record a
-- price-shaped number there (GMGN returns a real supply against an unindexed,
-- near-zero price; multiplying them yields cents), and because `best_multiple`
-- is a MAX, one such row becomes a caller's headline BEST. Prod showed
-- ≥26,959,682× off a $1.19 reading against an $18k peak.
--
-- The floor is passed in rather than hardcoded, for the same reason
-- `p_slop_multiple` already is: MIN_MC_AT_CALL lives in packages/shared and
-- must have exactly one definition. See the comment there for how $1,000 was
-- read off the data — 19 junk rows below it, 4 genuine self-consistent
-- micro-cap calls between $1k and $2k that must keep scoring, and 885 real
-- fresh-launch calls between $2k and $5k that a rounder floor would have eaten.
--
-- A refused call is UNRATED, not dropped: it still counts toward `calls`, so
-- the board keeps saying "N rated of M calls" honestly. That is the same
-- treatment a call with no MC@call at all already gets.
--
-- The default matches the shared constant so a stale caller that omits the
-- argument still gets the fix; the backend always passes it explicitly.
--
-- Adding a parameter creates an OVERLOAD rather than replacing the function,
-- and the old 3-arg form would then make a 3-arg call ambiguous, so the old
-- signature is dropped first. Nothing else calls it.

drop function if exists public.caller_quality_aggregate(uuid, timestamptz, double precision);

create or replace function public.caller_quality_aggregate(
  p_user_id uuid,
  p_since timestamptz default null,
  p_slop_multiple double precision default 1.2,
  p_min_mc_at_call double precision default 1000
)
returns table (
  caller_key text,
  room_id text,
  display_name text,
  calls bigint,
  rated bigint,
  median_multiple double precision,
  best_multiple double precision,
  hits_2x bigint,
  hits_5x bigint,
  slop_count bigint,
  first_call_at timestamptz,
  last_call_at timestamptz
)
language sql
stable
as $$
  with peaks as (
    select lower(p.address) as address, max(p.peak_mc)::double precision as peak_mc
    from public.token_peaks p
    where p.peak_mc > 0
    group by lower(p.address)
  ),
  scored as (
    select
      c.caller_key,
      c.display_name,
      c.called_at,
      c.room_ids,
      case
        when c.fdv_at_call >= coalesce(p_min_mc_at_call, 1000) and pk.peak_mc > 0
          then greatest(pk.peak_mc, c.fdv_at_call) / c.fdv_at_call
      end as multiple
    from public.caller_calls c
    left join peaks pk on pk.address = c.address
    where c.user_id = p_user_id
      and (p_since is null or c.called_at >= p_since)
  ),
  global_rows as (
    select
      s.caller_key,
      null::text as room_id,
      (array_agg(s.display_name order by s.called_at desc)
         filter (where s.display_name is not null))[1] as display_name,
      count(*)::bigint as calls,
      count(s.multiple)::bigint as rated,
      percentile_cont(0.5) within group (order by s.multiple) as median_multiple,
      max(s.multiple) as best_multiple,
      count(*) filter (where s.multiple >= 2)::bigint as hits_2x,
      count(*) filter (where s.multiple >= 5)::bigint as hits_5x,
      count(*) filter (where s.multiple < coalesce(p_slop_multiple, 1.2))::bigint as slop_count,
      min(s.called_at) as first_call_at,
      max(s.called_at) as last_call_at
    from scored s
    group by s.caller_key
  ),
  room_rows as (
    select
      s.caller_key,
      r.room_id::text as room_id,
      (array_agg(s.display_name order by s.called_at desc)
         filter (where s.display_name is not null))[1] as display_name,
      count(*)::bigint as calls,
      count(s.multiple)::bigint as rated,
      percentile_cont(0.5) within group (order by s.multiple) as median_multiple,
      max(s.multiple) as best_multiple,
      count(*) filter (where s.multiple >= 2)::bigint as hits_2x,
      count(*) filter (where s.multiple >= 5)::bigint as hits_5x,
      count(*) filter (where s.multiple < coalesce(p_slop_multiple, 1.2))::bigint as slop_count,
      min(s.called_at) as first_call_at,
      max(s.called_at) as last_call_at
    from scored s
    cross join lateral unnest(s.room_ids) as r(room_id)
    where r.room_id is not null and r.room_id <> ''
    group by s.caller_key, r.room_id
  )
  select * from global_rows
  union all
  select * from room_rows;
$$;

revoke all on function public.caller_quality_aggregate(uuid, timestamptz, double precision, double precision) from public;
grant execute on function public.caller_quality_aggregate(uuid, timestamptz, double precision, double precision) to service_role;

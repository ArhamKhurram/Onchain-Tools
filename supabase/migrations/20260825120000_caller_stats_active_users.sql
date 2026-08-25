-- caller_stats_active_users(timestamptz) — the reconciler's roster filter.
--
-- WHY THIS EXISTS
--
-- The caller-stats reconciler (backend/src/callers/callerStatsRecorder.ts) ran
-- a per-REGISTERED-user sweep on a 5-minute timer: for every row in
-- `user_configs` it issued a `getConfig` and a `getContracts`, whether or not
-- that user had scanned anything since the app was installed. The lookback
-- bounds the ROWS each query returns, not the NUMBER of queries — so the cost
-- of the timer scaled linearly with sign-ups, which is the one number the
-- product exists to grow.
--
-- The sweep's own code already says what work it can possibly do: it reads
-- `contracts` newer than the lookback cutoff and `continue`s immediately when
-- that comes back empty. So the set of users worth visiting is exactly the set
-- with at least one contract row newer than the cutoff. Everyone else was two
-- round-trips spent to prove there was nothing to do.
--
-- This function answers that question for the whole roster in ONE round trip,
-- and returns the roster ALREADY narrowed — it replaces the reconciler's
-- `select user_id from user_configs` rather than adding a query beside it.
--
-- WHY `exists` OVER A PER-USER LATERAL, NOT `select distinct user_id`
--
-- A `select distinct c.user_id from contracts c where c.timestamp > p_since`
-- has no user_id to anchor on, so it degrades to a scan of every contract row
-- in the window and would want a new index on `timestamp` alone. Driving from
-- `user_configs` instead turns it into one index probe per user against the
-- EXISTING `idx_contracts_timestamp (user_id, timestamp desc)`, each of which
-- stops at the first matching row. No new index, no table scan.
--
-- Service-role only, like the rest of the caller-quality RPCs: the backend
-- reconciler is the only caller and no browser touches it.

create or replace function public.caller_stats_active_users(p_since timestamptz)
returns table (user_id uuid)
language sql
stable
as $$
  select u.user_id
  from public.user_configs u
  where p_since is null
     or exists (
       select 1
       from public.contracts c
       where c.user_id = u.user_id
         and c."timestamp" > p_since
     );
$$;

comment on function public.caller_stats_active_users(timestamptz) is
  'Registered users with at least one contract row newer than p_since — the reconciler roster, already narrowed. A null cutoff returns the whole roster.';

revoke all on function public.caller_stats_active_users(timestamptz) from public;
grant execute on function public.caller_stats_active_users(timestamptz) to service_role;

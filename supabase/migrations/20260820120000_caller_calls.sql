-- Persistent caller quality — one durable row per (user, caller, token).
--
-- WHY THIS EXISTS
--
-- Caller scores were derived on read: GET /api/callers/scores read the last N
-- days of `contracts`, joined token peaks, and folded the whole thing in JS on
-- every request. The inputs looked persistent, so the derivation looked free.
-- It wasn't: `contracts` is a rolling log, so the board claimed a 30-day window
-- while actually scoring however much log happened to survive — about a day on
-- a real feed. Callers who posted before that simply vanished, and most of the
-- rest fell back under MIN_RATED_CALLS and rendered as `unrated` with nothing
-- on screen to say why.
--
-- The durable unit is the CALL, not the log row. `caller_calls` keeps one row
-- per (user, caller, token) forever: once someone scans, they are ranked, and
-- the rank updates on every later scan. The contract log can roll freely
-- underneath it.
--
-- WHAT IS *NOT* STORED HERE, DELIBERATELY
--
-- No multiple, no peak, no band. A call's multiple is peak ÷ MC@call and the
-- peak moves — every time the sampler runs, every time a token is re-scanned,
-- every on-demand refresh. A stored multiple would be a cache of a moving
-- number across an unbounded set of rows, and every peak update would owe a
-- fan-out write to every caller who ever touched that token. So the aggregate
-- RPC below JOINS `token_peaks` instead. A peak change is then reflected on the
-- next read with no propagation at all, which is also what bounds the token
-- side of the system: peaks are refreshed for tokens that cross the feed again
-- or that the operator refreshes by hand, never for the whole history forever.
--
-- Bands are not stored either — `bandFromRates` in packages/shared decides
-- them, and it must keep being the only place that does. The RPC returns raw
-- COUNTS (rated, hits ≥2x, hits ≥5x, sub-slop) and the shared code turns those
-- into rates and a band, exactly as the in-memory path does.
--
-- Service-role only, like `token_peaks` and the pump_* tables: the backend owns
-- both the write path (ingest + reconciler) and the read path (the scores
-- route), and no browser touches these rows directly. RLS is on with no client
-- policies, so PostgREST denies by default.

-- ---------------------------------------------------------------------------
-- caller_calls
-- ---------------------------------------------------------------------------
create table if not exists public.caller_calls (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- '<platform>:<authorId>', matching callerKey() in packages/shared.
  caller_key text not null,
  -- Lowercased, so it joins token_peaks (which stores lowercase) directly.
  address text not null,
  chain text,
  evm_chain text,
  display_name text,
  -- The caller's OWN market cap at the moment they posted. Point-in-time: it is
  -- only ever written from the earliest row for this pair, never borrowed from
  -- a later repost. Null while enrichment hasn't priced the call yet (or ever) —
  -- such a call counts toward `calls` but not toward `rated`.
  fdv_at_call double precision,
  called_at timestamptz not null,
  -- Union of every room this caller's posts of this token landed in. Drives the
  -- per-room boards without a second table.
  room_ids text[] not null default '{}',
  first_recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, caller_key, address)
);

-- The aggregate RPC's driving scan: everything for one user, optionally since a
-- cutoff, joined to peaks by address.
create index if not exists idx_caller_calls_user_called
  on public.caller_calls (user_id, called_at desc);
create index if not exists idx_caller_calls_address
  on public.caller_calls (address);

-- Dropped first so the whole migration stays re-runnable: everything else here
-- is `if not exists` / `or replace`, and `create trigger` has no such form.
drop trigger if exists caller_calls_updated_at on public.caller_calls;
create trigger caller_calls_updated_at
  before update on public.caller_calls
  for each row execute function public.update_updated_at();

alter table public.caller_calls enable row level security;

-- ---------------------------------------------------------------------------
-- caller_calls_upsert(uuid, jsonb) — the write path.
--
-- Takes a JSON array of pre-folded rows (the caller has already collapsed
-- duplicates to one entry per (caller_key, address), so ON CONFLICT never
-- touches a row twice in one statement) of the form
--   { caller_key, address, chain, evm_chain, display_name,
--     fdv_at_call, called_at, room_ids }
--
-- The conflict rule is the whole point, so spelling it out:
--
--  * An EARLIER call replaces the stored one wholesale — timestamp and MC@call
--    move together, because MC@call belongs to that instant.
--  * A call at the SAME instant may fill in a null MC@call. This is the
--    enrichment path, not a different call: rows are logged before DexScreener
--    or Rick has priced them, and the reconciler re-reads the very same row
--    minutes later once it has been patched.
--  * A LATER call changes neither. Ten reposts are one call (otherwise spam
--    inflates the sample), and a later repost's market cap is a different
--    moment's reading.
--  * Rooms union and display_name refreshes, always. Both describe the caller
--    rather than the instant.
-- ---------------------------------------------------------------------------
create or replace function public.caller_calls_upsert(p_user_id uuid, p_rows jsonb)
returns integer
language sql
as $$
  with parsed as (
    select
      nullif(r->>'caller_key', '')                   as caller_key,
      lower(nullif(r->>'address', ''))               as address,
      nullif(r->>'chain', '')                        as chain,
      nullif(r->>'evm_chain', '')                    as evm_chain,
      nullif(r->>'display_name', '')                 as display_name,
      nullif(r->>'fdv_at_call', '')::double precision as fdv_at_call,
      nullif(r->>'called_at', '')::timestamptz        as called_at,
      coalesce(
        (select array_agg(distinct x) from jsonb_array_elements_text(
           case when jsonb_typeof(r->'room_ids') = 'array' then r->'room_ids' else '[]'::jsonb end
         ) as x),
        '{}'::text[]
      ) as room_ids
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
  ),
  incoming as (
    -- Belt and braces: the caller already folds duplicates via
    -- `foldCallerCalls`, but one ON CONFLICT statement that touched the same
    -- row twice would abort the whole batch. Keeping the EARLIEST is the same
    -- rule the conflict clause below applies, so deduping here cannot change
    -- the outcome — only prevent the error.
    select distinct on (p.caller_key, p.address) p.*
    from parsed p
    where p.caller_key is not null
      and p.address is not null
      and p.called_at is not null
    order by p.caller_key, p.address, p.called_at asc
  ),
  written as (
    insert into public.caller_calls as t (
      user_id, caller_key, address, chain, evm_chain, display_name,
      fdv_at_call, called_at, room_ids, first_recorded_at, updated_at
    )
    select
      p_user_id, i.caller_key, i.address, i.chain, i.evm_chain, i.display_name,
      i.fdv_at_call, i.called_at, i.room_ids, now(), now()
    from incoming i
    on conflict (user_id, caller_key, address) do update set
      fdv_at_call = case
        when excluded.called_at < t.called_at then excluded.fdv_at_call
        when excluded.called_at = t.called_at then coalesce(t.fdv_at_call, excluded.fdv_at_call)
        else t.fdv_at_call
      end,
      called_at   = least(t.called_at, excluded.called_at),
      chain       = coalesce(t.chain, excluded.chain),
      evm_chain   = coalesce(t.evm_chain, excluded.evm_chain),
      display_name = coalesce(excluded.display_name, t.display_name),
      room_ids = coalesce(
        (select array_agg(distinct e) from unnest(t.room_ids || excluded.room_ids) as e),
        '{}'::text[]
      ),
      updated_at  = now()
    returning 1
  )
  select coalesce(count(*), 0)::integer from written;
$$;

comment on function public.caller_calls_upsert(uuid, jsonb) is
  'Fold pre-deduped caller/token call records into caller_calls. Earliest call wins; same-instant fills a null MC@call; later calls never overwrite.';

-- ---------------------------------------------------------------------------
-- caller_quality_aggregate(uuid, timestamptz) — the read path.
--
-- Returns one row per caller (room_id null) plus one row per caller per room,
-- in a single result. Grouping and the percentile happen in Postgres so only
-- the ranked slice crosses the wire — the same reason pump_top_callers_window
-- exists rather than shipping every observation to Node.
--
-- `p_since` null means ALL TIME, which is the point of the table: a caller who
-- scanned once is ranked from then on. Passing a cutoff still works, for a
-- caller who explicitly asks for a window.
--
-- Peaks join by address only (not (address, chain)): the same mint should not
-- appear under two chains, and if it somehow does, the higher observed peak is
-- the honest one to use.
--
-- `p_slop_multiple` is passed in rather than hardcoded so SLOP_MULTIPLE keeps a
-- single definition in packages/shared. The 2x and 5x thresholds ARE hardcoded,
-- because they are baked into the shape of CallerScore (`hitRate2x`,
-- `hitRate5x`) and cannot move without a payload change anyway.
-- ---------------------------------------------------------------------------
create or replace function public.caller_quality_aggregate(
  p_user_id uuid,
  p_since timestamptz default null,
  p_slop_multiple double precision default 1.2
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
        when c.fdv_at_call > 0 and pk.peak_mc > 0
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

-- ---------------------------------------------------------------------------
-- caller_quality_token_counts(uuid, timestamptz) — the two headline numbers the
-- console prints under the board: how many distinct tokens this user's callers
-- have called, and how many of those we have a peak for.
--
-- A separate tiny RPC rather than an extra column on the aggregate, because
-- these are counts of DISTINCT TOKENS: five callers calling one mint is five
-- calls but one token, so it cannot be summed out of the per-caller rows
-- without over-counting. That over-count is exactly the kind of number that
-- reads as reassuring and is wrong.
-- ---------------------------------------------------------------------------
create or replace function public.caller_quality_token_counts(
  p_user_id uuid,
  p_since timestamptz default null
)
returns table (tokens bigint, priced_tokens bigint)
language sql
stable
as $$
  with mints as (
    select distinct c.address
    from public.caller_calls c
    where c.user_id = p_user_id
      and (p_since is null or c.called_at >= p_since)
  ),
  priced as (
    select distinct lower(p.address) as address
    from public.token_peaks p
    where p.peak_mc > 0
  )
  select
    count(*)::bigint as tokens,
    count(pr.address)::bigint as priced_tokens
  from mints m
  left join priced pr on pr.address = m.address;
$$;

-- ---------------------------------------------------------------------------
-- Grants — backend service role only, both directions.
-- ---------------------------------------------------------------------------
revoke all on function public.caller_quality_token_counts(uuid, timestamptz) from public;
grant execute on function public.caller_quality_token_counts(uuid, timestamptz) to service_role;
revoke all on function public.caller_calls_upsert(uuid, jsonb) from public;
revoke all on function public.caller_quality_aggregate(uuid, timestamptz, double precision) from public;
grant execute on function public.caller_calls_upsert(uuid, jsonb) to service_role;
grant execute on function public.caller_quality_aggregate(uuid, timestamptz, double precision) to service_role;

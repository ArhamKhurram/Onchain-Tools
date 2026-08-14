-- Pump.fun auto-discovered "Top Callers" board (keyless, no pump login).
--
-- Ranks EVERY caller seen in the GLOBAL keyless callout feed
-- (frontend-api-v3.pump.fun/callout/recent) by call volume and multiple quality.
-- The existing callout poller already pages that feed on our own cadence; it now
-- also RECORDS each callout it sees into these tables (in addition to its follow
-- fan-out), so the board is a pure by-product of a poll we already run — no new
-- upstream host, no per-user state, no credential.
--
--   pump_caller_stats         -- running ALL-TIME aggregate, one row per caller
--   pump_callout_observations -- bounded per-callout rows (30d retention) for windows
--
-- Both are service-role-only (written by the backend poller, read by the backend
-- /top-callers route under the service role) — exactly like pump_callout_poll_state.
-- RLS is enabled with NO client policies, so direct PostgREST access is denied by
-- default and only the backend service role (which bypasses RLS) touches them.

-- ---------------------------------------------------------------------------
-- pump_caller_stats: the running aggregate. Incremented per callout via the
-- pump_record_caller_stats() RPC (one round trip per poll). `avg_multiple` is a
-- STORED generated column so the all-time board can ORDER BY it directly (indexed)
-- without a group-by. `sum_multiple` folds a null callout multiple in as 0.
-- ---------------------------------------------------------------------------
create table if not exists public.pump_caller_stats (
  caller_address text primary key,        -- wallet pubkey == callout.userId
  callout_count bigint not null default 0,
  sum_multiple double precision not null default 0,
  max_multiple double precision not null default 0,
  avg_multiple double precision generated always as (
    case when callout_count > 0 then sum_multiple / callout_count else 0 end
  ) stored,
  first_seen_at timestamptz not null default now(),
  last_callout_at timestamptz,
  username text,
  avatar text,
  updated_at timestamptz not null default now()
);
-- One index per orderable board metric so the all-time slice is an index scan.
create index if not exists idx_pump_caller_stats_count on public.pump_caller_stats(callout_count desc);
create index if not exists idx_pump_caller_stats_avg on public.pump_caller_stats(avg_multiple desc);
create index if not exists idx_pump_caller_stats_max on public.pump_caller_stats(max_multiple desc);

-- ---------------------------------------------------------------------------
-- pump_callout_observations: one row per callout, retained for the widest board
-- window (30d) then pruned by the poller. Powers the time-windowed boards
-- (24h / 7d / 30d) that a pure running aggregate cannot express.
-- ---------------------------------------------------------------------------
create table if not exists public.pump_callout_observations (
  callout_id text primary key,            -- feed dedup key; ON CONFLICT ignores replays
  caller_address text not null,
  multiple double precision,
  created_at timestamptz not null default now()
);
create index if not exists idx_pump_obs_created on public.pump_callout_observations(created_at desc);
create index if not exists idx_pump_obs_caller_created on public.pump_callout_observations(caller_address, created_at desc);

-- ---------------------------------------------------------------------------
-- pump_record_caller_stats(jsonb): batch upsert-increment for the aggregate.
-- Takes a JSON array of pre-aggregated rows (one per UNIQUE caller in the poll
-- batch — the caller pre-folds duplicates so ON CONFLICT never touches a row
-- twice in one statement) of the form
--   { caller_address, add_count, add_sum, max_multiple, last_callout_at,
--     username, avatar }
-- and folds each into pump_caller_stats. username/avatar are only overwritten
-- when a non-null value is supplied (COALESCE), so a poll that didn't re-enrich a
-- caller leaves their stored handle intact.
-- ---------------------------------------------------------------------------
create or replace function public.pump_record_caller_stats(p_rows jsonb)
returns void
language sql
as $$
  insert into public.pump_caller_stats as t (
    caller_address, callout_count, sum_multiple, max_multiple,
    first_seen_at, last_callout_at, username, avatar, updated_at
  )
  select
    r->>'caller_address',
    coalesce((r->>'add_count')::bigint, 0),
    coalesce((r->>'add_sum')::double precision, 0),
    coalesce((r->>'max_multiple')::double precision, 0),
    now(),
    nullif(r->>'last_callout_at', '')::timestamptz,
    nullif(r->>'username', ''),
    nullif(r->>'avatar', ''),
    now()
  from jsonb_array_elements(p_rows) as r
  where coalesce(r->>'caller_address', '') <> ''
  on conflict (caller_address) do update set
    callout_count   = t.callout_count + excluded.callout_count,
    sum_multiple    = t.sum_multiple + excluded.sum_multiple,
    max_multiple    = greatest(t.max_multiple, excluded.max_multiple),
    last_callout_at = greatest(t.last_callout_at, excluded.last_callout_at),
    username        = coalesce(excluded.username, t.username),
    avatar          = coalesce(excluded.avatar, t.avatar),
    updated_at      = now();
$$;

-- ---------------------------------------------------------------------------
-- pump_top_callers_window(...): the time-windowed board. Groups observations
-- since a cutoff, joins identity from the running aggregate, orders by the
-- requested metric ('count' | 'avg' | 'max'), filters one-hit-wonders out of the
-- avg/max boards via p_min_calls, and caps to p_limit — all in Postgres, so only
-- the ranked slice crosses the wire.
-- ---------------------------------------------------------------------------
create or replace function public.pump_top_callers_window(
  p_since timestamptz,
  p_metric text,
  p_min_calls int,
  p_limit int
)
returns table (
  caller_address text,
  callout_count bigint,
  avg_multiple double precision,
  max_multiple double precision,
  last_callout_at timestamptz,
  username text,
  avatar text
)
language sql
stable
as $$
  select
    o.caller_address,
    count(*)::bigint as callout_count,
    coalesce(sum(o.multiple), 0) / count(*) as avg_multiple,
    coalesce(max(o.multiple), 0) as max_multiple,
    max(o.created_at) as last_callout_at,
    max(s.username) as username,
    max(s.avatar) as avatar
  from public.pump_callout_observations o
  left join public.pump_caller_stats s on s.caller_address = o.caller_address
  where o.created_at >= p_since
  group by o.caller_address
  having count(*) >= greatest(p_min_calls, 1)
  order by
    case when p_metric = 'avg' then coalesce(sum(o.multiple), 0) / count(*) end desc nulls last,
    case when p_metric = 'max' then coalesce(max(o.multiple), 0) end desc nulls last,
    case when p_metric = 'count' then count(*)::double precision end desc nulls last,
    count(*) desc
  limit greatest(p_limit, 1);
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security — service-role-only, no client policies.
-- ---------------------------------------------------------------------------
alter table public.pump_caller_stats         enable row level security;
alter table public.pump_callout_observations enable row level security;

-- Lock the RPCs to the backend service role only; a keyless PostgREST caller must
-- not be able to write the aggregate or scan the board directly.
revoke all on function public.pump_record_caller_stats(jsonb) from public;
revoke all on function public.pump_top_callers_window(timestamptz, text, int, int) from public;
grant execute on function public.pump_record_caller_stats(jsonb) to service_role;
grant execute on function public.pump_top_callers_window(timestamptz, text, int, int) to service_role;

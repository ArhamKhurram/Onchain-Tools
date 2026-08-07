-- Durable sniper state: wallets, rules, per-day budgets, the fire log and the
-- kill switch. Until this migration the sniper's entire state lived in
-- `InMemorySniperStore` (backend/src/sniper/store.ts), so a Railway redeploy
-- silently reset the daily cap, dropped the kill switch back to OFF and lost
-- the fire log -- the three rows an operator most needs to survive a restart.
--
-- This is a SIBLING of `StorageProvider`, not an extension. storage/interface.ts
-- is 20 methods of Discord/Telegram/contract shape; the sniper's shape (budgets,
-- fires, kill switch) has nothing to do with it. See backend/src/sniper/store.ts:3-6
-- and the reuse map in docs/architecture/sniper.md. It DOES follow the interface's
-- one universal convention: every access is scoped by user_id.
--
-- Deliberate deviations from the ERD in docs/architecture/sniper-rules.md:
--
--   * `handles` and `wallet_ids` are arrays on the rule rather than the
--     RULE_HANDLES / RULE_WALLETS join tables. Those tables exist to build the
--     tweet fan-out index (`Map<handle, ruleId[]>`) and the alpha has no tweet
--     feed to fan out from -- it fires from Slotshark's own Twitter triggers
--     (docs/architecture/sniper.md, alpha trigger decision). They land with M2,
--     alongside the code that reads them.
--   * No FILLS table. It is 1:0..1 with SNIPER_FIRES and exists to hold what a
--     reconciler writes; the alpha has no reconciler, because no Slotshark
--     fill-history endpoint is known to this repo. signature/amount live on the
--     fire row and a human resolves `unknown` legs by hand.
--   * No EXECUTION_VENUES table. `venue` is a check constraint mirroring the
--     `Venue` union in backend/src/sniper/types.ts. A table buys per-user venue
--     rows, which is M11; a constraint buys the same integrity today and cannot
--     drift from the union by an INSERT.
--
-- RLS shape, and it is the money-safety property of this file: every table is
-- select-own for `authenticated` and has NO insert/update/delete policy. The
-- only writer is the backend's service role, reached through /sniper/v1. So a
-- browser -- or an XSS payload running inside the console -- cannot raise its
-- own daily cap, zero its own spent_today, un-trip its own kill switch, or
-- forge a fire row: no policy exists that would let it. Contrast
-- `sniper_venue_credentials`, where the WRITE is precisely the thing that must
-- not touch this backend and therefore goes direct.

-- ---------------------------------------------------------------------------
-- Wallets
-- ---------------------------------------------------------------------------
-- The backing store `SlotsharkConfig.resolveWalletAddress` never had. Both
-- venues in this system are custodial, so `address` is the wallet the venue
-- holds and funds -- OCT holds no key for it (ADR-011).

create table if not exists public.sniper_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default '',
  chain text not null check (chain in ('sol', 'bsc')),
  venue text not null check (venue in ('slotshark')),

  -- Case-SENSITIVE. A Solana pubkey is base58; lowercasing it produces a
  -- different, still-plausible address, which is a silent way to send funds
  -- nowhere. Never `lower()` this column and never index it case-insensitively.
  address text not null check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,48}$'),

  unit text not null check (unit in ('SOL', 'BNB', 'USDC')),
  per_fire_cap numeric not null check (per_fire_cap > 0),
  daily_cap numeric not null check (daily_cap > 0),
  max_open integer not null check (max_open > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, venue, address),

  -- A daily cap below one fire's cap refuses every fire after the first,
  -- silently, at the reservation. Reject the self-contradiction at write time.
  constraint sniper_wallets_daily_covers_fire check (daily_cap >= per_fire_cap),

  -- Slotshark is Solana-only (executors/slotshark.ts:36). Without this a bsc
  -- wallet is creatable and only fails at ExecutorRegistry.resolve, i.e. inside
  -- the fire path rather than at configuration time.
  constraint sniper_wallets_venue_supports_chain check (venue <> 'slotshark' or chain = 'sol'),

  -- Caps are denominated in native units to avoid needing a price oracle in the
  -- hot path. That only works if a wallet's unit is one its chain can hold.
  constraint sniper_wallets_unit_matches_chain check (
    (chain = 'sol' and unit in ('SOL', 'USDC')) or
    (chain = 'bsc' and unit in ('BNB', 'USDC'))
  )
);

create index if not exists idx_sniper_wallets_user
  on public.sniper_wallets (user_id);

comment on table public.sniper_wallets is
  'Custodial venue wallets a user snipes from, plus their risk caps. OCT holds '
  'no private key for these -- the venue does (ADR-011). `address` is the '
  'venue-side pubkey passed to POST /buy.';

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

create table if not exists public.sniper_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),

  -- A rule is BORN 'draft' and can only reach 'armed' through
  -- POST /sniper/v1/rules/:id/arm, which runs validateRule first. This default
  -- is part of the safety contract, not a convenience: nothing may fire as a
  -- side effect of saving.
  state text not null default 'draft' check (state in ('draft', 'disabled', 'armed')),

  chain text not null check (chain in ('sol', 'bsc')),
  venue text not null check (venue in ('slotshark', 'dryrun')),

  -- TRIGGER FIELDS -- INERT IN THE ALPHA. Nothing in OCT reads a tweet: the
  -- alpha fires from Slotshark's own Twitter triggers, configured in their
  -- account, and OCT is never told when one fires. These columns are persisted
  -- so a rule written today still means the same thing when M2's feed lands.
  -- Do not build UI implying they gate anything.
  handles text[] not null default '{}',
  interaction_types text[] not null default '{tweet}',
  matcher jsonb not null,

  phase smallint not null default 1 check (phase in (1, 2)),
  mint text,

  entry_style text not null check (entry_style in ('single', 'ladder')),
  ladder_split jsonb,

  size_unit text not null check (size_unit in ('SOL', 'BNB', 'USDC')),
  -- Spend per WALLET per trigger, before the ladder split. The whole trigger
  -- therefore spends size_total * array_length(wallet_ids, 1), which is exactly
  -- what per_trigger_cap bounds (backend/src/sniper/legs.ts:3-7).
  size_total numeric not null check (size_total > 0),
  wallet_ids uuid[] not null default '{}',

  per_fire_cap numeric not null check (per_fire_cap > 0),
  per_trigger_cap numeric not null check (per_trigger_cap > 0),

  slippage_bps integer not null check (slippage_bps between 1 and 10000),
  exec_params jsonb not null,

  max_tweet_age_ms integer not null check (max_tweet_age_ms > 0),
  fire_window_ms integer not null check (fire_window_ms > 0),
  max_attempts integer not null check (max_attempts between 1 and 10),
  mcap_ceiling numeric check (mcap_ceiling is null or mcap_ceiling > 0),

  auto_disable_after_fire boolean not null default true,

  -- Defaults true, and the API refuses to honour a `false` in a create or a
  -- patch body. Going live is its own confirmed call.
  dry_run boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Phase 1 binds the mint up front; executeFire aborts with `no_mint`
  -- otherwise (executeFire.ts:68-72). Without this constraint such a rule sits
  -- armed and inert, looking healthy and firing nothing.
  constraint sniper_rules_phase1_needs_mint check (phase <> 1 or mint is not null),

  constraint sniper_rules_ladder_split_shape check (
    (entry_style = 'single' and ladder_split is null) or
    (entry_style = 'ladder'  and jsonb_typeof(ladder_split) = 'array')
  ),

  -- per_trigger_cap bounds the whole trigger, per_fire_cap one leg of it. A
  -- trigger cap below the fire cap makes the fire cap unreachable and is always
  -- a typo, never an intent.
  constraint sniper_rules_trigger_cap_covers_fire check (per_trigger_cap >= per_fire_cap),

  constraint sniper_rules_venue_supports_chain check (venue <> 'slotshark' or chain = 'sol'),

  -- exec_params is the chain-tagged union from backend/src/sniper/types.ts. The
  -- tag must agree with the rule's chain or a sol rule carries wei-valued gas
  -- fields and estimateFees silently stops adding tip/priorityFee to the
  -- reservation -- which makes the daily cap soft.
  constraint sniper_rules_exec_kind_matches_chain check (
    (chain = 'sol' and exec_params ->> 'kind' = 'sol') or
    (chain = 'bsc' and exec_params ->> 'kind' = 'evm')
  )
);

create index if not exists idx_sniper_rules_user
  on public.sniper_rules (user_id, created_at desc);

comment on column public.sniper_rules.handles is
  'Watched accounts, lowercased. INERT in the alpha -- OCT runs no tweet feed; '
  'Slotshark''s own Twitter triggers carry the alpha. Persisted for M2.';

-- ---------------------------------------------------------------------------
-- Budget -- one row per (wallet, chain, UTC day)
-- ---------------------------------------------------------------------------

create table if not exists public.sniper_budget (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null references public.sniper_wallets(id) on delete cascade,
  chain text not null check (chain in ('sol', 'bsc')),

  -- Denormalised from the wallet ON PURPOSE, and load-bearing in the
  -- reservation predicate: without it `5` (SOL) validates against a
  -- per_fire_cap of `1000` (USDC) and 5 SOL leaves the wallet.
  unit text not null check (unit in ('SOL', 'BNB', 'USDC')),

  day date not null,

  -- Snapshotted from the wallet when the day's row is created, so raising a cap
  -- mid-day does not retroactively re-authorise a fire that was already refused.
  per_fire_cap numeric not null,
  daily_cap numeric not null,
  max_open integer not null,

  spent_today numeric not null default 0 check (spent_today >= 0),
  open_positions integer not null default 0 check (open_positions >= 0),
  created_at timestamptz not null default now(),

  -- The reservation's ON CONFLICT target. Keyed (wallet_id, chain, day) and NOT
  -- on user_id: a predicate keyed on user_id alone matches every wallet's row
  -- for a two-wallet operator, debits both, and returns two rows -- so the
  -- zero-row test passes while the wrong budget was checked.
  unique (wallet_id, chain, day)
);

create index if not exists idx_sniper_budget_user_day
  on public.sniper_budget (user_id, day desc);

-- ---------------------------------------------------------------------------
-- Fire log -- the reconciliation substrate
-- ---------------------------------------------------------------------------

create table if not exists public.sniper_fires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- `set null` on both parents: deleting a rule or a wallet must never delete
  -- the record of money it moved.
  rule_id uuid references public.sniper_rules(id) on delete set null,
  wallet_id uuid references public.sniper_wallets(id) on delete set null,

  trigger_key text not null,
  leg_no integer not null,
  attempts integer not null default 0,
  mint text not null,
  amount numeric not null,
  state text not null check (state in ('filled', 'expired', 'aborted', 'unknown')),

  -- Whether this row spent real money. `FireRecord` had no such field, so the
  -- fire log could not distinguish a synthetic dry-run fill from a real one --
  -- the single most dangerous ambiguity a money log can carry.
  dry_run boolean not null,
  venue text not null check (venue in ('slotshark', 'dryrun')),

  signature text,
  abort_reason text,

  -- Human resolution of an `unknown` leg. `unknown` means the send may have
  -- landed, so the reservation is HELD and the leg is never retried
  -- (executeFire.ts:204-208). reconcile(wallet, mint, since) would resolve it
  -- automatically, but no Slotshark fill-history endpoint is known to this
  -- repo, so the alpha has an operator check Slotshark's dashboard and record
  -- what they found. Null on every row that was never `unknown`.
  resolution text check (resolution in ('filled', 'not_filled')),
  resolved_at timestamptz,
  resolved_note text,

  fired_at timestamptz not null default now(),

  -- One row per (rule, trigger, wallet, leg). This is the leg-level constraint
  -- from docs/architecture/sniper-rules.md:134: without the fan-out
  -- discriminators, legs 2..N of a ladder collide on the trigger key and abort
  -- as duplicates, with money attached. `attempts` is updated IN PLACE -- a
  -- retry that inserts a second row defeats the constraint.
  unique (rule_id, trigger_key, wallet_id, leg_no)
);

create index if not exists idx_sniper_fires_user_time
  on public.sniper_fires (user_id, fired_at desc);

-- Powers the Fires tab's "N legs holding a reservation" banner cheaply.
create index if not exists idx_sniper_fires_unresolved
  on public.sniper_fires (user_id, fired_at desc)
  where state = 'unknown' and resolution is null;

-- ---------------------------------------------------------------------------
-- Kill switch
-- ---------------------------------------------------------------------------
-- Per user, not global. One user's kill switch must never stop another user's
-- fires -- the concrete multi-tenancy gap in InMemorySniperStore, which keyed
-- the switch on nothing at all.

create table if not exists public.sniper_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  kill_switch boolean not null default false,
  tripped_at timestamptz,
  tripped_reason text,
  updated_at timestamptz not null default now()
);

comment on table public.sniper_state is
  'Per-user sniper kill switch. Scope is OCT-initiated fires ONLY: in the alpha '
  'the automatic tweet->buy loop runs inside Slotshark and never calls '
  'executeFire, so this row cannot stop a Slotshark-side trigger. The UI must '
  'say so.';

-- ---------------------------------------------------------------------------
-- updated_at triggers (public.update_updated_at() ships in the core schema)
-- ---------------------------------------------------------------------------

drop trigger if exists sniper_wallets_updated_at on public.sniper_wallets;
create trigger sniper_wallets_updated_at
  before update on public.sniper_wallets
  for each row execute function public.update_updated_at();

drop trigger if exists sniper_rules_updated_at on public.sniper_rules;
create trigger sniper_rules_updated_at
  before update on public.sniper_rules
  for each row execute function public.update_updated_at();

drop trigger if exists sniper_state_updated_at on public.sniper_state;
create trigger sniper_state_updated_at
  before update on public.sniper_state
  for each row execute function public.update_updated_at();

-- ---------------------------------------------------------------------------
-- RLS -- read-own only. Every mutation is service-role, through /sniper/v1.
-- ---------------------------------------------------------------------------
-- CREATE POLICY has no IF NOT EXISTS in Postgres 17 and these migrations are
-- applied by hand against two projects, so drop-then-create keeps it idempotent
-- (same reasoning as 20260730170000_sniper_venue_credentials.sql).

alter table public.sniper_wallets enable row level security;
alter table public.sniper_rules   enable row level security;
alter table public.sniper_budget  enable row level security;
alter table public.sniper_fires   enable row level security;
alter table public.sniper_state   enable row level security;

drop policy if exists "sniper_wallets_select_own" on public.sniper_wallets;
create policy "sniper_wallets_select_own"
  on public.sniper_wallets for select
  using (auth.uid() = user_id);

drop policy if exists "sniper_rules_select_own" on public.sniper_rules;
create policy "sniper_rules_select_own"
  on public.sniper_rules for select
  using (auth.uid() = user_id);

drop policy if exists "sniper_budget_select_own" on public.sniper_budget;
create policy "sniper_budget_select_own"
  on public.sniper_budget for select
  using (auth.uid() = user_id);

drop policy if exists "sniper_fires_select_own" on public.sniper_fires;
create policy "sniper_fires_select_own"
  on public.sniper_fires for select
  using (auth.uid() = user_id);

drop policy if exists "sniper_state_select_own" on public.sniper_state;
create policy "sniper_state_select_own"
  on public.sniper_state for select
  using (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy on any of the five. See the
-- header. If a future change adds one, it must explain why a browser needs to
-- write a money-accounting row directly.

-- ---------------------------------------------------------------------------
-- The reservation. Check-then-spend is a race, so the cap is reserved in the
-- same statement that tests it (docs/architecture/sniper-execution.md:203-242).
-- ---------------------------------------------------------------------------
-- This is a function rather than three client round trips for ATOMICITY, not
-- privilege -- the service role already bypasses RLS. The rollover insert, the
-- debiting update and the diagnosis read must not be interleavable with another
-- fire. The service-role check below is defence in depth, in the fail-CLOSED
-- form: `auth.role()` returns NULL for any caller without a PostgREST JWT
-- context, `NULL <> 'service_role'` is NULL, and plpgsql treats a NULL IF as
-- FALSE -- so the naive form would skip the raise and hand a money-spending
-- primitive to a direct Postgres connection.
--
-- Returns NULL on success, otherwise the refusal reason, using exactly the
-- strings in `ReservationResult` so the hosted and in-memory stores are
-- indistinguishable to executeFire.

create or replace function public.sniper_reserve_leg(
  p_user_id uuid,
  p_wallet_id uuid,
  p_chain text,
  p_unit text,
  p_day date,
  p_amount numeric
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.sniper_wallets;
  v_row public.sniper_budget;
  v_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', auth.role(), '') is distinct from 'service_role' then
    raise exception 'sniper_reserve_leg is restricted to the service role';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'sniper_reserve_leg called with a non-positive amount';
  end if;

  select * into v_wallet
  from public.sniper_wallets
  where id = p_wallet_id and user_id = p_user_id;

  -- Wallet missing, or belongs to another user, or is on another chain. All
  -- three are `no_wallet` to the caller: a leg cannot be reserved against a
  -- budget that does not exist, and distinguishing them here would let a caller
  -- probe which wallet ids exist on other accounts.
  if not found or v_wallet.chain is distinct from p_chain then
    return 'no_wallet';
  end if;

  -- Rollover guard -- NOT optional. Without it the UPDATE below matches zero
  -- rows on the first fire after every date change, which the caller reads as
  -- "cap refused", so every fire is refused until someone inserts a row by hand.
  insert into public.sniper_budget
    (user_id, wallet_id, chain, unit, day,
     per_fire_cap, daily_cap, max_open, spent_today, open_positions)
  values
    (p_user_id, p_wallet_id, v_wallet.chain, v_wallet.unit, p_day,
     v_wallet.per_fire_cap, v_wallet.daily_cap, v_wallet.max_open, 0, 0)
  on conflict (wallet_id, chain, day) do nothing;

  -- p_amount INCLUDES venue fee, tip and priority fee (estimateFees). Debiting
  -- the swap amount alone makes a daily cap soft by an unbounded margin.
  update public.sniper_budget
     set spent_today    = spent_today + p_amount,
         open_positions = open_positions + 1
   where wallet_id = p_wallet_id
     and chain     = p_chain
     and day       = p_day
     and unit      = p_unit
     and p_amount <= per_fire_cap
     and spent_today + p_amount <= daily_cap
     and open_positions < max_open;

  get diagnostics v_count = row_count;

  if v_count = 1 then
    return null;
  end if;

  if v_count > 1 then
    -- Impossible under `unique (wallet_id, chain, day)`. If it ever becomes
    -- possible the correct response is to abort loudly, not to let a fire
    -- proceed against an unknown number of debited budgets. The exception rolls
    -- the debits back.
    raise exception 'sniper_reserve_leg debited % rows for wallet %', v_count, p_wallet_id;
  end if;

  -- Zero rows. Re-read to say WHY, in the same order InMemorySniperStore checks
  -- them (store.ts:130-134) so both implementations return identical reasons.
  select * into v_row
  from public.sniper_budget
  where wallet_id = p_wallet_id and chain = p_chain and day = p_day;

  if not found then
    return 'no_wallet';
  end if;
  if v_row.unit is distinct from p_unit then
    return 'unit_mismatch';
  end if;
  if p_amount > v_row.per_fire_cap then
    return 'per_fire_cap';
  end if;
  if v_row.spent_today + p_amount > v_row.daily_cap then
    return 'daily_cap';
  end if;
  if v_row.open_positions >= v_row.max_open then
    return 'max_open';
  end if;

  -- Fell through every predicate: a concurrent writer moved the row between the
  -- UPDATE and this read. Refuse rather than retry -- the caller treats a
  -- refusal as terminal for the leg, which is the safe direction, and inventing
  -- a plausible-looking reason would misreport why money did not move.
  return 'contended';
end;
$$;

comment on function public.sniper_reserve_leg(uuid, uuid, text, text, date, numeric) is
  'Atomically reserve amount-including-fees against a wallet''s UTC-day budget. '
  'Returns NULL when reserved, else a ReservationResult reason. Service role only.';

revoke all on function public.sniper_reserve_leg(uuid, uuid, text, text, date, numeric) from public;
revoke all on function public.sniper_reserve_leg(uuid, uuid, text, text, date, numeric) from anon;
revoke all on function public.sniper_reserve_leg(uuid, uuid, text, text, date, numeric) from authenticated;
grant execute on function public.sniper_reserve_leg(uuid, uuid, text, text, date, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- The release. Called on a PROVABLY-dead send, and on a dry-run synthetic fill.
-- Never on `unknown` -- that reservation is held on purpose.
-- ---------------------------------------------------------------------------

create or replace function public.sniper_release_leg(
  p_user_id uuid,
  p_wallet_id uuid,
  p_chain text,
  p_day date,
  p_amount numeric,
  p_close_position boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', auth.role(), '') is distinct from 'service_role' then
    raise exception 'sniper_release_leg is restricted to the service role';
  end if;

  -- greatest(0, ...) on both columns: a double release must floor rather than
  -- go negative, because a negative spent_today would silently GRANT budget.
  update public.sniper_budget
     set spent_today    = greatest(0, spent_today - p_amount),
         open_positions = case when p_close_position
                               then greatest(0, open_positions - 1)
                               else open_positions end
   where user_id  = p_user_id
     and wallet_id = p_wallet_id
     and chain     = p_chain
     and day       = p_day;
end;
$$;

comment on function public.sniper_release_leg(uuid, uuid, text, date, numeric, boolean) is
  'Reverse a reservation for a provably-dead send or a dry-run synthetic fill. '
  'Never called for an `unknown` outcome. Service role only.';

revoke all on function public.sniper_release_leg(uuid, uuid, text, date, numeric, boolean) from public;
revoke all on function public.sniper_release_leg(uuid, uuid, text, date, numeric, boolean) from anon;
revoke all on function public.sniper_release_leg(uuid, uuid, text, date, numeric, boolean) from authenticated;
grant execute on function public.sniper_release_leg(uuid, uuid, text, date, numeric, boolean) to service_role;

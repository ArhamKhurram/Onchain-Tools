-- LP automation MANUAL COMMAND QUEUE (LP_AUTOMATION_PLAN.md §4, §9 point 1, §10).
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT AN ENDPOINT
-- ---------------------------------------------------------------------------
-- The dashboard needs to ask for a compound / rebalance / exit on a position.
-- Neither side of the wire can do that directly:
--
--   * `backend/` holds no signing key, deliberately — it ingests arbitrary
--     Discord/Telegram input and serves public HTTP. It must never be able to
--     move funds.
--   * `lp-automation/` holds the key and has NO INBOUND NETWORK SURFACE by
--     design (§9 point 1). Adding an HTTP listener to the signer process to
--     accept "please compound" would hand an attacker the one thing the whole
--     architecture is built to deny them.
--
-- So the dashboard writes a row here and the signer process POLLS it. This
-- table is a TRIGGER, never an AUTHORITY: a claimed command runs through the
-- exact same `ActionExecutor` ladder an autonomous action does — quarantine
-- check, allowlist-at-execution-time, dry run, audit intent before broadcast,
-- per-position lock, on-chain module caps, `LP_ARMED` gate. Nothing in this
-- table widens what the worker may do; it only says which of the things it was
-- already allowed to do a human would like done now.
--
-- ---------------------------------------------------------------------------
-- WHY THE BROWSER MAY INSERT BUT NOT UPDATE
-- ---------------------------------------------------------------------------
-- Status transitions (pending -> claimed -> done/failed) are the worker's
-- record of what it actually did. A client that can update its own row can mark
-- a failed exit as `done` and hide the failure from the very person who asked
-- for it — the audit log would disagree with the dashboard, and the dashboard is
-- what a human looks at. So `authenticated` gets select + insert only; every
-- transition is a service-role write from the worker.

create table public.lp_automation_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The Uniswap V3 position NFT id, as a string. Text rather than numeric for
  -- the same reason it is a string everywhere else in this system: it is an
  -- identifier that happens to look like a number, and it is compared for
  -- equality only, never ordered or summed.
  token_id text not null check (token_id ~ '^[1-9][0-9]{0,77}$'),

  -- The pool the requester believed the position was in. Recorded so the worker
  -- can refuse a command whose world has changed since it was queued, and so a
  -- reader can see which pool a queued action was about without a join against
  -- a live Krystal call. Lowercase, normalized by the backend before insert, so
  -- allowlist comparison downstream is plain string equality.
  pool_address text not null check (pool_address ~ '^0x[0-9a-f]{40}$'),

  -- The three lifecycle actions a human can ask for on an EXISTING position.
  -- `enter` is deliberately absent: opening a new position needs a pool, a size
  -- and a range, none of which this row carries, and none of which should be
  -- chosen by a queue entry.
  action text not null check (action in ('compound', 'rebalance', 'exit')),

  -- pending -> claimed -> done | failed. There is no path back to `pending`:
  -- once the worker has claimed a command it may have simulated, audited, or
  -- broadcast against it, and re-queueing it is exactly the double-execution
  -- the claim exists to prevent. A user who wants to retry queues a new command.
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'done', 'failed')),

  requested_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,

  -- Result columns, written by the worker only. `tx_hash` is non-null only for
  -- a genuine broadcast; a disarmed run records `failed` with a reason saying
  -- so, never `done` (see `commandSource.ts`).
  tx_hash text,
  error text
);

-- ---------------------------------------------------------------------------
-- AT MOST ONE OPEN COMMAND PER POSITION
-- ---------------------------------------------------------------------------
-- Two queued compounds on one position is, at best, a double spend of gas; at
-- worst two transactions built from the same pre-transaction state, which is
-- the failure the worker's per-position lock exists to stop in-process. This
-- index is the same guarantee at rest, and it holds across processes and across
-- a restart — a double-click in the dashboard cannot outrun it, because the
-- database, not the application, is enforcing it.
--
-- A partial unique index rather than a trigger, so two concurrent inserts
-- cannot both pass a read-then-write check.
create unique index idx_lp_automation_commands_one_open
  on public.lp_automation_commands (user_id, token_id)
  where status in ('pending', 'claimed');

-- The worker's poll: "oldest pending command". Ordered by requested_at so a
-- queue that briefly backs up is drained oldest-first rather than newest-first.
create index idx_lp_automation_commands_queue
  on public.lp_automation_commands (status, requested_at);

-- The dashboard's read: "recent commands for this position, newest first".
create index idx_lp_automation_commands_user_recent
  on public.lp_automation_commands (user_id, token_id, requested_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- select + insert for `authenticated`, scoped to auth.uid(). NO update policy
-- and NO delete policy, on purpose (see the header): a browser that can mark
-- its own command `done` can hide a failure, and a browser that can delete one
-- can erase the request that preceded a transaction.
--
-- The insert policy pins the row's initial state as well as its owner. Without
-- that, a client could insert a row that is already `claimed` (invisible to the
-- worker's poll, but still occupying the one-open-command slot and so blocking
-- every future command for that position) or one that already carries a
-- `tx_hash` it invented.

alter table public.lp_automation_commands enable row level security;

create policy "Users read own lp commands"
  on public.lp_automation_commands for select
  using (auth.uid() = user_id);

create policy "Users queue own lp commands"
  on public.lp_automation_commands for insert
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and claimed_at is null
    and completed_at is null
    and tx_hash is null
    and error is null
  );

comment on table public.lp_automation_commands is
  'Manual action queue for LP positions (LP_AUTOMATION_PLAN.md §9 point 1). The dashboard enqueues an intent; the lp-automation worker polls, claims and executes it through the SAME ActionExecutor path as an automatic action. A TRIGGER, not an authority: it adds no permission the worker did not already have.';

comment on column public.lp_automation_commands.status is
  'pending -> claimed -> done | failed. Transitions are service-role writes from the worker; RLS gives browsers select + insert only, so a client cannot mark its own command done and hide a failure.';

comment on column public.lp_automation_commands.pool_address is
  'Pool the requester believed the position was in, lowercased. Re-checked against the live position and against the active policy allowlist AT EXECUTION TIME — this value authorizes nothing on its own.';

comment on column public.lp_automation_commands.tx_hash is
  'Set only for a genuine broadcast. A disarmed worker records status=failed with an explanatory error rather than done, so a dry run is never mistaken for a completed action.';

-- LP automation DEPLOYMENT SETTINGS (LP_AUTOMATION_PLAN.md §4, §9 point 3).
--
-- The Safe address is what identifies *whose* positions to fetch from Krystal
-- (`GET /all/v1/lp/userPositions?addresses=…`) and which Safe the module is
-- installed on. Until now it lived only in `lp-automation/.env`, so the
-- dashboard had no way to know it — this table is where the server learns it.
--
-- WHY A SEPARATE TABLE FROM `lp_automation_policies`, NOT TWO MORE COLUMNS ON IT
--
--   1. The policy table is VERSIONED AND APPEND-ONLY, because an open position
--      pins a policy version (§5) and a version's contents must never change.
--      The Safe address is *deployment identity*, not a rule: correcting a typo
--      in it, or pointing the dashboard at a freshly redeployed Safe, must NOT
--      mint a new policy version. As a column it would, and every such edit
--      would fork the spend caps into a new version nobody asked for.
--
--   2. `lp_automation_policies_immutable()` compares an explicit column list.
--      Adding a mutable column to that table means editing that trigger to
--      exempt it — i.e. punching a hole in the exact mechanism that guarantees
--      a pinned version still means what it meant when it was pinned. Not a
--      hole worth punching for a value that is not part of any rule.
--
-- So: mutable, one row per user, plain upsert. No versioning, no history.

create table public.lp_automation_settings (
  -- One row per user, keyed directly on the user: there is exactly one Safe
  -- deployment per account in phase 1, so the PK *is* the user id (no separate
  -- surrogate key, and no way to accidentally end up with two rows).
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- The Gnosis Safe holding the LP positions. Lowercase 0x-prefixed 20-byte
  -- address, normalized by the backend before write so downstream comparisons
  -- (allowlist membership, Krystal query building) are plain string equality.
  --
  -- NULL is a first-class state, not an error: it means "not set up yet", which
  -- is what every account looks like before the operator deploys a Safe. The
  -- positions endpoint reports that as `configured: false` and returns an empty
  -- list rather than failing.
  safe_address text
    check (safe_address is null or safe_address ~ '^0x[0-9a-f]{40}$'),

  -- The `OctAutomationModule` instance enabled on that Safe (§4). Recorded for
  -- display/diagnostics only — the module enforces its own bounds on-chain and
  -- nothing here can widen them. Same nullable-until-deployed semantics.
  module_address text
    check (module_address is null or module_address ~ '^0x[0-9a-f]{40}$'),

  updated_at timestamptz not null default now()
);

comment on table public.lp_automation_settings is
  'Mutable per-user LP deployment identity (Safe + module address). Deliberately separate from lp_automation_policies, which is versioned and append-only: changing the Safe address is not a policy change and must not mint a new policy version.';

comment on column public.lp_automation_settings.safe_address is
  'Lowercase 0x address of the Safe whose LP positions are displayed. NULL means "not configured yet" — a normal state, not an error.';

comment on column public.lp_automation_settings.module_address is
  'Lowercase 0x address of the OctAutomationModule enabled on the Safe. Informational: the on-chain module, not this row, enforces the bounds.';

-- ---------------------------------------------------------------------------
-- updated_at is maintained by the database, not the client.
-- ---------------------------------------------------------------------------
-- The write path is an upsert, and an upsert's UPDATE arm only sets the columns
-- the client actually sent. Without this trigger, a client that PUTs just
-- `safe_address` would leave `updated_at` frozen at the row's insert time — the
-- timestamp would silently stop tracking the thing it exists to track.

create or replace function public.lp_automation_settings_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger lp_automation_settings_touch
  before update on public.lp_automation_settings
  for each row execute function public.lp_automation_settings_touch();

-- ---------------------------------------------------------------------------
-- RLS — scoped to auth.uid(), same shape as the other user-owned tables.
-- ---------------------------------------------------------------------------
-- Unlike lp_automation_policies, this table IS meant to be updated in place, so
-- there is an update policy alongside select and insert. There is still no
-- delete policy: a settings row is cleared by nulling its columns, and the row
-- itself only ever disappears with the account (via the on-delete cascade).

alter table public.lp_automation_settings enable row level security;

create policy "Users read own lp settings"
  on public.lp_automation_settings for select
  using (auth.uid() = user_id);

create policy "Users insert own lp settings"
  on public.lp_automation_settings for insert
  with check (auth.uid() = user_id);

create policy "Users update own lp settings"
  on public.lp_automation_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

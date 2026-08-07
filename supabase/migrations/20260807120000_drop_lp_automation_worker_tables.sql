-- Retire the LP automation worker's tables. The feature and every line of code
-- that read them were removed from `dev` on 2026-08-07.
--
-- WHY A NEW MIGRATION RATHER THAN DELETING THE OLD ONES:
-- `20260726170000` and `20260726180000` were already applied to the dev Supabase
-- project, so their versions are recorded in `supabase_migrations.schema_migrations`
-- there. Deleting applied files desynchronises that ledger — the CLI reports the
-- versions as remote-only, `db push`/`db diff` complain, and a fresh `db reset`
-- from the repo produces a database that no longer matches the live one. Applied
-- history is append-only; you undo it by moving forward, not by rewriting it.
-- So the ten LP migration files stay exactly as written and this one drops what
-- they created.
--
-- WHY THESE TWO TABLES AND NOT `lp_automation_policies`:
-- These two exist only on the dev project. `lp_automation_policies` (and its
-- `lp_is_pool_address_array` / `lp_automation_policies_immutable` /
-- `lp_append_policy` helpers) also exists on `main` and has been applied to
-- prod — ADR-009 records the reason main keeps it: main's migration set must
-- describe the database main deploys to. Dropping it here would make dev's
-- schema diverge from main's for no gain, and the table is inert either way now
-- that nothing reads it. It is left standing on both branches, unreferenced.
--
-- There is a security reason to prefer dropping over orphaning, and it applies
-- to exactly these two tables: `lp_automation_settings` holds Gnosis Safe
-- addresses and `lp_automation_commands` is a signing command queue. Custody-
-- adjacent rows that no code can reach are pure liability — no reader, no
-- writer, and no one left to notice if they were tampered with.

-- `cascade` covers the indexes, RLS policies, constraints and the update trigger
-- that later LP migrations hung off these tables (safe_addresses/multi-Safe,
-- the compound/rebalance/enter/increase/decrease command columns). Neither table
-- is referenced by a foreign key from anywhere else — both point outward at
-- auth.users and nothing points back — so cascade cannot reach a non-LP object.
drop table if exists public.lp_automation_commands cascade;
drop table if exists public.lp_automation_settings cascade;

-- The settings table's updated_at trigger function. Dropped separately because
-- `drop table` removes the trigger but leaves the function it called behind.
drop function if exists public.lp_automation_settings_touch();

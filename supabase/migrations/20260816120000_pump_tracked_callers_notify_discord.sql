-- Per-caller Discord-DM opt-in for pump.fun callout follows.
--
-- APPLIED BY HAND. The backend TOLERATES this column being absent: every read
-- and write in backend/src/pumpfun/calloutStore.ts detects the one PostgREST
-- error that means "notify_discord doesn't exist", warns once, and retries
-- without the column (defaulting to true). So callout follow/unfollow and the
-- existing WS + Pushover fan-out keep working unchanged before this runs; only
-- the DM leg is dormant until it is applied.
--
-- WHY DEFAULT TRUE (and why existing rows are backfilled true):
-- this column on its own can never cause a DM. Two further gates sit in front
-- of it, both stored in user_configs.settings.discordBotDm and both OFF by
-- default for existing accounts:
--
--   1. discordBotDm.enabled          -- "the bot may DM me at all"
--   2. discordBotDm.triggers.pumpCallout -- "callouts are a DM-worthy class"
--
-- So the safe-by-default behaviour is already carried by the settings gates.
-- Defaulting this column to false would instead mean that a user who turns
-- callout DMs ON in Settings gets silence from every caller they already
-- follow — the exact "I thought the feature was broken" failure this work
-- exists to fix. The per-caller boolean's job is "mute THIS caller's DMs",
-- not "arm the feature".
--
-- Mirrors notify_pushover exactly (same table, same default, same semantics),
-- so the two delivery legs stay symmetrical in the fan-out loop.

alter table public.pump_tracked_callers
  add column if not exists notify_discord boolean not null default true;

comment on column public.pump_tracked_callers.notify_discord is
  'Per-caller Discord-DM opt-in. Gated behind discordBotDm.enabled and discordBotDm.triggers.pumpCallout in user_configs.settings; this flag only mutes an individual caller.';

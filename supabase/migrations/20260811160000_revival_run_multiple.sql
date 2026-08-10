-- Revival alerts: record how far the token had ALREADY run when the alert fired.
--
-- The detector now establishes a pre-ignition baseline price (median hourly
-- close over the dormant window that qualified the token) and refuses to fire
-- once price is more than maxRunFromBaseline (3.0x) above it — the fix for
-- alerts landing in the middle of a run instead of at its ignition (TOAD fired
-- at $16-17M, ~600x off its baseline).
--
-- Both numbers are persisted so a late alert is diagnosable after the fact
-- rather than invisible: run_multiple near 1x is an alert at the ignition, and
-- a drift upward across rows is the early warning that the gate needs
-- recalibrating.
--
-- Nullable with no default and no backfill: rows written before this migration
-- genuinely had no baseline, and inventing one would corrupt the calibration
-- history this column exists to provide.

alter table public.revival_alerts
  add column if not exists baseline_price_usd numeric,
  add column if not exists run_multiple numeric;

comment on column public.revival_alerts.baseline_price_usd is
  'Pre-ignition baseline (median hourly close over the qualifying dormant window), USD.';
comment on column public.revival_alerts.run_multiple is
  'price_usd / baseline_price_usd at fire time — how far the token had already run.';

-- After applying by hand, reload PostgREST''s schema cache:
--   NOTIFY pgrst, 'reload schema';

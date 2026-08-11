-- Breakout alerts share the revival_alerts table, discriminated by `kind`.
--
-- Breakout is revival's sibling signal: the SAME detector pass, but firing on
-- the one shape revival's drawdown gate exists to reject — quiet consolidation
-- NEAR the highs (sub-35% drawdown) igniting, instead of a token that died
-- first (TOAD broke out of a ~27%-below-peak plateau on Aug 11 and revival
-- correctly stayed silent; the operator wants that shape as its own alert).
-- The row shape is otherwise identical (same fire-time numbers, same 24h
-- outcome tracking), so a second table would just duplicate the schema and
-- both storage backends.
--
-- Nullable with no default and no backfill: every row written before this
-- migration was a revival, and null saying exactly that is cheaper and more
-- honest than rewriting history. Readers treat null as 'revival'.

alter table public.revival_alerts
  add column if not exists kind text
  check (kind is null or kind in ('revival', 'breakout'));

comment on column public.revival_alerts.kind is
  'Signal kind: revival (token died, went quiet, ignited) or breakout (consolidated quietly near highs, ignited). Null = revival (pre-breakout rows).';

-- Fire-time drawdown label: 1 - baseline/trailing-peak as the detector
-- measured it at the moment the alert fired. For a breakout this is THE
-- number that defines the signal (it sits in [breakout.minDrawdownFloor,
-- minDrawdownFromPeak)), and this table is the operator''s labeled-case set
-- for calibrating those knobs — the detector''s own docs say to move them
-- only with labeled cases in hand, which requires the label to be persisted,
-- not just printed to a console line at fire time.
--
-- Nullable: rows written before this migration never measured it, and a
-- revival can legitimately fire with an unknown drawdown (the gate's
-- missing-history abstention). Readers treat null as "not measured".

alter table public.revival_alerts
  add column if not exists drawdown_from_peak numeric;

comment on column public.revival_alerts.drawdown_from_peak is
  'Fire-time drawdown: 1 - baseline price / trailing peak price measured by the detector. Breakout rows: always known, in [breakout floor, revival threshold). Revival rows: >= threshold, or null (abstention). Null on pre-migration rows.';

-- After applying by hand, reload PostgREST''s schema cache:
--   NOTIFY pgrst, 'reload schema';

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

-- After applying by hand, reload PostgREST''s schema cache:
--   NOTIFY pgrst, 'reload schema';

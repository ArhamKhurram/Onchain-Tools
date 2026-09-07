-- Market-cap crossing state — add the per-token high-watermark.
--
-- APPLIED BY HAND, like the table it extends (20260905120000_mcap_cross_state).
-- The backend TOLERATES this column being absent: it detects the missing
-- column, warns ONCE, drops it from its reads and writes, and keeps the rest of
-- the crossing feature working — only the "re-cross suppression" that depends
-- on the watermark is disabled until this is applied. See
-- backend/src/mcapCross/state.ts (watermarkColumnMissing).
--
-- WHAT IT IS FOR. `last_seen_mcap` is the LAST reading; it falls when a token
-- pulls back, so it cannot tell "this token already ran to 3x and is bouncing
-- back through 750K" from "this token is crossing 750K for the first time".
-- The high-watermark is a strict running max, so a token we watched run well
-- above the target stays known to have run, and a later re-cross is suppressed
-- rather than re-alerted (backend/src/mcapCross/gates.ts isWatermarkReCross).
--
-- BACKFILL to last_seen_mcap: an existing row is at least as high as we last
-- saw it, which is the safe floor. NOT NULL with that default so every row has
-- a usable value the moment the column exists.
alter table public.mcap_cross_state
  add column if not exists high_watermark_mcap numeric not null default 0;

update public.mcap_cross_state
  set high_watermark_mcap = last_seen_mcap
  where high_watermark_mcap < last_seen_mcap;

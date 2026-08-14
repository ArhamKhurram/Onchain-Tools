-- Trade Journal — why an episode closed.
--
-- APPLIED BY HAND. The backend tolerates this migration being absent: the
-- position upsert detects the missing column, warns ONCE, and retries the
-- write with `close_reason` stripped (the contractsRepo global-first pattern —
-- see backend/src/storage/supabase/journalRepo.ts). Until it is applied,
-- abandoned auto-closes simply do not persist: the next rebuild re-opens the
-- bag, and nothing else in the journal changes.
--
--   'sold'      — the normal FIFO dust close (≤2% of acquired remains).
--                 Written on new/rebuilt closes only; existing rows keep NULL
--                 rather than being relabelled retroactively.
--   'abandoned' — auto-closed as a dead bag (no LP, or worth ~$0, untouched
--                 for OCT_JOURNAL_ABANDON_MIN_AGE_DAYS). Booked as a sale at
--                 ZERO proceeds, so the unrecovered cost lands in realized
--                 PnL. See backend/src/journal/abandoned.ts.
--
-- This column is the DURABLE record of an abandonment: the pairing engine
-- rebuilds episodes from trades alone and would otherwise re-open the bag on
-- the wallet's next trade.

alter table public.journal_positions
  add column if not exists close_reason text;

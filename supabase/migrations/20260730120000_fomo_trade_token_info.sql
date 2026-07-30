-- FOMO trades carried a token address and (sometimes) a symbol, but never a
-- name or market cap, so the live feed and replay history couldn't show what
-- was actually traded beyond a bare ticker. The enrichment pipeline that
-- already resolves this for contract calls (token catalog + GMGN/DexScreener)
-- now resolves it for FOMO trades too; these columns persist what it found at
-- dispatch time, matching the fdv_at_call / fdv_at_call_display pattern on
-- contracts (a snapshot of market cap when the trade happened, not a live
-- value that would drift on every read).

alter table public.fomo_trade_events
  add column if not exists token_name text,
  add column if not exists market_cap numeric,
  add column if not exists market_cap_display text;

-- Account-level sniper fee settings.
--
-- The Jito-style tip and the priority fee are properties of how the operator
-- bids for blockspace, not of any one rule, so they move from per-rule
-- `exec_params` onto the per-user `sniper_state` row (the same row that carries
-- the kill switch) and every rule inherits them.
--
-- PRECEDENCE, mirrored exactly in backend/src/sniper/fees.ts:
--     effective tip = exec_params->>'tip'  (when explicitly present)
--                     else sniper_state.fee_tip
--
-- BACKWARDS COMPATIBILITY. No rule row is rewritten by this migration, on
-- purpose: `exec_params.tip` already meant "explicitly set on this rule", so an
-- existing rule that carries one keeps it as an override and an existing rule
-- that does not now inherits a global that DEFAULTS TO ZERO. Both cases
-- therefore reserve exactly what they reserved yesterday until the operator
-- deliberately sets a global value.
--
-- NOT NULL DEFAULT 0 is load-bearing: a null fee would reach the reservation as
-- a NaN, and `NaN > cap` is false — the cap would turn off rather than tighten.
-- The CHECKs bound the value for the same reason the app does.

alter table public.sniper_state
  add column if not exists fee_tip numeric not null default 0,
  add column if not exists fee_priority_fee numeric not null default 0;

alter table public.sniper_state
  drop constraint if exists sniper_state_fee_tip_range;
alter table public.sniper_state
  add constraint sniper_state_fee_tip_range
  check (fee_tip >= 0 and fee_tip <= 1000);

alter table public.sniper_state
  drop constraint if exists sniper_state_fee_priority_fee_range;
alter table public.sniper_state
  add constraint sniper_state_fee_priority_fee_range
  check (fee_priority_fee >= 0 and fee_priority_fee <= 1000);

comment on column public.sniper_state.fee_tip is
  'Account-level Solana tip, native units. Inherited by every rule whose '
  'exec_params has no explicit "tip". Defaults to 0 so adding this column '
  'changes no existing reservation.';

comment on column public.sniper_state.fee_priority_fee is
  'Account-level Solana priority fee, native units. Same inherit/override '
  'semantics as fee_tip.';

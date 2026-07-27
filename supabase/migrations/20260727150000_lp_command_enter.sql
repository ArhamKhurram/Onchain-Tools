-- Add the `enter` (Zap In) manual action to the LP command queue.
--
-- Unlike compound/rebalance/exit, an enter opens a BRAND-NEW position, so it has
-- no token_id yet — it carries the pool, the input token + amount, and the range
-- strategy instead. Rather than a second table (and a second claim loop), the
-- existing queue is widened: token_id becomes nullable and four enter-only
-- columns are added, with a shape CHECK that keeps the two command kinds from
-- being confused. See LP_DASHBOARD_PLAN.md §5.

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_action_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_action_check
  check (action in ('compound', 'rebalance', 'exit', 'compound_rebalance', 'enter'));

-- The position does not exist yet for an enter. The existing numeric regex CHECK
-- on token_id passes on NULL, so only the NOT NULL needs dropping.
alter table public.lp_automation_commands
  alter column token_id drop not null;

-- Enter-only parameters.
alter table public.lp_automation_commands
  add column if not exists token_in_address text,
  add column if not exists amount_in text,
  add column if not exists range_strategy text,
  add column if not exists swap_slippage numeric;

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_token_in_address_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_token_in_address_check
  check (token_in_address is null or token_in_address ~ '^0x[0-9a-f]{40}$');

-- Base units, as a positive-integer decimal string. Never a float.
alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_amount_in_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_amount_in_check
  check (amount_in is null or amount_in ~ '^[1-9][0-9]*$');

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_range_strategy_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_range_strategy_check
  check (range_strategy is null or range_strategy in ('narrow', 'wide', 'full'));

-- Krystal expects a FRACTION: 0.005 is 0.5%. 0.05 (5%) is our ceiling.
alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_swap_slippage_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_swap_slippage_check
  check (swap_slippage is null or (swap_slippage > 0 and swap_slippage <= 0.05));

-- The two shapes, made mutually exclusive at the database:
--   * an existing-position action HAS a token_id and NONE of the enter params;
--   * an enter HAS the enter params and NO token_id.
alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_shape_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_shape_check
  check (
    (action = 'enter'
      and token_id is null
      and token_in_address is not null
      and amount_in is not null
      and range_strategy is not null)
    or
    (action <> 'enter'
      and token_id is not null
      and token_in_address is null
      and amount_in is null
      and range_strategy is null
      and swap_slippage is null)
  );

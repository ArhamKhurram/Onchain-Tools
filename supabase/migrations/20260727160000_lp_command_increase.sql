-- Add the `increase` (add liquidity) manual action to the LP command queue.
--
-- Like `enter`, increase zaps tokens in via Krystal `swap_and_increase`, but it
-- acts on an EXISTING position: the row carries token_id plus token_in + amount_in.
-- range_strategy stays null (the position's ticks are unchanged).

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_action_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_action_check
  check (action in ('compound', 'rebalance', 'exit', 'compound_rebalance', 'enter', 'increase'));

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
    (action = 'increase'
      and token_id is not null
      and token_in_address is not null
      and amount_in is not null
      and range_strategy is null)
    or
    (action not in ('enter', 'increase')
      and token_id is not null
      and token_in_address is null
      and amount_in is null
      and range_strategy is null
      and swap_slippage is null)
  );

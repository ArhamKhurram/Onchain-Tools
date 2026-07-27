-- Add the `decrease` (remove liquidity) manual action to the LP command queue.

alter table public.lp_automation_commands
  add column if not exists liquidity_percent numeric;

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_liquidity_percent_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_liquidity_percent_check
  check (liquidity_percent is null or (liquidity_percent > 0 and liquidity_percent <= 1));

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_action_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_action_check
  check (action in ('compound', 'rebalance', 'exit', 'compound_rebalance', 'enter', 'increase', 'decrease'));

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_shape_check;
alter table public.lp_automation_commands
  add constraint lp_automation_commands_shape_check
  check (
    (action = 'enter'
      and token_id is null
      and token_in_address is not null
      and amount_in is not null
      and range_strategy is not null
      and liquidity_percent is null)
    or
    (action = 'increase'
      and token_id is not null
      and token_in_address is not null
      and amount_in is not null
      and range_strategy is null
      and liquidity_percent is null)
    or
    (action = 'decrease'
      and token_id is not null
      and token_in_address is not null
      and range_strategy is null
      and (
        (liquidity_percent is not null and amount_in is null)
        or (liquidity_percent is null and amount_in is not null)
      ))
    or
    (action not in ('enter', 'increase', 'decrease')
      and token_id is not null
      and token_in_address is null
      and amount_in is null
      and range_strategy is null
      and swap_slippage is null
      and liquidity_percent is null)
  );

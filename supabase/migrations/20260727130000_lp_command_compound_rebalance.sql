-- Allow the compound_rebalance manual action on the LP command queue.

alter table public.lp_automation_commands
  drop constraint if exists lp_automation_commands_action_check;

alter table public.lp_automation_commands
  add constraint lp_automation_commands_action_check
  check (action in ('compound', 'rebalance', 'exit', 'compound_rebalance'));

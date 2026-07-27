-- Multi-Safe support for the LP dashboard (v1: up to 2 addresses per user).
alter table public.lp_automation_settings
  add column safe_addresses text[] not null default '{}',
  add column active_safe_address text
    check (active_safe_address is null or active_safe_address ~ '^0x[0-9a-f]{40}$');
update public.lp_automation_settings
set safe_addresses = case when safe_address is not null then array[safe_address] else '{}' end,
    active_safe_address = safe_address
where cardinality(safe_addresses) = 0;
alter table public.lp_automation_settings
  add constraint lp_safe_addresses_max check (cardinality(safe_addresses) <= 2),
  add constraint lp_active_safe_in_list check (
    active_safe_address is null or active_safe_address = any (safe_addresses)
  );

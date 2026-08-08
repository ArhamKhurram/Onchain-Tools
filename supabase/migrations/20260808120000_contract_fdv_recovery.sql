-- Recovering fdv_at_call (MC@CALL) for rows the live pipeline never filled.
--
-- fdv_at_call feeds the Radar multiplier and caller quality scoring, so a
-- recovered value must never be readable as a measured one. The value column
-- carries no provenance of its own, so it gets one here: NULL provenance means
-- the live enrichment pipeline wrote the number at call time; non-NULL names the
-- tier that reconstructed it.
--
-- Deliberately NOT an extension of `enrichment_source`. That column is a closed
-- union ('rick' | 'dexscreener' | 'gmgn' -- packages/shared/src/types.ts,
-- backend/src/utils/enrichmentMerge.ts) that already drives merge BEHAVIOUR
-- (mergeEnrichmentPatch rules 1 and 2; the frontend's rickWins), and it records
-- where the row's METADATA came from, which recovery does not touch. Two
-- different facts, two columns.

alter table public.contracts
  add column if not exists fdv_at_call_provenance text,
  add column if not exists fdv_at_call_recovered_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'contracts_fdv_provenance_values_chk') then
    alter table public.contracts
      add constraint contracts_fdv_provenance_values_chk
      check (
        fdv_at_call_provenance is null
        or fdv_at_call_provenance in ('catalog_exact', 'sibling_measured', 'birdeye_derived')
      );
  end if;

  -- A provenance with no value, or a recovered value with no provenance, is
  -- exactly the ambiguity this column exists to prevent. Enforce the pairing in
  -- the database rather than trusting the script to remember.
  if not exists (select 1 from pg_constraint
                 where conname = 'contracts_fdv_provenance_paired_chk') then
    alter table public.contracts
      add constraint contracts_fdv_provenance_paired_chk
      check (
        (fdv_at_call_provenance is null and fdv_at_call_recovered_at is null)
        or (fdv_at_call_provenance is not null
            and fdv_at_call_recovered_at is not null
            and fdv_at_call is not null)
      );
  end if;
end $$;

-- Partial: the vast majority of rows are measured (NULL) and never queried by
-- provenance. Only the recovered minority needs to be findable.
create index if not exists idx_contracts_fdv_provenance
  on public.contracts (fdv_at_call_provenance)
  where fdv_at_call_provenance is not null;

-- Audit + resumability + revert. The backfill script is the only writer. Every
-- committed write lands here with the inputs it was derived from, so a bad run
-- is reversible by run_id without guessing which rows it touched.
create table if not exists public.contract_fdv_recovery_log (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  address text not null,
  tier text not null,
  fdv_written numeric not null,
  inputs jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_fdv_recovery_log_run
  on public.contract_fdv_recovery_log (run_id);

-- One recovery per contract row, ever. Makes a re-run idempotent at the
-- database level instead of relying on the script's checkpoint file.
create unique index if not exists idx_fdv_recovery_log_contract
  on public.contract_fdv_recovery_log (contract_id);

-- Service role only, same posture as token_peaks: RLS on, no policies. Nothing
-- user-facing reads this table; the backfill runs with the service key.
alter table public.contract_fdv_recovery_log enable row level security;

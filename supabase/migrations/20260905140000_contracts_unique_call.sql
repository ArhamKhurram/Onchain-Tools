-- One call = one row: a unique index over the key that identifies a call.
--
-- NOT APPLIED. This migration is the durable half of the duplicate-row fix and
-- it CANNOT be applied to prod as-is: the table already holds duplicate groups
-- (43% of all contract rows in a measured 24h window, 97% of Telegram rows),
-- and CREATE UNIQUE INDEX fails while any of them exist.
--
-- The application-level guard in ContractsRepo.logContract / ContractLog
-- .logContract stops NEW duplicates on its own and does not require this index.
-- The index only closes the remaining race: two re-deliveries of the same call
-- in flight at the same moment, where both guards read "not present" before
-- either insert lands. `logContract` already treats 23505 on this key as a
-- benign duplicate, so applying the index later is a no-op for correctness and
-- a strict improvement in guarantees.
--
-- APPLYING THIS SAFELY (owner's call, both projects — dev zcvubfadvdwjxgodznxh
-- and prod vmlxyqzjdaegkfylxfka):
--
--   1. Deploy the application guard first and let it run. From that moment no
--      new duplicate group can form, so the set of offenders is finite and
--      stops growing.
--   2. Decide what happens to the EXISTING duplicate rows. Deliberately not
--      done here — historical cleanup changes what every caller statistic has
--      historically been computed over, which is a product decision, not a
--      migration. Count them first:
--
--        select count(*) - count(distinct (user_id, message_id, chain,
--                 case when chain = 'evm' then lower(address) else address end))
--          from public.contracts;
--
--      Whatever the decision (collapse each group to its earliest row, keep
--      them and index non-uniquely instead, or archive first), it must land
--      before step 3.
--
--      DECIDED: collapse each group to its earliest row. `scripts/
--      dedupe-contracts.mjs` is the tool that does it — dry run by default,
--      full-row NDJSON backup before the first delete, a hard abort if any
--      group spans more than one channel_id, and a survivor merge that lifts
--      any field the earliest row lacks off a later sibling (fdv_at_call above
--      all, or the collapse would undo #367).
--   3. Only then run this file. The preflight below refuses to proceed with a
--      clear message rather than failing on an opaque index error.
--
-- The key is chain-aware for the same reason every address comparison in
-- ContractsRepo is: EVM addresses are case-insensitive hex whose stored rows
-- predate canonicalisation, while Solana mints are case-SENSITIVE base58 and
-- must not be folded. (Measured: zero production duplicate groups actually
-- differ in raw address casing, so this matches the app's matching rules rather
-- than changing them.)

do $$
declare
  dupes bigint;
begin
  select count(*) - count(distinct (
           user_id,
           message_id,
           chain,
           case when chain = 'evm' then lower(address) else address end
         ))
    into dupes
    from public.contracts;

  if dupes > 0 then
    raise exception
      'contracts still holds % duplicate call row(s); resolve them before creating contracts_one_row_per_call (see the header of this migration)',
      dupes;
  end if;
end
$$;

create unique index if not exists contracts_one_row_per_call
  on public.contracts (
    user_id,
    message_id,
    chain,
    (case when chain = 'evm' then lower(address) else address end)
  );

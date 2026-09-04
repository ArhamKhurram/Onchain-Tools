-- Admit Robinhood Chain (chainId 4663) to the sniper schema.
--
-- Adds three values to the enumerations the sniper tables constrain:
--
--   chain      'rhc'           Robinhood Chain, an Arbitrum Orbit L3
--   venue      'evm_uniswap'   Uniswap V3/V4 via backend/src/sniper/executors/evmUniswap.ts
--   unit       'ETH'           its native currency
--
-- WHY A MIGRATION AT ALL, given the EVM trigger is local-mode only: the CHECK
-- constraints in 20260807120000 exist precisely so local and hosted refuse the
-- same rows (see the header of backend/src/sniper/validateRule.ts). Leaving
-- them behind the TypeScript union would recreate the divergence they were
-- written to prevent — local would accept an `rhc` wallet and hosted would
-- reject it as a raw Postgres error rendered to the operator.
--
-- Every constraint here is REPLACED, not loosened in place, so the new
-- agreement rules (venue<->chain, unit<->chain, exec-kind<->chain) stay
-- exhaustive rather than accumulating exceptions. Nothing widens for the
-- existing venues: a `slotshark` row is constrained exactly as before.

-- ---------------------------------------------------------------------------
-- sniper_wallets
-- ---------------------------------------------------------------------------

alter table public.sniper_wallets
  drop constraint if exists sniper_wallets_chain_check,
  drop constraint if exists sniper_wallets_venue_check,
  drop constraint if exists sniper_wallets_unit_check,
  drop constraint if exists sniper_wallets_address_check,
  drop constraint if exists sniper_wallets_venue_supports_chain,
  drop constraint if exists sniper_wallets_unit_matches_chain;

alter table public.sniper_wallets
  add constraint sniper_wallets_chain_check check (chain in ('sol', 'bsc', 'rhc')),
  add constraint sniper_wallets_venue_check check (venue in ('slotshark', 'evm_uniswap')),
  add constraint sniper_wallets_unit_check check (unit in ('SOL', 'BNB', 'USDC', 'ETH')),

  -- The Solana branch is unchanged and still case-SENSITIVE: base58 lowercased
  -- is a different, still-plausible address, which is a silent way to send
  -- funds nowhere.
  --
  -- The EVM branch is deliberately permissive about emptiness. An `evm_uniswap`
  -- wallet row exists to carry a BUDGET, not a destination: the executor
  -- derives its address from the signing key at fire time and nothing is ever
  -- sent to the value in this column. An operator who has not yet declared
  -- SNIPER_EVM_WALLET_ADDRESS must still get a budget row, so '' is allowed —
  -- and because the column routes no funds, allowing it costs nothing.
  add constraint sniper_wallets_address_check check (
    (venue = 'evm_uniswap' and (address = '' or address ~ '^0x[0-9a-fA-F]{40}$'))
    or (venue <> 'evm_uniswap' and address ~ '^[1-9A-HJ-NP-Za-km-z]{32,48}$')
  ),

  add constraint sniper_wallets_venue_supports_chain check (
    (venue <> 'slotshark' or chain = 'sol')
    and (venue <> 'evm_uniswap' or chain = 'rhc')
  ),

  -- Caps are denominated in native units to keep a price oracle out of the hot
  -- path. That only works if a wallet's unit is one its chain can hold.
  add constraint sniper_wallets_unit_matches_chain check (
    (chain = 'sol' and unit in ('SOL', 'USDC')) or
    (chain = 'bsc' and unit in ('BNB', 'USDC')) or
    (chain = 'rhc' and unit = 'ETH')
  );

-- ---------------------------------------------------------------------------
-- sniper_rules
-- ---------------------------------------------------------------------------

alter table public.sniper_rules
  drop constraint if exists sniper_rules_chain_check,
  drop constraint if exists sniper_rules_venue_check,
  drop constraint if exists sniper_rules_size_unit_check,
  drop constraint if exists sniper_rules_venue_supports_chain,
  drop constraint if exists sniper_rules_exec_kind_matches_chain;

alter table public.sniper_rules
  add constraint sniper_rules_chain_check check (chain in ('sol', 'bsc', 'rhc')),
  add constraint sniper_rules_venue_check check (venue in ('slotshark', 'dryrun', 'evm_uniswap')),
  add constraint sniper_rules_size_unit_check check (size_unit in ('SOL', 'BNB', 'USDC', 'ETH')),

  add constraint sniper_rules_venue_supports_chain check (
    (venue <> 'slotshark' or chain = 'sol')
    and (venue <> 'evm_uniswap' or chain = 'rhc')
  ),

  -- exec_params is the chain-tagged union from backend/src/sniper/types.ts. The
  -- tag must agree with the rule's chain, or a sol rule carries wei-valued gas
  -- fields and estimateFees silently stops adding tip/priorityFee to the
  -- reservation -- which makes the daily cap soft.
  add constraint sniper_rules_exec_kind_matches_chain check (
    (chain = 'sol' and exec_params ->> 'kind' = 'sol') or
    (chain = 'bsc' and exec_params ->> 'kind' = 'evm') or
    (chain = 'rhc' and exec_params ->> 'kind' = 'evm')
  );

-- ---------------------------------------------------------------------------
-- sniper_budget  (the table the daily cap actually lives on)
-- ---------------------------------------------------------------------------

alter table public.sniper_budget
  drop constraint if exists sniper_budget_chain_check,
  drop constraint if exists sniper_budget_unit_check;

alter table public.sniper_budget
  add constraint sniper_budget_chain_check check (chain in ('sol', 'bsc', 'rhc')),
  add constraint sniper_budget_unit_check check (unit in ('SOL', 'BNB', 'USDC', 'ETH'));

-- ---------------------------------------------------------------------------
-- sniper_fires  (the money log)
-- ---------------------------------------------------------------------------

alter table public.sniper_fires
  drop constraint if exists sniper_fires_venue_check;

alter table public.sniper_fires
  add constraint sniper_fires_venue_check check (venue in ('slotshark', 'dryrun', 'evm_uniswap'));

-- ---------------------------------------------------------------------------
-- sniper_venue_credentials  (deliberately NOT extended)
-- ---------------------------------------------------------------------------
--
-- `evm_uniswap` is absent from that table's `venue` constraint on purpose, and
-- it stays absent. Its credential is a SIGNING KEY read from the process
-- environment inside the executor's call frame -- never written to Vault, never
-- read by the service-role RPC, never returned by any endpoint. Adding it here
-- would create a place for a private key to be stored, which is the one thing
-- the design is arranged to prevent. See backend/src/sniper/venueCredentials.ts,
-- where the same exclusion is enforced by the TypeScript key type.

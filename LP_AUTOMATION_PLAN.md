# LP_AUTOMATION_PLAN.md — Autonomous LP Position Manager

Design + build spec for the DeFi LP automation system. **Phase 1 build in progress**
in the `lp-automation/` workspace.
Source spec: `defi-lp-automation-build-spec.md` (user-provided). This doc adapts it
to concrete, verified infrastructure. Rewritten clean after three planning sessions
on 2026-07-26 — §1 explains the back-and-forth on chain choice so the reasoning
isn't lost; §4 likewise records why the originally-planned Guard was replaced by a
Module. Every other section reflects the current, final state only.

Decisions locked:
- **Chain (Phase 1): Robinhood Chain.** The original pick, confirmed workable
  through Krystal's API by direct testing (§1). ~4 weeks old as of this doc —
  thinner liquidity and more memecoin-heavy volume than an established chain, which
  is why the policy's pool-selection criteria and manual allowlisting (§5, §9.2)
  carry real weight here, not just as a formality.
- **Calldata + data via Krystal's public API**, not a hand-built Uniswap V3 SDK
  integration (§1, §3). Krystal only ever returns transaction calldata — it never
  signs or holds custody.
- **Live signing from day one** — no simulation-only staging phase. The security
  model in the source spec's §8/§9 (simulation-before-broadcast, allowlists, spend
  caps) is built in from the first line regardless; "live" only means the signer
  is real, not that any safety rail is deferred.
- **Same monorepo**, but **own workspace/process** — not in-process with the public
  backend like the Discord bot. This component holds a real signing key over real
  funds; the backend handles arbitrary Discord/Telegram input and public HTTP
  traffic. Process isolation means a bug in unrelated ingestion code can't reach
  the signer. Mirrors `fomo-worker`'s precedent (separate service in the monorepo).
- **Hosting:** the existing Railway project `ponslive-worker`
  (`69adbee1-6b92-40ca-a586-a95db13add69`) — user is deleting the old `sync-worker`
  service themselves; a new service gets created there once `lp-automation/` has
  code to deploy. No public networking needed (outbound-only process).

---

## 1. Chain & calldata approach — the full reasoning (three sessions, condensed)

**Session 1** picked Robinhood Chain (very new, Uniswap V3 native there, ~99.5% of
its DEX volume) and planned to hand-build calldata against Uniswap's raw SDK, since
no chain-specific aggregator/zap API was confirmed for that chain yet.

**Session 2:** hand-building zap/compound/rebalance calldata felt like too much for
a first build. Checked whether an existing product could supply calldata directly
instead — **Krystal (built by the Kyber team) has exactly this**, verified against
their OpenAPI spec (`https://api-docs.krystal.app/docs/doc.json`):

- **`lp-txn` endpoint group** — `compound`, `adjust_range` (rebalance),
  `swap_and_mint` (zap in), `swap_and_increase`, `withdraw_and_swap` (zap out). Each
  endpoint's own description confirms the contract: *"Return the txdata for make
  txn compound fee back to position."* **Krystal only builds calldata — it never
  signs or holds custody.** Exactly the "calldata builder" role from the source
  spec's §5.3, and it already solves the nontrivial zap-sizing math (optimal swap
  ratio) that hand-building would have required us to get right ourselves.
- **No API key** — `securitySchemes`/`security` are both `null` in their spec. Same
  public endpoints their own web app calls from the browser. Real usage will
  eventually hit *some* rate limit (normal, not a paywall) — watch for 429s once
  building, don't assume unlimited volume.
- **`Liquidity Lens` endpoints** (`lp/stats`, `pool/list`, `lp_explorer/top_pools`,
  `market/overview`) solve most of the source spec's §5.2 data-ingestion problem
  too — pool APR/TVL/volume/fee data without building our own Multicall/event-log
  reader.
- At the time, Krystal's **published, marketing-facing chain list** (krystal.app:
  Ethereum, Optimism, BNB, Polygon, HyperEVM, Base, Arbitrum, Avalanche) did not
  include Robinhood Chain — so session 2 moved the chain target to **Base** rather
  than block on an unconfirmed gap.

**Session 3 — the Robinhood Chain gap closed.** A Krystal team member stated in
their Discord that Robinhood Chain support already exists ahead of their published
docs. Rather than take that on faith, verified it directly against the **live** API
(not docs, not chat):

1. `GET /all/v1/chains/endpoints` — a real-time route table — **already lists chain
   id `4663`** (Robinhood Chain) today.
2. `GET /all/v1/pool/list?chainId=X`, tested against both chains directly: Base
   (`8453`) and Robinhood Chain (`4663`) return the **exact same** structured
   validation error (`"Field validation for 'Token' failed on the 'required'
   tag"`) — meaning both pass Krystal's chain-level recognition identically and
   fail only on an unrelated missing parameter.
   (A separate, earlier test against `lp_explorer/top_pools` had looked like a
   Robinhood-specific "not supported" result — but that same endpoint returned the
   identical error for Base too, so it was never a real signal; likely a quirk of
   that one endpoint, not a chain-support gap.)

With the original blocker gone, chain choice reopened — and Robinhood Chain (the
original pick) was chosen over staying on Base.

**Deliberately NOT using Krystal's `LP Automator` order system** (`createOrder`,
`ORDER_TYPE_REBALANCE`/`ORDER_TYPE_RANGE_ORDER`) — that's Krystal's own fully
turnkey automation, where *their* backend runs the loop and decides triggers. Using
it would mean inheriting their trigger logic instead of the source spec's custom
net-efficiency-score + switching-buffer rules (§6) — the entire reason to build
this rather than just use Krystal's existing app directly. We use `lp-txn` for
calldata only; the rule evaluator, policy engine, and signer stay ours.

**What none of this changes:** the security architecture (§4). Krystal never signs
or touches funds regardless of which chain — we still dry-run every transaction
ourselves and sign/broadcast through our own Safe + module, with the same allowlist
and spend caps. Chain choice and calldata source are both orthogonal to the trust
boundary.

**Still not fully solved by Krystal, on any chain:** their API looks REST/poll-based,
not a push/streaming feed. The source spec's G1 (sub-second reaction) still needs
our own low-latency layer for anything genuinely time-sensitive (e.g., price
exiting a range) — likely a direct RPC `eth_subscribe` watch on the pool contracts,
with Krystal's API used for the slower-moving stuff (fee accrual, TVL, pool
discovery). Don't assume polling Krystal's REST API alone delivers the reaction
speed the spec wants.

---

## 2. Architecture

Same two-speed split as the source spec (§4), unchanged:

- **Design time (slow):** policy profile authored/tuned with LLM help, versioned,
  stored. New positions inherit the current default with zero setup (source §5.1).
- **Runtime (fast, no LLM in the loop):** stream watcher → rule evaluator (plain
  code) → calldata builder (Krystal `lp-txn`) → pre-authorized signer → broadcast.
  LLM only appears again in the slow, event-triggered supervisory pass (§8).

### Workspace layout

```
lp-automation/                  # new npm workspace, own package.json, own deploy
  src/
    policy/                     # §5 — profile schema, versioning, inheritance
    ingest/                     # §3 — Krystal Liquidity Lens + our own RPC watch
    calldata/                   # §3 — Krystal lp-txn wrapper, dry-run/simulate
    rules/                      # §6 — efficiency scoring + switching buffer
    signer/                     # §4 — Safe + automation module client
    lifecycle/                  # §7 — enter/compound/rebalance/exit orchestration
    audit/                      # append-only action log (source §9 acceptance criteria)
  contracts/                    # OctAutomationModule (Solidity) + tests (Foundry)
  scripts/                      # deploy Safe, deploy + enable module, seed policy
```

Deployed as its own service (Railway project `ponslive-worker`, see decisions above)
— no public networking, outbound calls only (Krystal API + chain RPC).

---

## 3. Data ingestion & calldata (§5.2/§5.3, adapted for Krystal)

**Everything below was verified against the live API on 2026-07-26** while building
`lp-automation/src/ingest/krystal/`. Several assumptions from the planning sessions
turned out to be wrong; they are corrected here rather than deleted, so nobody
re-derives them later. Raw captured responses backing every claim were kept
alongside the build.

- **`platform` = `uniswapv3`** — RESOLVED (was §11 item 3). Plain string, no
  chain-specific suffix, identical to every other Krystal chain. Confirmed four
  ways: `GET /all/v1/strategies/supportedProtocols` and `GET /all/v1/lp_explorer/configs`
  both list it under chain 4663; negative controls on the lp-txn endpoints prove
  validation is on the *(chain, platform)* pair, not a global name list
  (`aerodromecl` — valid on Base — is rejected for 4663, and `uniswapv3` is
  rejected for a nonexistent chain); and decisively,
  `lp_transaction/swap_and_mint` returned **HTTP 200 with real executable
  calldata** against a real 4663 pool. All five lp-txn endpoints return 200.
  Full evidence is in the header comment of
  [`src/ingest/krystal/platform.ts`](lp-automation/src/ingest/krystal/platform.ts).

- **Pool discovery — the v1 endpoints named in earlier sessions are dead.**
  Not a Robinhood problem; they fail identically on **chain 1, 8453 and 4663**:
  - `GET /all/v1/pool/list` → **HTTP 500**
  - `GET /all/v1/lp_explorer/top_pools`, `/pool_detail`, `/pool_chart` → **HTTP 400**
    `"chain id N not supported"`

  (This also finally explains the confusing `top_pools` result recorded in §1 —
  it was never a chain-support signal.) `market/overview` was not exercised;
  don't assume it works either.

  The working replacement is the **undocumented v2 route**
  `GET /all/v2/lp_explorer/top_pools?chainId=4663` — 1107 pools on Robinhood
  Chain (1039 uniswapv3, 57 uniswapv4, 11 uniswapv2).

  **Treat the v1-vs-v2 discrepancy as a supply-chain risk.** The only working
  pool-discovery route is absent from Krystal's published OpenAPI spec: it is
  *observed, not contracted*. Nothing obliges them to keep it, and there is no
  documented alternative to fall back to — the documented ones are the broken
  ones. Keep the mappers defensive, and treat a discovery failure as "surface no
  new candidates" (safe) rather than anything that could stall an open position.

- **Position state:** `GET /all/v1/lp/userPositions` **does** work. `status` ∈
  `IN_RANGE|OUT_RANGE|CLOSED`. Its embedded `pool` object uses a *different* shape
  from the pool-discovery endpoint and carries **no 24h volume**; missing fields
  are surfaced on an `incomplete` list rather than silently defaulted to `0`.

- **Krystal returns NO tick data at all** — no `tickLower`, no `tickUpper`, no
  `currentTick`, on any endpoint sampled. This is the single most consequential
  finding of the build:
  - Range **bounds** are exactly recoverable from its `minPrice`/`maxPrice` via
    `tick = log₁.₀₀₀₁(price · 10^(d₁−d₀))` — verified against on-chain
    `NonfungiblePositionManager.positions()` for five real positions including
    unequal token decimals (both 18/6 and 6/18 orderings). Exact every time.
  - The **current** tick is *not*. Deriving it from Krystal's `pool.price` came
    out **off by up to 66 ticks** versus the pool's own `slot0()`.

  **This makes the low-latency RPC watch layer mandatory, not optional.** The
  range-exit trigger — the whole reason the fast path exists — cannot be served by
  Krystal at any polling frequency, because the input it needs is not merely stale
  there, it is wrong. `currentTick` is therefore a **required** input from the RPC
  layer, and positions lacking one are skipped rather than backfilled from
  Krystal. A hard seam between the two data sources, not a preference.

- **Low-latency triggers (ours):** direct RPC `eth_subscribe` on the pools we hold
  positions in — see `src/ingest/rpc/`. Robinhood's docs name Alchemy and
  QuickNode as providers; both have free tiers.

- **Calldata:** `lp_transaction/{compound,adjust_range,swap_and_mint,
  swap_and_increase,withdraw_and_swap}`. Dry-run via `eth_call` before the signer
  ever sees it. Two live quirks worth knowing:
  - **Two destination addresses, not one** — v3utils (`0xb4acbc08…`) for
    mint/increase, NonfungiblePositionManager (`0x73991a25…`) for
    compound/adjust/withdraw via `safeTransferFrom`. Both must be allowlisted in
    the module, with their respective selectors.
  - `value` comes back as `""` (empty string) on some endpoints and `"0x0"` on
    others. `BigInt('')` throws and `Number('')` is `0` — handled explicitly.

- **Cloudflare WAF tripwire — an operational hazard, not a rate limit.**
  Cloudflare sits in front of `api.krystal.app` and returns a **403 HTML block
  page** for *any* request whose query string contains the all-zero address
  `0x0000000000000000000000000000000000000000`. Confirmed by bisection: appending
  `?x=0x0000…0000` to an otherwise-working endpoint flips 200 → 403.

  This bites on the `platformWallet` parameter, where passing the zero address is
  the natural way to decline referral attribution — i.e. the failure mode is
  reached by doing the obvious thing. It also fails as *HTML*, not JSON, so a
  naive client reports a parse error rather than the real cause. Guarded by
  `assertNoWafTripwire` in
  [`src/ingest/krystal/client.ts`](lp-automation/src/ingest/krystal/client.ts).

- **Slippage is a fraction, not bps and not percent.** Krystal rejects values ≥ 1
  with `"slippage must be < 100 percent"`, which means `0.5` is silently accepted
  as *fifty percent*. A bps-shaped value would be a catastrophic misread, so
  `slippageFraction()` caps at 0.05 and rejects bps-style inputs outright.

- **Rate limits: none observed.** 40 concurrent + 30 sequential requests all
  returned 200, with no `X-RateLimit-*` or `Retry-After` headers. 429 handling is
  implemented anyway and surfaces as a distinct error type rather than being
  retried away silently.

---

## 4. Pre-authorized signer (§5.5, §8 — the actual safety boundary)

**Safe (Gnosis Safe) + a custom Safe *Module*** (`OctAutomationModule`), not a
vendor's ERC-4337 session-key service, and **not a Guard** — see the correction
below. Reasoning:

- Safe is free, open-source, self-custodied, deployable for gas cost only — no
  bundler/paymaster SaaS dependency that could rate-limit or monetize later.

### Why a Module, not a Guard (correction to sessions 1–3)

Earlier sessions specified "Safe + Guard, hot key is an owner, threshold >1 for
admin changes". **That construction doesn't hold together**, and the flaw is worth
recording so it isn't reintroduced:

- A Safe has *one* threshold. For the automation to sign day-to-day trades alone
  (§9 point 3 — no human in the loop), the threshold must be 1.
- With threshold 1, that same hot key can execute *any* Safe transaction —
  including `setGuard(address(0))`, removing its own restrictions. The Guard is
  self-disabling by the very key it exists to constrain.
- A Guard can block `to == safe` to prevent that, but then it also blocks the
  owner's legitimate bound changes. There's no threshold setting that gives
  "automation acts alone, but cannot widen its own limits".

A **Module** resolves it cleanly, because modules are a separate authority path
from owner signatures:

- The automation hot key is **not a Safe owner at all**. It is an *operator* on the
  module, and calls `execute(to, value, data)` on the module.
- The module validates, then forwards via `execTransactionFromModule` — no owner
  signature involved, so day-to-day automation runs with zero human interaction.
- Every admin function on the module (allowlist, caps, operator set, pause) is
  gated on `msg.sender == safe`, meaning it can *only* be reached through an
  owner-signed Safe transaction — your offline key (§9 point 3).
- Enabling/disabling the module is itself an owner-only Safe operation, so the
  offline key keeps an unconditional kill switch.

This is what makes "no component may expand its own permissions at runtime"
(source §8) a genuinely enforced on-chain property rather than a promise the
off-chain code makes to itself.

### The Robinhood Chain allowlist — concrete values

**The allowlist needs TWO destinations, not one**, because Krystal routes through
two different flows. Both, with their selectors, must be seeded by owner-signed
transactions before the operator can do anything. Every value below was read off
the `to`/`data` of real HTTP 200 lp-txn responses on 2026-07-26 (chain 4663):

| Destination | Address | Selector | Used by |
| --- | --- | --- | --- |
| Krystal v3utils helper | `0xb4acbc082b5e7ded571c98ee4257778a9d784b36` | `0x954543e6` | `swap_and_mint` |
| ″ | ″ | `0x3dce3e25` | `swap_and_increase` |
| Uniswap V3 `NonfungiblePositionManager` | `0x73991a25c818bf1f1128deaab1492d45638de0d3` | `0xb88d4fde` (`safeTransferFrom`) | `compound`, `adjust_range`, `withdraw_and_swap` |

Note the asymmetry: the compound/adjust/withdraw flows all arrive as
`safeTransferFrom` on the position NFT — **one selector covering three distinct
operations**. The selector allowlist therefore cannot distinguish between them;
that distinction exists only in the calldata arguments, which is precisely the
residual risk called out in §11 item 5. Allowlisting `0xb88d4fde` authorizes all
three at once.

Reference addresses for the same chain, recorded so they aren't re-derived:

- Uniswap V3 factory — `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`
- WETH — `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`

Neither belongs on the module allowlist; they are for pool verification and token
identification only.

### What the module enforces

- Destination allowlist (the two contracts above — nothing else).
- **Per-destination function-selector allowlist** — an address-only allowlist is too
  coarse when the target is a router exposing many functions.
- Per-transaction value cap.
- Rolling daily cumulative spend cap, tracked in the module's own storage.
- CALL only — never DELEGATECALL.
- Operator path cannot target the Safe or the module itself, so it can never
  self-administer even if an allowlist entry is added by mistake.
- Owner-controlled pause switch.

Off-chain dry-run remains a separate, necessary layer even with Krystal supplying
calldata: the module stops the wrong destination/amount even if the off-chain code
is compromised, but only simulation catches a transaction that would revert.

**Genuine smart-contract development with real audit risk.** Foundry is not
installed locally, so the module's tests run only in CI (`.github/workflows/ci.yml`,
`contracts` job) — that job is the sole automated verification and must be treated
as blocking. Have this independently reviewed before it holds meaningful funds.

**Operational requirement, not a config value:** the automation hot key must be a
**freshly generated wallet holding only the capital you intend to risk** — never a
reused wallet with unrelated funds.

---

## 5. Policy engine — schema (dashboard-configured, §9 point 1)

Edited through a Settings page in the OCT frontend (mirrors the existing
Pushover/missed-runner config UX), stored as a row the signer process only ever
*reads* — never writes.

```ts
interface AutomationPolicy {
  version: number;
  chain: 'robinhood';                 // Phase 1; extend later per source §11 Phase 3
  maxPositionSizeUsd: number;
  allowedPools: string[];             // explicit pool addresses, manually chosen (§9.2)
  poolSelectionCriteria: {            // used to SURFACE candidates for manual pick,
    minTvlUsd: number;                // not to auto-admit them
    min24hVolumeUsd: number;
    maxIlRiskScore: number;           // scoring model TBD — start conservative
  };
  compoundTrigger: {
    minFeesVsGasRatio: number;        // e.g. 2.0 = compound when fees > 2x gas cost
    maxIntervalHours: number;         // e.g. 6 — whichever fires first
  };
  rebalanceTrigger: {
    rangeExitPercent: number;         // e.g. rebalance when price exits range by X%
  };
  switchingBuffer: {
    minEfficiencyDeltaPercent: number;
    sustainedDurationMinutes: number; // both required — no momentary-crossover moves
  };
  dailySpendCapUsd: number;           // mirrored on-chain in the module — not just here
}
```

Versioned; changing the default does **not** retroactively touch open positions
unless explicitly told to apply-to-all (source §5.1). New positions inherit the
current default with zero setup.

---

## 6. Rule evaluator (§5.4) — source formula, dimensionally corrected

The source spec states:

```
net_efficiency = fee_apr − estimated_IL − (gas_cost + slippage_cost) / expected_holding_period
```

**As written this doesn't typecheck dimensionally**, and it was corrected during the
build (`src/rules/efficiency.ts`). Two problems:

1. `fee_apr` and `estimated_IL` are annualized *fractions*; the cost term is
   *dollars per day*. Subtracting one from the other is meaningless.
2. The cost term ignores position size — $10 of gas would score a $200 position
   identically to a $200,000 one.

Corrected, with both fixes:

```
costDrag       = (gasCostUsd + slippageCostUsd) / positionValueUsd   # → fraction of capital
                 × (365 / expectedHoldingPeriodDays)                 # → annualized
net_efficiency = feeApr − estimatedIlApr − costDrag
```

Sanity check: $10 on a $1,000 position held 30 days → `(10/1000) × (365/30)` =
0.1217, i.e. a 12.17%/yr drag. Paying 1% every 30 days does cost ~12.2%/yr.
Linear, not compounded — the number exists to be compared across pools, and
staying linear keeps that comparison legible in the audit log.

The annualization is what makes short holds self-punishing (the same $10 over one
day reads as a 365% drag), which is the arithmetic half of the switching buffer's
job.

Degenerate inputs (zero/negative position value or holding period, non-finite
values, negative costs) return a **finite** sentinel rather than `Infinity` —
`JSON.stringify(Infinity)` is `null`, which would silently hole the audit log at
precisely the moment something had gone wrong.

Computed continuously for every open position and every candidate pool matching
policy criteria. **Switching buffer** (both a threshold *and* a sustained-duration
requirement) gates any exit-and-move — this is what the acceptance criteria's
"transient one-tick advantage must NOT trigger a move" test case verifies. Log the
score and its inputs at every evaluation tick, not just at trigger time.

---

## 7. Lifecycle actions (§5.6) — backed by Krystal's `lp-txn` API

Enter / compound / rebalance / exit, each built from the matching Krystal
`lp_transaction/*` call (§3), dry-run via `staticCall` before every broadcast,
submitted through the Safe (§4).

---

## 8. Supervisory audit layer (P1, event-triggered — §9 points 4–5)

- **Trigger: event-based, not clock-polled.** Runs right after an autonomous
  transaction fires (rebalance/compound/exit), plus one cheap daily backstop sweep
  — not a fixed 15–60 min loop. A clock-polled LLM call running forever is a real,
  non-trivial recurring cost (~$30–70/mo+ at that cadence) — the one part of this
  system that isn't free. Event-triggering gets the same coverage for an order of
  magnitude fewer calls, since "nothing happened" ticks are exactly the ones that
  don't need reviewing.
- **Authority: pause/flag-only, not force-exit.** Can block new position entries
  and flag something for manual review; never pulls an existing position on its
  own judgment. Revisit force-exit once the pause/flag version has a track record.
- Not blocking Phase 1.

---

## 9. Decision log (all three sessions, 2026-07-26)

1. **Policy is dashboard-configured** (§5) — signer process never accepts writes,
   has no inbound internet-facing surface at all.
2. **Pool allowlist:** Krystal's pool-discovery endpoints surface candidates
   matching policy criteria; **you manually pick which ones go on the allowlist**
   via dashboard checkboxes — Krystal never auto-admits a pool.
3. **The Safe owner key is a second wallet you hold** (e.g. your existing Rabby
   wallet), used only to authorize changes to the module's bounds (raising the
   spend cap, adding an allowed contract) — never for day-to-day trades. Regular
   lifecycle actions are signed solely by the automation hot key with zero human
   interaction, exactly like Rabby not prompting per-trade today. The second key
   exists only so the automation itself (or an attacker who compromises it) can
   never unilaterally widen its own limits.
4. **Supervisory audit defaults to pause/flag-only** (§8).
5. **Supervisory audit is event-triggered, not clock-polled** (§8) — cost-driven
   decision, see §8 for the numbers.
6. **Hosting: reuse Railway project `ponslive-worker`.** Old `sync-worker` service
   already had no public networking exposed — good fit for a signer that should
   have none either. User deleting the old service themselves; new service created
   there once `lp-automation/` has code to deploy.
7. **Calldata builder: Krystal's `lp-txn` API**, not hand-built Uniswap V3 SDK
   integration — see §1.
8. **Chain: Robinhood Chain** (final, after Base → Robinhood Chain across sessions
   2–3) — see §1 for the full reasoning and the live-API verification.
9. **Safe *Module*, not a Safe *Guard*** (session 4, at build time) — the
   Guard-based design in sessions 1–3 was self-defeating: it required threshold 1
   for the automation to act alone, and threshold 1 lets that same key remove the
   Guard. See §4 for the full argument. This is the only architectural change made
   during the build; everything else was implemented as planned.

---

## 10. Phasing (adapted from source §11)

**Phase 1 (P0):**
1. ✅ `OctAutomationModule` — allowlist/selector/spend-cap enforcement, built in
   isolation. 40 Foundry tests. **Not yet executed** — Foundry isn't installed
   locally, so CI's `contracts` job is their first real run (§4).
2. ✅ Policy engine + rule evaluator — `src/policy/`, `src/rules/`. 149 tests,
   mutation-tested. Corrected the source spec's efficiency formula (§6).
3. ✅ Krystal API wrapper — `src/ingest/krystal/`, `src/calldata/`. 77 tests.
   `platform` resolved to `uniswapv3` (§3).
4. ✅ Direct RPC watch layer — `src/ingest/rpc/`. 65 tests. Needs a live endpoint
   to settle the assumptions in §11 item 7.
5. ⬜ Wire the Safe + module as the execution path. Lifecycle actions
   (enter/compound/rebalance/exit) via Krystal calldata. **This is the step that
   first moves real funds** — nothing before it can.
6. ✅ Audit log — `src/audit/`. 18 tests. Records intent *before* broadcast and
   the outcome after, so a crash mid-send is visible rather than silent.
7. ⬜ Dashboard: policy editing + pool-candidate picker (§5, §9.2).

Steps 1–4 and 6 are components; **none of them can move funds**. Step 5 is the
integration that connects them to a signer, and step 7 is what makes the policy
editable without a deploy. Deliberately in that order: the pieces that decide
were built and tested before the piece that acts.

**Phase 2 (P1):** event-triggered supervisory audit pass (§8), manual override
dashboard, per-position override.

**Phase 3 (P2):** multi-chain (Base and Krystal's other 7 supported chains are now
just a policy `chain` field + module allowlist away, per §1), gated pool-creation
flow, backtesting — per source spec, explicitly design-for-later.

---

## 11. Still open before Phase 1 starts

1. **Initial policy numbers** — max position size, daily spend cap, switching
   buffer threshold/duration. Recommend starting deliberately small given real
   funds are live from day one (easy to raise later, hard to walk back after a
   loss). Set via the dashboard once it exists, not a code-time decision.
2. ~~**Krystal API practical rate limits**~~ — RESOLVED during the build: **no
   rate limiting observed.** 40 concurrent + 30 sequential requests all returned
   200, and no `X-RateLimit-*` or `Retry-After` headers are sent at all. 429
   handling is implemented regardless, since absence of evidence at this volume
   isn't evidence of absence at production volume.

   **A different hazard was found in its place:** the Cloudflare all-zero-address
   403 tripwire (§3). It is not rate-based and no amount of backoff clears it —
   it is triggered by request *content*, reached by the obvious way of declining
   referral attribution, and returns HTML rather than JSON so it misreports as a
   parse error. Guarded, but worth knowing it exists before someone adds a new
   query parameter that can hold a zero address.
3. ~~**Robinhood-Chain-specific Krystal `platform` parameter value**~~ — RESOLVED:
   it is `uniswapv3`, confirmed four ways including a live 200 with executable
   calldata. See §3.
4. **Which Safe version is deployed on Robinhood Chain.** `OctAutomationModule`
   declares a local `ISafe` matching Safe `ModuleManager` v1.3.0/v1.4.1
   (`execTransactionFromModuleReturnData`, `isModuleEnabled`). If the singleton
   actually deployed on chain 4663 differs, every `execute` call reverts. This
   fails *closed* — a total outage, not a loss — but confirm it before deploying
   by checking `safe-global/safe-deployments` for chain 4663, or simply by
   creating a Safe in the Safe UI on that chain and reading the deployed version.
5. **ERC-20 value is not capped on-chain.** The module's per-tx and daily caps
   bound *native* value only; token amounts live inside `data` and can't be read
   without per-selector ABI decoding. On a chain where LP value sits in tokens,
   the destination+selector allowlist and ERC-20 approval hygiene do most of the
   real work — do not read "we have spend caps" as covering token value. The
   realistic loss path is an allowlisted selector called with hostile
   slippage/recipient/deadline arguments, which argument-level validation in the
   off-chain calldata layer (§3) mitigates but does not eliminate.
6. **Pool discovery depends on an undocumented endpoint** (`v2/lp_explorer/top_pools`,
   §3). It works today and there is no documented alternative — the documented
   ones are broken on every chain — but it can change without notice. Failure
   here degrades to "no new candidates surfaced", which is safe, but should be
   monitored rather than assumed stable.
7. **Needs a live RPC endpoint to settle** (`src/ingest/rpc/`): Robinhood's
   ~100ms block time (taken from viem's bundled chain metadata; it drives the
   confirmation and staleness defaults), a reorg depth sized off that block time
   rather than observed statistics, whether the free tier serves `eth_subscribe`
   on logs *and* historical `eth_call` at `head − 3` (the confirmation read
   degrades to weaker log-derived evidence if not), and whether the pools are
   canonical Uniswap V3 — a fork with modified events would silently match no
   topics. Worth one live sanity check against a real pool before trusting it.
8. **`maxIlRiskScore` is accepted but not applied.** There is no IL model yet and
   `PoolCandidate` carries no IL field. Inventing a scoring model would silently
   filter pools on a number nobody chose, so the criterion takes the score as an
   explicit argument and **treats `null` as failing** — unknown is not safe.
9. **`lastCompoundedAt` has no Krystal source.** No sampled endpoint exposes it,
   so the `maxIntervalHours` compound backstop depends on our own audit log
   (§10 step 6) being the record of when we last compounded.

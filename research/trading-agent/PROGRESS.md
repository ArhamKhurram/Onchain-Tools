# Progress Log — OCT Trading-Agent R&D

A running, reverse-chronological log of findings, decisions, and progress on this
program. This is the "what changed and what we learned" ledger; the design lives in
[`00-paper.md`](./00-paper.md) and the docs it anchors. Newest entry on top.

**Entry format:** a dated `## <YYYY-MM-DD> — <headline>` heading, then some mix of
**Decisions** (what we committed to and why), **Findings** (what we learned — from data,
experiments, or reasoning), **Changes** (what moved in the docs/code), and **Open**
(what's now unresolved or newly surfaced). Distill, don't transcribe. A pre-Phase-0
program logs reasoning and scoping; once Phase 0 starts, entries carry real numbers
(sim-fidelity error, cost-adjusted edge, ablation deltas) with the eval discipline of
[`05-evaluation-plan.md`](./05-evaluation-plan.md).

---

## 2026-08-23 (g) — Imitation-learning seam SHIPPED: BC warm-start from tracked traders

The (f) imitation agent landed. `data/labeling/` + `agent/imitation/` now carry the whole Phase-2
behavioral-cloning warm-start, torch-free where it can be and torch-gated where it must be.

**Changes.**
- `data/labeling/pinax_loader.py` — pull a trader's **full** swap history by `signer=<addr>` (bounded
  pagination on the shared `PinaxRestClient`; reuses `decode_swap_row`), mapped to the existing
  `LabeledWallet`/`LabeledTrade` contract → straight into `build_trajectories`. This is the promised
  swap-point for `load_labeled_wallets` (fixture → live), nothing downstream changed.
- `data/labeling/wallets_file.py` — parse the operator's 968-wallet export (never committed) and
  select a **bounded, balance-ranked** cohort (the cap is what keeps a run bounded).
- `agent/imitation/demos.py` — reconstruct each trader's per-token episodes (wins AND losses) into
  **env-aligned (observation, expert-action)** demos: tier-A masked bundle assembled *as-of* each
  decision instant from the **pooled cohort tape** (every tracked trader's swaps on that mint — a
  bounded, partial reconstruction of the chart; liquidity honestly masked-missing), paired with the
  §3.3 hybrid action. Crucially it also synthesizes **HOLD** (in-position cohort prints) and **NO_OP**
  (pre-entry prints), class-capped — so BC can't collapse to "always act" *or* "always hold".
- `agent/imitation/bc.py` — supervised BC on `HybridActorCritic`: cross-entropy on intent + Beta-NLL
  on size (masked to sized intents). Generalization measured **held-out by token**. torch, `learn`
  extra; base suite green without it.
- `agent/imitation/cohort.py` — bounded end-to-end report + CLI (`--wallets-file`, `--max-wallets`,
  `--max-pages`): pull cohort → demos → BC → verdict "**does the cloned policy trade?**".

**Honesty carried forward.** Realized-only labels, full win-and-loss history (nothing
hindsight-filtered), and the report leads with the **§9.3 selection-bias caveat**: the cohort is
operator-chosen + balance-ranked, and BC clones *behaviour*, not a proven edge — profitability is a
separate measurement this does not make. Live cohort numbers land async (heavy torch install + Pinax
pulls); the mechanism, tests (ruff/mypy/pytest green), and the honest framing ship first.

---

## 2026-08-23 (f) — Full-chart multi-venue trading + imitation from 968 tracked traders (Phase 1.5→2)

Operator pushback (correct): the agent should trade a token's **whole chart on any venue**, not be
restricted to the bonding curve; train **far harder** (the 40-iter run collapses to degenerate
always-buy/always-hold); and **learn from real traders**. Provided a 968-wallet Solana tracking list
(`scratchpad/tracked-wallets.json`; includes known traders — Cupsey, Cented, slingoor…). Two agents launched:
- **Full-chart multi-venue env + heavy training** (`agent/envs/` generic env + `sim/`): reconstruct
  pool depth per token from its swap sequence and fill with the venue-appropriate `Curve` from the
  registry (pumpfun_amm/CPMM validated, CLMM approx, jupiter-router flagged), episode = the token's
  whole life, then a serious (~1000–3000-iter) PPO run. Fixes the "trade the full chart" + "train a
  thousand sessions" asks. **Corrects my earlier over-restriction** — I defaulted to the bonding-curve
  sim (garbage on migrated tokens) instead of using the Wave-2 multi-venue curves we built for exactly this.
- **Imitation from the tracked wallets** (`agent/imitation/` + `data/labeling/`): pull each trader's
  trades from Pinax by `signer=addr`, build demonstration trajectories, behavioral-clone the policy →
  a warm-started policy that actually trades (fixes the from-scratch degenerate collapse). This is the
  Phase-2 offline/imitation warm-start (paper §2.4/§6.2). Bounded subset first (~30–50 traders), scale later.

**Honesty carried forward:** realized-only reward, walk-forward eval, leakage guard, selection-bias
caveat on the trader labels (§9.3). Heavy training + 968-wallet pulls take real time — results land async.

---

## 2026-08-23 (e) — FIRST REAL RESULT: Phase-1 chart-only = NO-GO (3 seeds, 24 live tokens)

The program's first genuine scientific answer to the charter §2 question, for the raw-chart tier.

**Setup:** assembled a real dataset of **24 distinct pump.fun bonding-curve tokens** (via the
`protocol=pumpfun` REST filter, paginated — the learner's built-in one-page loader was too thin;
driver `scratchpad/phase1_real.py` reuses the repo's exact decode + `TokenTape` + `run_phase1` gate).
Held-out-**tokens** axis (train on some tokens, evaluate on entirely unseen ones), 3 seeds, 4 windows,
125 bps bonding fee, leakage guard on. Bounded budget (40 PPO iters, 64-dim net).

**Result: NO-GO on all 3 seeds.**
- Agent mean return **−24 to −47 bps** per episode; **loses to hold-SOL (cash) on every seed** (0 bps).
- vs buy-and-hold: mixed and sample-dependent — beat it on 10–70% of tokens across runs (an earlier
  partial run on a different 24-token draw had the agent beating BH 70%; this fresh draw 10–60%). No
  reliable edge either way.
- **Leakage guard passes all 3** (the noised-tier agent shows no edge — the result is honest, not leakage).

**Interpretation (clean, pre-registered — NOT a failure):** from **price/flow alone**, no edge survives
125 bps costs out-of-sample on new-pair bonding-curve tokens. The agent learns *something* (it sometimes
beats naive buy-and-hold by cutting losers) but not enough to beat simply holding SOL. This is exactly
what the progressive-information curriculum predicts and exists to test: **the edge, if it exists, must
come from the later tiers** (wallet flows → narrative/social), not the chart. High token-sample variance
is itself a finding (24-token draws give materially different BH-beat rates).

**Honest scope caveats (don't overclaim):** bounded first pass (small net, 40 iters); the **distributional
critic was numerically unstable** (value estimates blew to ~1e5 — the eval is on real returns so the
verdict stands, but training quality needs a fix); one venue (bonding curve); the verdict is "chart-alone
shows no edge under an honest bounded setup," NOT "no edge can ever exist."

**Next:** (1) productionize a `protocol=pumpfun` paginated **dataset builder** in-repo (reproducible, not
scratch); (2) **fix the critic instability** (value normalization / return scaling); (3) **Phase 2 — add
the wallet-flow tier**, the first curriculum step where the design expects an edge to actually appear.

---

## 2026-08-23 (d) — Phase-1 LEARNER launched; vector-DB deferred to Phase D

- **Learner agent launched** (owns `agent/policies/` learned + `agent/critics/` + `agent/online/` +
  `agent/train.py`): a neural actor on the tier-A observation → §3.3 hybrid action, a **distributional
  critic** (§6.3, for fat tails / CVaR), and a **PPO** loop training against `TradingEnv` on real
  bonding-curve tape with recent-window replay + walk-forward eval + the leakage-guard ablation. Runs
  bounded (first honest signal, not a hyperparameter search). **A "no edge after costs" verdict is a
  valid Phase-1 outcome** (charter §2) — the brief forbids chasing a positive number. Offline-RL /
  imitation warm-start is the next enhancement (needs the labeled-wallet DB, not yet wired).
- **Vector DB — deferred to Phase D (operator asked).** Not needed for Phase 1–2 (pure numeric
  price/flow features → policy; nothing to embed). It earns its place at **Phase D (narrative/social)
  and E (chatter)**, where text is embedded + retrieved ("what's the narrative around this token") —
  already implied by the tech-design's text-encoder + retrieval at those tiers. Optional earlier use:
  episodic / retrieval-augmented memory ("similar past setups"), an enhancement, not a requirement.
  Logged as a Phase-D infra dependency so it isn't forgotten.

---

## 2026-08-23 (b) — Hybrid launch: Phase 1 begins while the sim hardens in parallel

Operator chose the hybrid path. Two agents launched in parallel (disjoint scopes):
- **Sim hardening** (owns `sim/` + `data/reserves`): P0 fix the sell-side data interpretation
  (~17% off — a data-mapping issue, not the model); productionize the independent-reserve
  calibration as a tested repo module (freshest-fill mode, real curve models); P1 per-pool pump.fun
  fee tier (to tighten the ~90 bps buy residual); P2 non-pumpfun vault resolution.
- **Phase-1 substrate** (owns `agent/envs/` + `eval/`): the RL environment + §3.3 action space +
  §3.4 scalper episode + §3.5 reward (realized risk-adjusted, potential-based shaping, NEVER
  unrealized/peak) + walk-forward eval + baselines (hold-SOL/buy-and-hold/random), on the **bonding-
  curve regime** (~0 bps fidelity, the first-minutes phase the thesis centers on). Env + eval only —
  the actual learner (offline RL, PPO, distributional critic) is the next phase; clean `Policy` seam left.

**Rationale:** ~90 bps AMM entry error is tiny vs the 100%+ moves a memecoin scalper trades, and the
bonding curve is already ~0 bps — so start learning on the highest-fidelity, highest-importance regime
now rather than over-engineering the sim first. The sell-side bug is the one non-negotiable fix (can't
trade a sim you can't sell in), hence P0 on the hardening agent.
---

## 2026-08-23 (c) — Sell-side root cause found + independent-reserve calibration productionized

Turned the scratchpad prototype into a tested repo module (`sim/calibration_independent.py`,
`tests/test_calibration_independent.py`) and chased down the "broken sells" the (a) entry flagged.

**The sell-side root cause is NOT the sell model — it is a per-pool reserve/pricing-vault offset.**
Investigated directly against live `pumpfun_amm` swaps:
- `fill_sell` is correct. A self-consistent synthetic sell reproduces through the whole harness to
  **~0.03 bps — identical to a buy** (`test_buy_and_sell_symmetric_residual`). The model was never
  the problem, exactly as the (a) entry suspected.
- A genuinely independent, post-anchored predictor (predict the SOL-out from real reserves + the
  token-in *only*, never touching the observed SOL-out) showed live sells **~15–18% off** even at
  **zero roll-back (freshest fill, gap=0)** — far too large to be a fee-interpretation issue
  (removing the fee moved it only ~25 bps). So it is not fee-inclusive/exclusive, not a recording
  offset, not a mislabeled leg.
- The **same** post-anchored predictor on **buys** is mostly clean (~30 bps = the fee) but with the
  same-magnitude outliers on the *same pools* that the sells blew up on. Forensic on those pools:
  **every recent swap — buys included, even a zero-impact 0.01-SOL trade — executes at a systematic,
  size-independent offset from the reserve-implied mid** (measured 0–14% across pools; one pool at
  +13% corrupted its buys and sells identically). So for a subset of pump.fun-AMM pools the raw
  `owner=amm_pool` vault balances are **not** the pool's constant-product pricing reserves (extra
  tokens / accrued fees in the vault). The original sell number was ~1700 bps because the tiny n=7
  sell sample happened to land on high-offset pools — a **sampling artifact, not a sell mapping bug**.

**The productionized harness (`reproduce_pool` / `calibrate_independent`):**
- Real curve models via the registry, real `ReservesClient` anchors, **naive reversal** (observed
  user amounts, not the curve's fee-exact deltas — reconstructing from the swap's own fee deltas and
  then predicting it forward would cancel to ~0 by construction; the naive path keeps the fee model
  exposed, so a wrong fee shows as real error). Verified: full-retention CP reproduces a
  self-consistent swap to **exactly 0 bps**, pump.fun's LP+protocol+creator stack to a small,
  fee-exposed residual (both sides).
- **Freshest-fill default** (`window=1`): roll-back drift climbs monotonically with reconstruction
  distance, so the newest swap is the cleanest; a `window` knob widens it and a test pins the drift.
- **Reporting**: per-venue **buy AND sell** median / p75 / p90, plus a pool-level **anchor-divergence
  diagnostic** (median executed price vs reserve mid, size-robust) surfaced on every record. **The
  anchor gate (`max_anchor_divergence_bps`) is ON by default in the runner at 1000 bps** — it drops
  the bad-vault pools. NB (corrected post-merge, see below): the robust median rescues the BUY
  aggregate (large n) but NOT the sparse SELL sample, so the gate — not the median — is what makes
  sells comparable. The pure `reproduce_pool` keeps the gate off so the primitive stays honest.

**Live numbers (window=3, `pumpfun_amm`):** buys ~76–120 bps median. **Sells: gate OFF 3921 bps →
gate ON 97 bps** — a clean-anchor sell reproduces to **97 bps**, in line with buys, once the offset
pools are gated. Offset pools show a size-independent 0–14% divergence from the reserve mid (the
`owner=amm_pool` vault ≠ the pricing reserve); they are a minority but sells land on them
disproportionately because sells are sparse.

**Correction applied post-merge (orchestrator):** Agent A's worktree was removed by me during cleanup
while it was still finalizing this validation (my error — never remove a running agent's worktree). Its
final data corrected an overclaim in the merged code/log: the median alone does NOT fix the sparse sell
sample. Applied: runner `max_anchor_divergence_bps` default `None`→`Decimal(1000)` (gate ON), module +
this entry reworded to credit the anchor gate with the measured numbers (sell median 3921→97, clean sell
97 vs buys 76), and a test pinning the default-runner gating.

**Per-pool pump.fun fee tier (task 3):** wired (`resolve_pumpfun_curve` resolves the mcap tier per
pool and the runner passes it in). Caveat surfaced by the data: the mcap proxy uses a fixed 1e9 token
supply, but real pump tokens are **not** uniformly 1e9 (a live vault held 12.46B tokens), so the tier
mis-resolves without a true per-token circulating supply and did **not** cleanly tighten the buy
median on the live sample. The mechanism is in place; correct tiering needs the token supply — noted
as the refinement.

**Deferred (task 4, P2):** non-`pumpfun_amm` vault resolution. raydium/orca/meteora return no
reserves because `ReservesClient` only resolves vaults via `owner=amm_pool` (verified for the pump
AMM only), so the calibration currently covers `pumpfun_amm`. The harness itself is venue-general
(registry dispatch); extending it needs per-venue vault-account resolution in `reserves.py`.

**Lesson banked:** a per-swap "executed vs mid" gate looks reasonable but wrongly drops legitimately
large-impact fills (they diverge from mid yet reproduce fine) — the offset is only separable from
impact by a *median over many swaps* at the pool level, and even that is confounded by a real price
move, which is why the honest number leans on the robust median, not a hard filter.

---

## 2026-08-23 — Independent-reserve calibration: the honest Phase-0 fidelity number

Built + ran the independent-reserve fill-reproduction (anchor at REAL on-chain reserves via
`ReservesClient`, roll back through the recent swap sequence to each swap's true pre-trade state,
predict with the ACTUAL merged curve models, compare). Two harness bugs found and fixed en route
(roll-back/snapshot-block alignment; a `PoolState` 6-field signature my catch-all `except` was
silently masking — lesson: never catch-all around the thing under test).

**Results (pumpfun_amm, ~20 live pools, freshest fills where roll-back drift is negligible):**
- **BUYS: ~90 bps median** (n=33, p75 181, p90 458) — sound.
- **SELLS: ~1700 bps median** (n=7, small) — systematically broken.
- Roll-back drift confirmed as the dominant artifact beyond the freshest fills: error climbs
  monotonically with reconstruction distance (pos0 ~30 bps → pos10 ~1480 bps), so only the newest
  1–2 swaps per pool give a clean model number.

**The load-bearing methodology finding:** independent reserves give **~90 bps** where the earlier
self-consistency fit gave ~26–30 bps — because a *fitted* depth silently **absorbs** fee/model error.
**~90 bps is the honest fidelity; the ~30 bps was flattered.** This is exactly why the honest gate
had to use independent reserves, not curve-fitting.

**Verdict — NOT a clean GO yet; sound model, 3 concrete fixes before the gate can be called:**
1. **Sell-side data interpretation** — `fill_sell` passes all unit tests + synthetic, so the ~17%
   blowup is how Pinax records sell amounts (cf. Agent E's ~1.05% bonding-curve sell offset). Resolve
   the sell `input_value`/`output_value` semantics before trusting the sell path in calibration.
2. **Per-pool fee tier** — pump.fun fee is mcap-tiered (30→125 bps); the curve used the mature 30 bps
   for all pools, so the ~90 bps buy residual is largely tier mismatch. Wire the per-pool tier.
3. **Non-pumpfun vault resolution** — raydium/orca/meteora returned no reserves (`owner=amm_pool`
   only verified for pump.fun AMM per #165); needs per-venue vault-account resolution to extend the
   gate beyond the 62.5% + 8% pump.fun venues.

**What IS validated:** the bonding curve (~0 bps, deterministic), the CPMM law and fee mechanics
(unit tests + buys), and the whole real-reserves → roll-back → real-curve pipeline end to end. The
honest number for the dominant post-migration venue is ~90 bps buys, with a clear path to tighten it.
Prototype harness in scratchpad (`indep_calib.py`); productionizing it (with the 3 fixes) is the next task.

---

## 2026-08-22 (l) — WAVE 2 COMPLETE: full venue coverage, bonding curve validated to ~0 bps

All four Wave-2 PRs merged (#165 reserves, #166 curve abstraction + pump.fun AMM fees, #167 CLMM,
#168 bonding curve). Combined tree green: ruff + mypy-strict (82 files) + **242 passed / 5 skipped**.
Resolved the E/F cross-conflict (both registered venues in `__init__.py`; a stale `raydium_clmm`-
unsupported assertion superseded by `jupiter_v6` since CLMM now supports raydium_clmm).

**Venue coverage now (share of live Solana swaps):**
| Venue | Share | Model | Fidelity |
|---|---|---|---|
| `pumpfun_amm` | 62.5% | `PumpFunAmmCurve` (CPMM + real 3-part fee) | ~26 bps on a good pool (self-consistency; pool-dependent) |
| `pumpfun` (bonding) | 7.9% | `PumpFunBondingCurve` (virtual-reserve CP) | **~0.0 bps median buys** — deterministic, exact seed constants proven across 4 tokens |
| CLMM (orca/raydium_clmm/meteora_dlmm) | ~14% | `ConcentratedLiquidityCurve` (effective local L) | honest map: ~409 bps in-range vs ~1478 out-of-range (meteora_dlmm); flags out-of-range |
| other CPMM (raydium_amm_v4/cpmm, meteora_amm) | ~3% | `ConstantProductCurve` | textbook x·y=k |
| jupiter_v6 (router) | ~8% | typed-unsupported | resolved per-hop later, never priced directly |

**~87% of swaps now have a curve model**; the venue→curve resolver dispatches on `protocol`, unknown
venues return a typed unsupported result (never a silent wrong fill). **Independent reserves**
(`ReservesClient`, #165) enable live-pool absolute-depth calibration.

**Standout result:** the pump.fun bonding curve — the earliest-life regime the paper's thesis centers
on — reproduces real buys to **~0.0 bps**. Because it's deterministic (virtual-reserve constant
product, fees fully external so k is preserved), that near-zero error *proves* the seed constants
(virtual 1.073e9 token / 30 SOL, 125 bps fee) are exactly right. The first-minutes regime is the one
we can model most precisely.

**Process note:** 3 of 4 Wave-2 agents finished their code green but stalled on their live-validation
sub-tasks and failed to open a PR (Step 0, F) or left work uncommitted; I salvaged + reviewed +
merged each. Pattern for long research-with-live-data agent tasks: the git/PR wrap-up is where they
drop the ball — orchestrator must verify PR state, never trust the "done" message alone.

**Next — the honest Phase-0 gate:** wire independent-reserve calibration (`ReservesClient`) on LIVE
pools across venues → a real per-venue fill-reproduction number where the fee model actually binds and
absolute-depth slippage is testable. Then pre-register the GO tolerance against that distribution.

---

## 2026-08-22 (k) — Step 0 merged (#166); fee-model finding: self-consistency can't validate fees

**Changes**
- **Step 0 merged (#166)** — multi-venue `Curve` abstraction + `CurveRegistry` (resolve by `protocol`,
  `@register_curve` extension point) + `PumpFunAmmCurve` with pump.fun's real 3-part fee stack
  (LP+protocol+creator, fees-on-top `·10000/(10000+bps)`, only LP retained in reserves), + additive
  `SwapEvent.protocol` tag. **Salvaged**: the building agent completed the code green (204 tests) but
  looped on the optional live re-validation and never PR'd; I reviewed the contracts/fee model
  directly and merged. Combined tree green (ruff/mypy-80-files/204 passed).

**Finding (methodological — matters for how we validate the sim)**
- **The fee-model refinement is NOT observable under self-consistency fitting.** Controlled A/B on the
  same 5000-swap pool: flat-fee const-product median 160.6 bps vs pump.fun fee stack 162.1 bps —
  Δ ~1.5 bps, i.e. no improvement. Reason: when reserves are *fitted* to the swap sequence, the
  fitted depth **absorbs** any fee mis-specification. So the fee correction can only be validated with
  **independent reserves** (Agent G's `ReservesClient`, live pools), where depth is fixed and the fee
  must be exactly right. The fee model is still correct and needed — it just can't be proven this way.
- **Residuals are strongly pool-dependent** (~26 bps on the first pool measured, ~160 bps on another) —
  dominated by per-pool dynamics the simple constant-k self-consistency fit doesn't capture (LP
  add/remove, routed/multi-hop swaps), NOT by the fee. So "constant-product reproduces to ~26 bps" was
  a good-pool result, not a universal one; a robust fidelity number needs independent reserves + LP-event
  handling, not a better fee.

**Implication for the Phase-0 gate:** the honest calibration is **independent reserves (G) on LIVE pools**,
not self-consistency fitting — that's where the fee model earns its keep and where absolute-depth slippage
is actually testable. Self-consistency stays a fallback for dead historical pools only.

**Also:** E (bonding curve) + F (CLMM) launched against the merged registry.

---

## 2026-08-22 (j) — Agent G merged (#165): no historical reserves, but live reserves validate impact

**Findings (plan-changing)**
- **Pinax has NO historical-by-block reserves for Solana.** `/v1/svm/balances` is latest-snapshot only —
  the `block_num` param is silently ignored; only EVM has a `/historical` variant. Consequence:
  - **Live / recent pools** → latest snapshot ≈ swap-time reserves (within a block or two) → usable.
  - **Dead pools** (most pump.fun tokens after they rug/fade) → latest balance is dust, unrelated to
    swap-time depth → absolute depth NOT recoverable from this endpoint.
  - **Implication:** independent reserves work for LIVE trading + forward paper-testing (the agent's
    actual regime). For HISTORICAL backtest depth we fall back to the self-consistency fit, OR capture
    reserves live going forward (snapshot as we ingest, building our own reserve series). Not a blocker
    — it just splits "live depth = measured, historical depth = fitted."
- **Live reserves validate the impact signal.** Sanity check on two pump.fun-AMM pools: reserve-implied
  mid matched executed price to ~0.8–1.2%, correct direction (buys execute above mid = fees + own
  impact against a finite ~700–1700 SOL pool). That own-impact term is exactly the absolute-depth
  signal the fitted reserves couldn't identify — so live reserves genuinely add information.

**Changes** — `data/pinax_client/reserves.py` (`ReservesClient`: pool meta, reserves via `owner=amm_pool`
vaults, `reserve_anchors`, `is_fresh`), a network-gated probe, and a `User-Agent` fix on every Pinax
REST call (was missing → the 403s). Merged #165; combined tree green (177 passed / 3 skipped).

---

## 2026-08-22 (i) — Wave 2 launched: full venue coverage + independent reserves

Goal: take the sim from "~65% of volume, self-consistency-validated" to full venue coverage,
independently validated. Structured like Wave 1 — foundation first, then parallel builders.

- **Step 0 (running) — multi-venue curve abstraction + pump.fun fee schedule.** Introduce `sim/curves/`
  with a `Curve` protocol + a venue→curve resolver keyed on `protocol`, move existing constant-product
  behind `ConstantProductCurve` (no behavior change), and replace the flat CPMM fee with pump.fun's
  real LP+protocol+creator schedule — re-validating that the ~26 bps residual drops. This is the
  foundation the two new curves plug into.
- **Agent G (running, parallel) — independent reserves via `/v1/svm/balances`.** Fetch real pool vault
  reserves as-of a block so calibration can validate ABSOLUTE depth / large-order slippage (closing the
  self-consistency-fit caveat). Data-layer only; key open question it answers: does Pinax expose
  historical-by-block balances at all?
- **Deferred to after Step 0 merges:** **Agent E** (pump.fun bonding-curve model — the ~8% earliest-life
  regime; pump.fun uses a known virtual-reserves curve, so fills are predictable from the formula, not
  fitted) and **Agent F** (concentrated-liquidity: whirlpool/CLMM/DLMM ~14% — scoped to an effective-
  local-liquidity approximation with honest documentation of where tick-crossing breaks it). Jupiter
  (~8%, a router, not a venue) is a known gap, not modeled now.

---

## 2026-08-22 (h) — FIRST real calibration: constant-product reproduces pump.fun-AMM fills to ~26 bps

Ran the first real fill-reproduction against live Pinax `solana@swaps` (5000 consecutive swaps on one
busy `pumpfun_amm` pool, ~8 min of blocks). **Result: constant-product reproduces real fills to
median 25.6 bps, p90 85.6 bps, p99 149 bps — 100% within 200 bps, ZERO curve-breaks (>10%).**

**What it means**
- **The pump.fun *AMM* (post-migration, `pAMMBay…`) is genuinely constant-product** — our x·y=k model is
  the right law for it, empirically. The ~26 bps residual is almost certainly pump.fun's fuller
  fee stack (LP + protocol + creator fee) vs my single fitted 20 bps — a fee-schedule refinement,
  not a curve-model problem.
- **Venue mix (2000 recent solana swaps):** `pumpfun_amm` **62.5%**, `pumpfun` (pre-migration bonding
  curve) 7.9%, jupiter_v6 (router) 8.4%, meteora_dlmm 5.8%, orca_whirlpool 5.5%, meteora_daam 3.1%,
  raydium_clmm 3.0%, raydium_amm_v4 1.9%, cpmm/others ~1%. So constant-product cleanly covers
  **~65%** (pumpfun_amm + raydium_amm_v4/cpmm/meteora_amm). Needs separate models: the **pump.fun
  bonding curve** (~8%, and it's the *earliest-life* regime new pairs launch into — matters most for
  the paper's first-minutes focus) and **concentrated-liquidity** DLMM/whirlpool/CLMM (~14%).

**Honest methodology caveats**
- This is a **self-consistency** fit: reserves fitted to the swap sequence, then the CPMM law tested
  for consistency with observed fills. It validates the curve LAW (and relative fills), NOT
  prediction from independently-sourced reserves. Absolute depth is weakly identified (trades small
  vs pool), so large-order slippage isn't yet validated — needs independent reserves via
  `/v1/svm/balances` (historical, by pool vault + block).
- One pool, one venue, ~8 min. Not yet routed through Agent A's Parquet log + Agent B's calibration
  harness (used the raw CPMM math, which mirrors B's `curve.py`).

**Next**
- Model pump.fun's real fee schedule → expect the ~26 bps residual to shrink toward rounding.
- Add the **pump.fun bonding-curve** fill model (earliest-life regime) + a CLMM model.
- Pull independent reserves (`/v1/svm/balances` historical) to validate absolute depth / large-order
  slippage, then run the official A→B pipeline and pre-register the GO tolerance against that
  error distribution.

---

## 2026-08-22 (g) — Wave 1 COMPLETE: all four merged, integrated package green

**Changes / status**
- **All four Wave-1 PRs merged** (#161 featurestore, #162 sim+ledger, #163 attention, #164 data).
  Integrated locally, resolved conflicts (only a trivial `tests/__init__.py` add/add; pyproject
  auto-merged), fixed two ruff violations that surfaced only in the merged config (an absolute-import
  + a now-unused `S310` noqa in the data client). **Certified the COMBINED package green — not just
  per-agent:** `ruff` clean · `mypy --strict` clean (73 files) · **pytest 168 passed / 3 torch-skipped**.
- Phase-0 skeleton now exists end-to-end: `data/` (REST backfill + `solana@swaps` WS + Parquet tape
  log + labeling) → `featurestore/` (point-in-time + tier-A + leakage audit) → `sim/` (constant-product
  AMM fills + execution realism + rug states + replay + calibration harness) + `ledger/` + the
  `agent/encoders/` attention model (Hawkes + manipulation channel + two-head transformer).

**Open — decisions/notes for the first real run**
- **pump.fun bonding curve vs constant-product (the real fidelity question).** Genuinely new Solana
  pairs launch on pump.fun's *bonding curve*, NOT an x*y=k AMM; the sim models constant-product
  (Raydium-style, default 25 bps). Calibration against real tape will EXPOSE this as high
  reproduction error on pre-migration pump.fun swaps. Plan: pull real tape, measure per-venue
  reproduction error, add a bonding-curve fill model if constant-product doesn't clear tolerance.
  Fee tier is itself a calibration output.
- **Pre-register the GO-gate numbers.** Sim calibration tolerance / reproduction-fraction are
  placeholders (50 bps / 0.95). Per experiment-plan governance they must be pre-registered before
  the GO decision — but sensibly set after a first real pull reveals the error distribution. Operator
  call.
- **Frozen-feature contract nit** (deferred): `core.PointInTimeFeature` declares `name`/`tier`
  writable, forcing feature classes non-frozen under mypy-strict. Small post-wave `core` cleanup
  (make them read-only properties). Low priority.
- **Next concrete step:** pull real `solana@swaps` tape via REST backfill → Parquet log → run the
  calibration harness = the first "does the sim reproduce reality" signal.

---

## 2026-08-22 (f) — Pinax key live; live WS firehose discovered

**Findings**
- **`PINAX_API_KEY` populated and verified** — REST `/v1/networks` → HTTP 200 (auth works; the 400 on
  `/v1/svm/swaps?limit=1` is just missing query params, not auth). Key + JWT now in `backend/.env`
  (`PINAX_API_KEY` for REST `X-Api-Key` / Substreams gRPC bearer; `PINAX_API_TOKEN` = JWT for WS).
  Live ingestion + real fill-reproduction calibration are unblocked.
- **Pinax exposes a live decoded-swap WebSocket firehose** — `wss://ws.pinax.network/ws/solana@swaps?token=<JWT>`
  — cleaner than Substreams gRPC for the live tail (no spkg, just `<network>@<table>` + token). Intended
  split now: **REST `/v1/svm/swaps` for historical backfill, WS `solana@swaps` for live.** Sent this to
  Agent A mid-build as an additive augmentation (keep the stream name parameterized).
- **Broader Pinax surface (PRO plan), noted for later — NOT in Phase-0 scope:** Token API, Prediction
  Markets, Perp Exchanges, Blobs, RPC, Firehose; WS streams incl. `solana@spl_transfer`,
  `bsc@erc20_transfers`, `robinhood@erc20_transfers` (maps onto the operator's own Sol/BNB/Robinhood
  trading surfaces), `mainnet@swaps`, hyperliquid/polymarket. A real multi-chain experimentation surface
  for after the new-pair agent proves out.

---

## 2026-08-22 (e) — Scaffold merged (#160); Wave 1 (all four) launched

**Changes / status**
- **Scaffold merged — PR #160** (`99f618d`). Python package `oct_trading_agent` with typed core
  contracts (tape events, `Feature`+enforced-missingness, `Order`/`Fill`, `AgentDecision`,
  `AttentionState`+mandatory authenticity channel, leakage-audit hook). Gates were green
  (ruff/mypy-strict/pytest). Nested-namespace deviation accepted (good call). Reviewed the core
  contracts directly before merge — they're high quality (realized-only walling on `mark_price`,
  leakage audit = append-future-invariance, discriminated-union tape w/ dual slot/block_time).
- **Wave 1 launched — four parallel worktree agents, disjoint module ownership, PRs into the branch:**
  - **A · data/** — Pinax REST/gRPC client → append-only Parquet log; backfill; trader-labeling
    pipeline (fixture schema, real DB deferred). Tests on the revival spike's cached real responses.
  - **B · sim/ + ledger/** — constant-product AMM fills (slippage/impact/fees), execution realism
    (latency/MEV/failed-txn), rug absorbing states, replay driver (`Simulator` protocol), paper
    ledger, and the calibration harness (held-out real swaps → fill-reproduction error = the GO metric).
  - **C · featurestore/** — point-in-time store (explicit missingness), tier-A raw-chart features,
    the standing leakage audit (catches a deliberately-leaky feature).
  - **D · agent/encoders/** — Hawkes estimator (λ, branching ratio n) + manipulation-suspicion channel
    (both pure-numpy, mandatory) + causal-attention transformer w/ SSL head + the §6.4 two-head
    (stop-gradient public / task-coupled private) structure. Torch optional; suite green without it.

**Open / blocker for the GO gate (not for building)**
- **`PINAX_API_KEY` is EMPTY in `backend/.env`.** All four build+test on fixtures/synthetic, so this
  does not block the wave — but live historical backfill (Agent A) and therefore the real
  fill-reproduction calibration (Agent B) can't RUN until the key is populated. Need the value from
  the operator (revival spike must have sourced it from an env that's since been cleared).

---

## 2026-08-22 (d) — Phase-0 gate sharpened: tape is self-sufficient; labeled DB deferred

**Decisions (operator, correcting my over-flagging)**
- **The Pinax tape is the ground truth for the Phase-0 gate — no external validation set.** Every
  real swap already encodes executed price, slippage, and fees on-chain. Calibration = hold out real
  swaps, reconstruct pool state as-of the instant before each, sim predicts the fill, compare to what
  actually executed. Cleaner and fully self-contained. (03-experiment-plan Phase 0 Dataset + Primary
  metric updated accordingly.)
- **Labeled-wallet DB is NOT a Phase-0 dependency.** It feeds imitation warm-start (Phase 1) and
  traders-as-opponents (Phase 3), not the GO gate (sim reproduces fills + leakage audit + trivial
  baseline). Phase 0 builds the labeling *pipeline* against a fixture schema; the real DB is wired at
  Phase 1. Removes both prior "needs you" data blockers — Phase 0 needs only the tape.

---

## 2026-08-22 (c) — Phase 0 build launched (scaffold agent running)

**Decisions**
- **Language: Python-first, native-kernel-ready.** Build correct in Python (Phase-0 doc: correctness
  > cleverness), vectorized with numpy/polars. Keep the simulator hot loop behind a clean interface
  so it can be swapped to a **Rust** kernel (PyO3/maturin — preferred over C++ for Python bindings +
  Solana-ecosystem fit) *only where profiling proves it's needed*. No premature native code. (Operator
  asked for "fastest/most efficient for non-Python parts"; this is the honest answer — memory-bandwidth-
  bound vectorized replay gets most of the way in polars before any native kernel earns its keep.)
- **Data access resolved.** Pinax creds already exist in the monorepo `backend/.env` as `PINAX_API_KEY`.
  Proven access (from the revival spike, `oct-revival/spike/revival-scanner/src/`): REST
  `https://api.pinax.network` (`X-Api-Key`); Substreams gRPC `https://solana.substreams.pinax.network:443`
  (bearer = raw `PINAX_API_KEY`, NOT a JWT — verified 2026-08-04); package `dex-swaps-v0.5.2.spkg`
  (pinax-network/substreams-svm), same data as REST `/v1/svm/swaps`. Creds read at runtime from
  backend/.env, never hardcoded/committed. Still TBD for the GO gate: a validation set of *known real
  fills* to calibrate the sim against, and the labeled-wallet DB in queryable form.

**Changes / status**
- **Step 0 (scaffold + shared contracts) agent launched** — worktree-isolated, PRs into
  `research/trading-agent`. Establishes the Python package + the typed contracts (tape events, feature
  bundle w/ explicit missingness, Order/Fill, AgentDecision, AttentionState w/ authenticity channel,
  leakage-audit hook) that Wave 1 builds against. Wave 1 (Data+labeling · Simulator+ledger ·
  Feature-store+leakage-audit · Attention-pretrainer) fires once the scaffold PR merges.

---

## 2026-08-22 (b) — Codependence decision; Phase 0 build kicking off

**Decisions**
- **The attention model and the agent are codependent — trained side by side, not in sequence**
  (operator's call, reading the attention paper). New pairs *are* attention markets (price ≈ the
  derivative of crowd attention), so an agent trading here trades *within* the attention system the
  model estimates; the two are one jointly-optimized system with two heads. Folded into paper §4.4
  ("Codependent training") and companion §6.4 (mechanics). Key points: (a) encoder is co-trained
  end-to-end with the policy — pretraining is a warm start, not a freeze; joint loss
  `L_RL + β·L_SSL` with β annealed; (b) the reflexive coupling (the agent's own flow inflates the
  branching ratio it reads) is *why* joint training is mandatory, not just convenient — an encoder
  frozen on passive-observer flow misreads the tape the moment the agent acts; (c) a **stop-gradient
  copy** of the SSL representation feeds the convergence layer / standalone alert, so the shared
  signal stays flow-derived and independent even as the agent's private view specializes.
- **Attention-as-independent-signal survives** — the model can still be *born alone* (pretrained,
  shipped as an alert before the agent exists). Standalone-first is the delivery hedge; codependence
  is the mature state.

**Changes**
- Paper §4.4: new "Codependent training" paragraph; wire-in point 1 now says "warm start, not a freeze."
- Companion sub-project: new §6.4 "Codependent training with the agent (mechanics)."

**Open / next**
- **Phase 0 build is being scoped for a multi-agent launch** (simulator + data pipeline + feature
  store + attention pretrainer + eval harness) — pending operator's go. Ground truth for the scope:
  `03-experiment-plan.md` Phase 0 and `02-technical-design.md` §6 module layout. Phase 0 is
  engineering-heavy, near-zero training compute; the deliverable is a *fidelity-measurable simulator*,
  not a trained agent. Hard gate: sim reproduces real fills within tolerance + leakage audit passes.

---

## 2026-08-22 (a) — Attention model folded in; signal-first locked; workspace synced to the paper

**Decisions**
- **Signal-first is now the program's committed deliverable** (paper §4.2, §9.8, §1.3; charter §6;
  README banner). The primary product is a *calibrated signal / API*, not a fund-holding autopilot.
  Live autonomous execution through `/sniper/v1` is an **optional, separately-gated extension that
  defaults off**. Rationale: widest product surface, least liability, and — decisively — a system
  that never custodies funds cannot be tilted into ruin, so the §9.8 catastrophic-risk profile
  becomes opt-in rather than default. This collapses the old three-way ship/publish/trade fork into
  a lighter business-packaging choice that no longer changes the safety architecture.
- **Paper review declared done** for now. It stays a living document — refined as data and findings
  arrive, via this log.

**Changes**
- **Trade-flow attention model promoted into the main paper as §4.4** (System Architecture), with
  the identification limit as §9.10 and the old feasibility-honesty section renumbered to §9.11.
  Dual backbone (multivariate Hawkes → interpretable λ_buy(t) "attention chart" with branching
  ratio *n* as an attention-momentum scalar; causal self-attention transformer as the cross-token
  learned encoder), a mandatory manipulation-suspicion channel, and three wire-in points (flow-tier
  encoder, independent convergence signal, standalone alert). Full standalone development retained
  as the companion [`subprojects/trade-flow-attention.md`](./subprojects/trade-flow-attention.md).
- Charter §6 and README banner rewritten from "decision pending" to "resolved: signal-first."
- Workspace re-synced to the live paper: `00-paper.md` refreshed, `subprojects/` added.

**Findings (reasoning, not yet data)**
- The attention model's core honest limit is structural: **self-excitation is not identifiable from
  a common exogenous driver using flow alone** (§9.10) — a rising base rate μ(t) and a high
  branching ratio *n* are near-substitutes in the Hawkes likelihood, and wash trading manufactures
  exactly the self-exciting tape the model reads as attention (Cong et al. estimate >70% of reported
  volume on unregulated venues is wash). Hence the mandatory authenticity channel; hence "attention
  intensity is measured, genuine-crowd interpretation is corroboration-dependent, never an identity."

**Open**
- Business-packaging choice (signal-as-feature vs published-research+API vs private) — now lower-stakes,
  can wait until ~Phase-2 gate.
- Everything downstream of Phase 0 still gated on the one empirical question (charter §2): does a
  durable, cost-surviving, out-of-sample edge in new pairs actually exist?

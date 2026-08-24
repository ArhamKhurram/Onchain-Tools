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

## 2026-08-24 (vi) — Trade-replay data layer: trade-log substrate, on-demand trace builder, curated showcase

The data layer for the trickshot-style replay browser: pick any actor — an archive champion or a
harvested census wallet — and watch exactly what it did on a token's chart, trade by trade. Since
"replay" ultimately means every trade of every actor (potentially 100k+ (actor, token) pairs), the
core is a scalable substrate + a request-time builder, NOT pre-rendered files per pair.

**Changes**
- New `traces/` package (contract in [`replay-trace-schema.md`](./replay-trace-schema.md), sibling
  of the desk-telemetry contract):
  - `schema.py` — the pure `replay-trace/v1` contract: one `TradeRow` per TRADE (never per hold),
    nulls mean "source didn't carry it" and are never imputed; shape-preserving price downsampling
    (first/last + per-bucket extremes always survive) with trickshot's honest sampling label
    (`downsampled: true` + method string) carried into every trace.
  - `log.py` — `TradeLogStore`: append-friendly parquet trade log + actors index, ONE segment file
    per producing run (whole-file atomic, idempotent re-writes, readers lazily scan `*.parquet`) —
    a future training/eval run appends by importing the writer; no trainer was modified. Plus the
    cached `mint_index.parquet` (mint → pools) that keeps request-time builds off dataset scans.
  - `record.py` — recording rollout for any `EnvPolicy` (same loop/trade criterion as the eval
    runner); a truncation-forced liquidation surfaces as one synthetic `close` row carrying the
    episode's true realized total (quote left null — never itemized, never fabricated).
  - `wallets.py` — full-cohort exporter: the census wallets' real captured swaps ARE the log;
    per-trade `realized_cum` from an incremental FIFO with exactly the census engine's rules
    (unit-tested to land on `fifo_pair_pnl().realized_pnl`; uncosted transfer-in sells excluded).
  - `agents.py` — deterministic champion re-eval from a MAP-Elites checkpoint (genome → the exact
    eval policy; dims inferred from weight shapes; two checkpoint-compat shims: `__main__`-pickled
    classes, and pre-attention `RunningNormalizer` instances migrated onto the current class).
  - `build.py` — the on-demand tier: `build_trace(actor_id, mint)` + CLI to stdout; chart from the
    mint's BUSIEST pool (trickshot's convention), all the actor's trades overlaid.
  - `curate.py` — the bounded tier-3 JSON showcase both exporters share (per-actor token cap
    against hyperactive bots; group dirs regenerated from scratch).
- Tests: `tests/test_replay_traces.py` (11) — schema round-trip, downsampling extremes-preservation,
  FIFO equivalence vs the census engine, seeded-recording determinism + forced-close honesty, and
  store→builder end-to-end on a synthetic mini dataset. Suite green; ruff clean; no new mypy errors
  (a pre-existing baseline of torch-typed errors in 10 untouched files remains).

**Findings (real export, `data/replay_traces/`, fully regenerable — commands in the schema doc)**
- **Trade log: 50,344 rows / 1.52 MB parquet.** Census winners 32,170 rows (200/200 wallets, 7,869
  (wallet, token) pairs, 3,272 mints, 1.6 s), losers 15,512 rows (200/200, 3,722 pairs), and 2,662
  agent rows from re-running all 6 niche champions of `mapelites-800.ckpt.pt`
  (run `mapelites-2026-08-24-seed0`) on 8 held-out snap800 tokens each (381 s, 1 torch thread, CPU).
- **On-demand builder is ~0.02–0.05 s per (actor, token)** — busiest real wallet pair (246 trades,
  7,703-print tape → 500 points) and busiest champion pair (1,765 steps) both build well under the
  2 s budget, so no request cache is warranted. Actors index: 406 actors. Curated showcase: 227
  trace JSONs, 5.8 MB (top-10 winners ≤24 tokens each + all champion pairs).
- **The champions' replay behaviour matches the 08-24 (ii) verdict**: 2 of 6 never trade, the
  NOODLE (high-turnover) champion burns −1.80 SOL of paper across 2,481 fills, and archive-positive
  niches replay flat-to-negative on fresh held-out tokens — the replay layer makes the
  lottery-shaped profile *watchable*, which is its job.
- Provenance: our price series start from Pinax-decoded swap rows — one level above trickshot's own
  data acquisition (it derives prices from raw per-pool balance deltas; Pinax pre-decodes that).

**Open**
- The replay-browser viz itself (next task): actors index + `curated/index.json` are its browsing
  manifest; the on-demand CLI is its per-click backend (stdout JSON — a subprocess shim suffices).
- Wallet `bal_after` stays null by design; if the viz wants an equity overlay for wallets, it can
  plot `realized_cum` (already per-trade).

## 2026-08-24 (v) — Improvement loop implemented: post-mortem queue + trial harness; Audit Round 1

The §07 adoption is now code. All three transferable pieces from `07-improvement-loop.md` landed:
the read-only post-mortem module (rung 1 of the autonomy ladder), the pre-registered trial-runner
harness (rung 2, built but idle until the 800-run releases the machine), and the audit-round
ritual's first numbered entry. Nothing here can write to a config, trainer, or checkpoint — the
suggestion queue and the trial verdicts are records the operator acts on by hand.

**Changes**
- New `research_loop/` package (pure, torch-free, strict-mypy clean):
  - `postmortem.py` — reads `data/desk_telemetry/*.json` (schema-tolerant, read-only), computes
    cross-run findings (coverage trajectories, champion stagnation, win-rate shape, admission-tally
    presence — every finding cites files + numbers), and emits **bounded knob suggestions** into
    `data/postmortem/queue.jsonl` (append-only, idempotent by content id). The knob vocabulary is a
    closed set (`KNOB_BANDS`): 11 existing CLI flags across map_elites / pbt / admission, each with
    a conservative declared band bracketing its default; an out-of-band or unknown-knob proposal is
    refused at construction (`OutOfBandError`) — mechanism proposals are structurally impossible.
    Operator gate: `--list` / `--accept ID` / `--reject ID --reason ...` record decisions in the
    queue and do nothing else.
  - `trial.py` — incumbent-vs-challenger config A/B with the keep/revert criterion **pre-registered
    in the spec** (JSON: trainer, shared base flags, the ONE knob flag that differs, clause list +
    criterion text written before any arm runs). Runs both arms sequentially (subprocess,
    thread-capped), reads both outputs (population trainers: final-generation telemetry;
    train_market: parsed rung-report log), applies the clauses mechanically, appends a KEEP/REVERT
    recommendation record to `data/postmortem/trials.jsonl`. `--dry-run` validates + prints the two
    commands without executing — used today while the 800-run owns the GPU.
- `scripts/audit/fifo_recheck.py` — the Audit Round 1 script (see below), reusable for later rounds.
- Tests (29 new, all green with the full suite at 543 passed): band enforcement (out-of-band /
  unknown-knob / fractional-integer rejected), suggestion rules on synthetic telemetry (collapse →
  exploit_frac, stagnation → mutation_sigma, healthy runs → zero suggestions), queue idempotence +
  accept/reject round-trip + double-decision refusal, trial spec validation, mechanical KEEP and
  REVERT cases on mocked telemetry, ladder-report parsing, dry-run CLI, and the audit recheck logic
  on synthetic tapes (closed-pair net-flow equality, oversold/uncosted, partial-close residual,
  injected-bug detection).

**Findings (first real post-mortem, over all 8 desk-telemetry runs)** — 2 suggestions emitted,
both pending in `data/postmortem/queue.jsonl`:
- `pm-d6e3659866` — **pbt.exploit_frac 0.25 → 0.15** (band [0.05, 0.5]). Evidence:
  `pbt-2026-08-23-seed0.json` coverage decayed monotonically 0.667 → 0.333 over 6 generations
  while mean pnl rose +68.9 → +660.2 bps (homogenization from the exploit-copy step, not failure
  to train); all 7 map-elites runs held or grew coverage over the same data.
- `pm-7fffd9d376` — **map_elites.mutation_sigma 0.05 → 0.08** (band [0.01, 0.15]). Evidence: 4 of
  6 mature (≥6-gen) map-elites runs are stagnant — ≤2 post-seed best-pnl improvements with a
  trailing flat tail ≥4 gens (the 400-agent run: **zero** improvements in 11 post-seed
  generations). Rationale notes the chart-only line is closed: this targets the *next* population
  pass (the attention-features arm), and should go through the trial harness first.
- Non-knob observations (reported, deliberately not suggested): champion win rates in the final
  generation are below 0.25 in 7 of 8 runs (the lottery shape behind the NO-GO — no knob fixes
  that), and **no run's telemetry carries the ruined/curve_rejected tallies** — including the
  in-flight 800 run — so admission-gate hit rates can't be audited from telemetry yet; worth a
  look at the writer path before the next gated run.

**Audit Round 1 — census FIFO realized-PnL engine vs independent recheck (2026-08-24)**
- **Checked:** `data/census/fifo.py` via 3 real snap800 wallets (mid-size, non-suspect,
  deterministically spanning the PnL range: `Bgsn..v2EJ` −25.6 SOL, `2B93..na2Z` ~0,
  `22vL..VyjL` +112.6 SOL — the census's top winner). Raw trades rebuilt read-only from the pool
  parquets through the shared normalizer (the FIFO engine is the isolated variable), then
  recomputed by a lot-free quantity-conservation walk + net-quote-flow on fully-closed,
  fully-costed pairs; structural fields (counts, quote_in, residual_base, uncosted_sell_quote)
  cross-checked on every pair.
- **Result: AGREEMENT.** 71 (wallet, token) pairs audited, 45 fully-closed+costed pairs hit the
  exact net-flow check — engine realized PnL matches to float tolerance on all of them
  (−25.633691 and +112.586395 SOL reproduced independently); zero discrepancies on the structural
  checks; **0 timestamp-tie buy/sell adjacencies** in the audited set (the one known
  order-ambiguity risk didn't occur here — worth re-counting on a bigger sample in a later round).
  Nothing broke; nothing to fix or file. Summary artifact: `data/audit/round1_fifo_recheck.json`.
- Round count for this subsystem: **1**.

**Open / next**
- First real trial, post-800 (spec already dry-run-validated at
  `data/postmortem/specs/trial-mutation-sigma-0.08.json`, pre-registered criterion: KEEP iff
  challenger best_pnl_bps > incumbent AND coverage >= incumbent, same snapshot/seed/budget):
  `.venv-cuda\Scripts\python.exe -m oct_trading_agent.research_loop.trial --spec data/postmortem/specs/trial-mutation-sigma-0.08.json`
- The two pending suggestions await the operator's `--accept`/`--reject`.
- `make typecheck` is red at the pre-existing branch baseline (50 errors in 10 untouched
  torch-facing files, surfaced by torch being present in the uv venv); the new code contributes
  zero of them. Lint and the full test suite are green.

## 2026-08-24 (iv) — Wallet census: a data-driven gene pool harvested from the captured tape

The §9.3 cohort-selection caveat now has its designed answer. Until today the imitation cohort was
**operator-chosen and balance-ranked** — the paper flags that as the honest weakness of the Phase-2
warm-start. The new `data/census/` module harvests cohorts **from the data itself**: every one of
the ~1.26M captured swaps carries its `signer`, so the same snap800 capture that feeds the replay
env is a wallet census waiting to be taken (the operator's "top/bottom 25% of every token we run
through" gene-pool idea, disciplined by the HALO/satsmonkes rule: rank by REALIZED PnL aggregated
ACROSS tokens, never single-token peaks).

**Changes**
- `data/census/fifo.py`: per-(wallet, token) FIFO realized-PnL engine. Buys push lots; sells match
  oldest-first; partial lots split; **unclosed inventory is never profit** (it surfaces only as the
  holder dimension: residual base + residual cost). Sell proceeds with **no cost basis** (tokens
  that arrived by transfer/airdrop) are EXCLUDED from PnL and tallied separately — deliberately
  stricter than the BC-demo reconstruction, because a *ranking* that credits cost-free proceeds
  would crown funder-transfer dumpers.
- `data/census/crawler.py`: polars scan of a dataset's `pools/*.parquet` (READ-ONLY) → WSOL-paired
  legs only, fills of one signature collapsed into one economic trade (route splits otherwise
  poison the wash heuristics), then one numpy pass → per-pair stats.
- `data/census/cohorts.py`: within-token percentile rank of realized PnL (tokens with ≥8 wallets);
  **winners** = ≥N (default 3) top-quartile placements each with positive realized PnL; **losers**
  mirror it (bottom quartile, negative); **holders** = top net-accumulators by residual cost, a
  separate dimension tagged distinctly because their PnL is largely unrealized; one-token wonders
  recorded + flagged, never cohorted. **Wash/sybil filter** excludes flagged wallets into a
  `suspects` bucket with reasons: ping-pong (≥20 trades, alternation ≥0.8, buys-only size CV
  ≤0.05), metronomic inter-arrival (gap CV ≤0.15), single-token hyperactivity (≥100 trades on a
  sole token), and machine-scale window volume (≥2,000 trades in snap800's ~7h window — the
  multi-token arb/MEV shape the first three miss; the first census run's "top winner" was a 171k-
  trade, 6.5-trades/second bot, which forced this fourth flag).
- `data/census/loader.py`: the gene-pool seam. Exports are in the **operator-export shape**
  (`parse_tracked_wallets` reads them unchanged; `fundingInfo.nativeBalance` carries the census
  ranking score, so `select_cohort`'s "top by balance" becomes "top by cross-token realized PnL").
  Plus an **offline** path that rebuilds each cohort wallet's `LabeledWallet` straight from the
  capture parquets — BC without re-pulling Pinax.
- Outputs under `data/wallet_census/` (new, gitignored): `census_pairs.parquet`,
  `census_wallets.parquet`, `winners/losers/holders/suspects.json`, `summary.json`.
- Tests: `tests/data/test_wallet_census.py` — FIFO correctness (partial closes, oldest-first,
  unrealized-never-profit, uncosted-sell exclusion), fill collapsing, cross-token cohort
  assignment, wash exclusion, one-token-wonder flagging, and export round-trip through the
  operator-export parser into `build_trajectories`.

**Findings (snap800, first real census — window ≈ 7.3h of live capture)**
- 1,262,891 swaps → 339,863 (wallet, token) pairs, **94,367 wallets**, 14,897 tokens (4,024 with
  enough participants to rank). Cohorts at N=3, cap 200: **200 winners, 200 losers, 200 holders,
  60 suspects** (30 ping-pong, 19 single-token hyperactive, 15 machine-scale, 6 metronomic;
  overlapping), **11,561 one-token wonders** — the quantified case for the repeated-quartile rule.
- Top winners after wash-filtering look genuinely imitable: e.g. `22vL..VyjL` +120.4 SOL realized,
  top-quartile on 22/23 ranked tokens, consistency 0.96, 85 trades; `CyaE..a54o` +116.5 SOL over
  71/114, 735 trades. Their offline-rebuilt histories reconstruct to full win-AND-loss trajectory
  sets (23W/3L, 81W/45L) — no survivor-filtering.
- **Limits, stated plainly:** the wash filter cannot catch fresh-wallet sybils (one entity across
  many organic-looking signers), cross-wallet wash rings, or fully-laundered cost bases (the
  uncosted-sell exclusion blunts, does not eliminate, transfer laundering). And a 7-hour window is
  a *within-window* census — the HALO 30d-realized discipline needs the longer capture the live
  recorder is accumulating.

**Decisions**
- **Punishment cohort, first honest uses only:** losers flow through the SAME BC pipeline so
  loser-clones can serve as **eval-baseline floors** (an admitted agent must beat the loser
  replay). Naive "invert the losers" is NOT implemented — inverting a losing strategy still pays
  spread/fees/impact both ways. GAIL-style winner-vs-loser discrimination is deferred to the
  wallet-flow tier.
- Post-800 orchestrator invocation to clone the winner gene pool (offline, no network):
  `run_cohort_imitation(load_cohort_wallets("data/wallet_census/winners.json",
  "data/market_dataset_snap800", max_wallets=40))`; the live-pull equivalent is the existing CLI:
  `python -m oct_trading_agent.agent.imitation.cohort --wallets-file data/wallet_census/winners.json`.

**Open**
- Re-run the census on `market_dataset_large` (and the growing live capture) once the 800-run
  finishes; longer windows unlock honest hold-time styles and a real 30d-realized ranking.
- Style labels per cohort wallet (the HALO per-wallet personality tags) can be derived from the
  census stats (hold time, consistency, size dispersion) — feeds the 54-cell grid seeding.

## 2026-08-24 (iii) — Trade-flow attention features wired into the observation (tier-A+ ablation ready)

The §4.4 attention model's Hawkes backbone now feeds the AGENT, not just the standalone alert: the
three-scalar attention state — λ_buy(t)/μ_buy (the baseline-normalized attention chart), the
branching ratio n (attention momentum), and the MANDATORY manipulation-suspicion score — is wired
as an optional tier-A+ observation block behind one flag. The motivating question, post the (ii)
chart-only NO-GO: does a richer endogenous-attention representation of the SAME tape (no wallet
resolution needed — trade timestamps only) change anything, BEFORE wallet flows are unlocked?

**Changes**
- `agent/encoders/tracker.py` (new): `HawkesAttentionTracker` — causal, per-token,
  **stride-refit** wrapper over the existing EM Hawkes fit (`encoders/hawkes.py`) + suspicion
  channel (`encoders/manipulation.py`). Refit grid is by event COUNT (`min_events=20`, then every
  `refit_stride=10` events); between grid points the cached parameters are re-evaluated over the
  events seen so far, so λ(t) stays event-fresh. Fits cache across env resets — a token's whole
  training run pays each fit once. `features_at(as_of)` is a pure function of the causal prefix
  (unit-tested: full vs truncated tape agree at t, on synthetic AND real tapes).
- Observation: `ATTENTION_SLOTS` appended after the tier-A block when `EnvConfig` /
  `MarketTrainConfig(attention_features=True)`; obs grows (B,15)→(B,21). The three slots share ONE
  mask state — λ/n are never observable without their suspicion companion (§9.10), and all three
  are masked-missing before the fit window (honest cold start, §8.6). Flag OFF = byte-identical
  observation (regression-tested); every running config is untouched.
- Plumbing: `--attention-features` on `train_market.py` and `population/map_elites.py`;
  `ActorConfig.d_in` sizes the net from the widened vector; `RunningNormalizer` now pins its block
  widths from the first observation (shape-mix raises). n ≥ 1 is REPORTED (flagged `explosive`),
  never silently clipped.
- Smoke proof on 10 real snap800 tokens (read-only): fits converge on tapes from 94 to 2,709
  swaps; λ/μ ∈ [1, 86], n ∈ [0.25, 0.87] with two honest transient n≥1 flags on a hot early tape;
  suspicion ∈ [0.22, 0.45]; a tiny PPO step runs flag-on (d_in=21) in ~2s.

**Decisions**
- Suspicion at this tier is the pure-flow blend (Benford, round-number, breadth deficit, buyer
  concentration) computed on the refit stride. **What it cannot catch, stated plainly (§9.10):** it
  resolves NO wallets — a sybil splitting one entity across fresh signers with organic-looking
  sizes defeats it, and self-excitation is not identifiable from a hidden common driver using flow
  alone. A high λ/n reading with low suspicion is a corroboration-dependent hypothesis, never an
  identity; the features are inputs the agent may learn to weigh, not a detector.
- The built-but-unwired GELU transformer (`encoders/transformer.py`) stays the **Phase-2 encoder
  seam** — this task wired the interpretable Hawkes teacher only; the learned student (and
  codependent training, §6.4) comes after the ablation says the tier is worth it.

**Open**
- The actual chart+attention ablation (flag-on vs flag-off ladder on the same tokens/seeds) runs
  AFTER the 800-agent MAP-Elites run finishes — one flag, same harness. If it moves nothing, the
  honest outcome is recorded and the tier stays off.

---

## 2026-08-24 (iii) — QD selection layer hardened: survival gate, loss-discipline gate, 54-cell style grid

Operator-directed upgrades to the archive/selection semantics (selection only — the DSR reward is
untouched; `envs/reward.py` off-limits by design).

**Decisions**
- **Hard survival gate.** An agent whose held-out realized equity path breaches the ruin floor
  (default: min equity ≤ 0.2 of the starting risk budget, i.e. lost 80%) is inadmissible — it never
  holds a MAP-Elites niche, never crowns a PBT niche champion, and is never a PBT exploit source (it
  is instead always reseeded). Counted in telemetry (`ruined`, additive field).
- **Curve gate = loss DISCIPLINE, not shape.** Mid-build refinement from the operator: in this
  fat-tailed market a flat-or-bleed-then-sudden-step-up equity curve is the legitimate positive-skew
  (barbell) profile, so no smoothness/monotonicity/ulcer score exists anywhere in the gate. What IS
  gated: **max drawdown depth** (deepest peak-to-trough retrace of previously-held equity, default
  ≤ 0.5 budget units — duration-agnostic, so plateaus and ranges cost only their depth) and **loss
  escalation** (tail-half vs early-half mean realized-loss size ≤ 3.0 — the martingale doubling-down
  signature; computed only once ≥ 8 losses exist). Thresholds deliberately LOOSE: with 40–300
  held-out tokens a genuine rare-event strategy may catch only 1–2 runners per window, and tighter
  gates would false-negative real skill. **Known false-negative risk:** a true barbell agent whose
  rare win lands EARLY and then bleeds a long tail can still show a large "drawdown" from that peak;
  0.5 budget-units of headroom is the loose compromise, revisit against real run data.
- **Luck-vs-skill diagnostics are recorded, never gated.** Each champion now carries
  `pnl_share_top` (single best episode's share of total pnl) and `pnl_split_bps` (mean pnl over the
  first vs second half of the held-out episode sequence — time-disjoint under the walk-forward
  ordering), so concentration/repeatability can be judged across runs without filtering rare-event
  styles out.
- **Fine 4-axis style grid, 6-role projection preserved.** Descriptor grew two behavioral axes:
  entry-size style (mean buy size fraction: SMALL < 0.15 ≤ MID < 0.5 ≤ FULL) and exit style (mean
  fraction of position per exit: CLIP ≤ 0.25 < CHUNK < 0.75 ≤ FULL; an agent with no self-driven
  exits realizes its book in one forced close ⇒ FULL). Full space = 3×2×3×3 = **54 cells**
  (`bin_style_cell`, `"ROLE:ENTRY:EXIT"`); the coarse 3×2 role grid (`bin_descriptor`) is untouched
  and the desk console keeps its 6 desks — the fine cell rides only as the additive champion field
  `style_cell`.

**Changes**
- New `agent/population/admission.py` (pure, torch-free): `AdmissionConfig` + `admission_verdict`.
- `descriptor.py`: realized-equity/loss/entry-size/exit-clip streams collected in
  `behavioral_rollout`; `CurveMetrics` (+ `equity_curve`/`max_drawdown`/`loss_escalation_ratio`)
  on every `BehaviorProfile`; style-cell binning. `archive.py`: `NicheArchive` excludes
  inadmissible agents from occupancy/champion/best (preserving the occupancy>0 ⇒ champion
  invariant) and tallies them. `map_elites.py`: `EliteArchive` gates `try_add` unconditionally
  (gate ON by default), counters checkpointed, CLI flags `--ruin-floor` / `--max-drawdown` /
  `--max-loss-escalation`. `pbt.py`: `select_exploit_explore` takes an admissibility mask.
  `telemetry.py` + `desk-telemetry-schema.md`: additive generation fields (`ruined`,
  `curve_rejected`) and champion fields (`style_cell`, `final_equity`, `max_drawdown`,
  `loss_escalation`, `pnl_share_top`, `pnl_split_bps`) — the 6-role contract validates unchanged.
- Tests: `tests/test_population_admission.py` (gate invariants, barbell-passes/deep-retrace-fails,
  martingale rejection, style binning, exploit-mask, additive-telemetry validity) + a scripted
  clip-policy rollout test in `test_population_descriptor.py`. Full suite green; ruff clean; mypy
  at branch baseline (no new errors; fixed the `**dict` config-expansion typing the new config
  field surfaced in `test_population_checkpoint.py`).

**Findings**
- Tiny smoke (init 4 / iters 4, `market_dataset_snap800`, CPU, 1 torch thread, gates on defaults):
  ran end-to-end, telemetry schema-valid; 8 evaluations → 5 admitted, **1 curve_rejected (the
  discipline gate fired live on a real random-seed agent), 0 ruined**; coverage 0.17 → 0.67 and
  monotone, so the gate coexists with the anti-collapse property.

## 2026-08-24 (ii) — OVERNIGHT VERDICT: chart-only has no durable edge — two independent methods converge

The synthesis of the overnight escalation campaign. This is the program's most important result to
date, and it is a **negative** one, delivered exactly the way the charter said a "no" should be.

**Findings**
- **MAP-Elites escalation (four GPU runs, populations 12 → 100 → 200 → 400 agents on 131 → 987 →
  1,312 → ~2,600 tokens;** `data/desk_telemetry/mapelites-gpu-{large,huge,mega,400}-seed0.json`):
  coverage reached and held **1.000 (6/6 niches)** in every run — the anti-collapse property proven on
  the small run scales cleanly. But the *performance* story is the finding:
  - **Best-niche held-out pnl BOUNCES with scale, trendlessly: +130.3 → +7.2 → +3.0 → +90.4 bps.**
    That bounce is not signal — it is lottery variance on fat-tailed survivor tokens (a bigger
    population buys more tickets and sometimes holds a luckier one).
  - **The invariant across ALL four runs is the win-rate distribution: champion win rates 0.00–0.22,
    mostly ≤0.10, in every niche of every run.** A profile of rare large winners carrying a mean —
    lottery-shaped, not skill-shaped. No niche, at any scale, learned to win often.
- **Independent confirmation — the single-agent PPO token-count ladder** (rungs 10 / 100 / 149; the
  1,000-token rung truncates to the 149 trainable ≥24-swap tokens the base dataset holds): **NO-GO at
  every rung.** Held-out edge vs hold-SOL shrank toward zero as tokens grew — **+0.60 (noise) →
  +0.074 → +0.0023** — and went **negative vs buy-and-hold at 149 tokens**. More data made the honest
  number smaller, which is what "no edge" looks like when variance stops flattering you.
- **Two independent methods — QD population search and single-agent PPO — arrive at the same verdict:
  price-chart-only trading has no durable edge after 125 bps modeled costs.** This extends the
  2026-08-23 (e) 24-token NO-GO to every scale we can currently reach, and it **confirms the paper's
  curriculum hypothesis rather than refuting the program**: the edge, if it exists, must come from the
  information tiers (wallet flows → metadata → narrative/social), not from the chart. Phase B is the
  pre-registered next step, and it is now the *only* justified next step.
- **Live capture shipped and ran overnight** (`data/capture/` — Pinax WS `solana@swaps` firehose →
  the resumable `MarketSwapDataset` store; `tests/data/test_live_capture.py`): the overnight store
  (`data/market_dataset_large`) holds **23,310 fresh tokens / 2.30M swap rows**, but only **6,046
  (~26%) clear the ≥24-swap trainable-depth floor**, and the median token prints only a handful of
  swaps (2 in the smaller probe, 5 in the overnight store) — **most launches are stillborn.** The
  higher ladder rungs are a capture-duration problem now, not a code problem — but "100k tokens"
  really means "100k mostly-dead tokens" unless the floor is applied first.

**Decisions**
- **Win-rate shape, not best-PnL, is the primary read on population runs.** Best pnl_bps on
  fat-tailed survivor tokens is a lottery draw (it bounced 130 → 7 → 3 → 90 across scales); the
  win-rate distribution is what stayed invariant and carried the verdict. Folded into
  `05-evaluation-plan.md` as a field note — the mirror image of its existing "hit-rate is never
  reported alone" rule.
- **The Phase-1 / chart-only line is closed as NO-GO.** No more chart-only scaling runs unless a
  future claim can clear the win-rate bar; compute moves to the wallet-flow tier (Phase B), where the
  BC seam (85% held-out intent accuracy — behaviour cloned, profit explicitly unmeasured) is the
  warm start.

**Changes**
- Docs brought current: `00-paper.md` gains an empirical addendum (§12) carrying these results with
  caveats attached (plus status notes on §9.11 and the §10 roadmap); `03-experiment-plan.md` Phase 1
  marked answered-NO-GO and Phase 2 marked machinery-landed; `05-evaluation-plan.md` gains the
  best-PnL-is-a-lottery-draw field note.

**Open**
- The 400-agent run's +90.4 bps is the standing reminder that scale does not monotonically shrink the
  lottery — larger populations find luckier tickets. Any future chart-only positive must show a
  win-rate distribution that isn't lottery-shaped before it is believed.
- The cloned cohort's own profitability (replayed at our costs, per the `tracked_traders` baseline)
  is still unmeasured — it is the natural bridge between the Phase-2 imitation work and the Phase-B
  gate, and the next heavy run to schedule.
- Capture keeps running; the trainable-depth floor (~26%) sets the real token-accumulation rate for
  the upper rungs (~6k trainable per 23k captured).

## 2026-08-24 — Checkpoint + resume: overnight population runs survive interruption

**Decisions**
- **One atomic-write primitive, reused everywhere.** New torch-free `agent/population/checkpoint.py`:
  `atomic_write(path, write_fn)` fills a sibling temp file and `os.replace`s it into place (atomic on
  POSIX *and* Windows), removing the temp on failure — so a kill mid-write can never truncate a good
  checkpoint or the telemetry JSON. `atomic_write_text` backs the telemetry flush; `save_torch` /
  `load_torch` (lazy torch import, `weights_only=False`) back the trainer checkpoints. The telemetry
  writer now flushes atomically and accepts a `generations=` seed so a resumed run CONTINUES the growing
  viz timeline instead of restarting it at gen 0.
- **Checkpoint = enough state to reproduce the uninterrupted run, saved every N.** Each trainer persists
  its archive/population + the loop counter + all three RNG streams (numpy `Generator`, numpy legacy
  global, torch) + the telemetry timeline. Resume restores those and continues from the exact step, so a
  killed run loses at most `--checkpoint-every` units of work, not the whole run.

**Changes**
- **MAP-Elites** (`map_elites.py`): `MapElitesCheckpoint` + `save_/load_map_elites_checkpoint`;
  `EliteArchive.restore(elites, considered, admitted)` (pure inverse of what's saved). `run_map_elites`
  gains `--checkpoint-every N` (evaluations), `--checkpoint-path`, `--resume`; the seed/illumination
  loops resume from `seed_done`/`iter_done`. The old post-loop "trailing partial batch" flush folded into
  an `is_last` flush inside the loop (behaviour-preserving, resume-safe).
- **PBT** (`pbt.py`): `PBTMemberState` / `PBTCheckpoint` + `save_/load_pbt_checkpoint` +
  `_rebuild_member`; `run_pbt` gains the same three flags. Checkpoints AFTER exploit/explore with
  `gen = next generation`, so resume starts the next generation from the post-exploit population. (The
  Adam optimizer is intentionally NOT persisted — a resumed member gets a fresh trainer, matching how
  exploit already rebuilds it at a generation boundary.)
- **Ladder** (`train_market.py`): `RungTrainState` (mid-rung: weights + optimizer + iteration + RNG) and
  `LadderCheckpoint` (completed rungs + warm-start weights + any in-progress rung). `train_market_policy`
  gains `resume_state` / `on_checkpoint` / `checkpoint_every` — a single 1000+-iter rung now checkpoints
  every N iterations and resumes at its iteration (the entropy schedule is a pure function of the
  iteration, so it needs nothing extra). `run_ladder` gains `--checkpoint-every`, `--checkpoint-path`,
  `--resume`: completed rungs are skipped, an interrupted rung continues, and per-rung `.pt` saves are
  now atomic. `PPOTrainer.optimizer` exposed so the state can be persisted/restored.

**Findings** (gates, on `.venv-cuda`)
- ruff clean; strict mypy unchanged at the 50 pre-existing torch-installed errors (torch-distribution
  stub noise) — **none in any touched/added file**; pytest **471 passed, 3 pre-existing skips** in ~25s.
- Resume is proven, not assumed: a MAP-Elites run stopped after 1 illumination step and resumed to 3 runs
  exactly the 2 remaining evaluations (a restart would re-run 5); the same for PBT at generation
  granularity (4 train calls, not 6) and for a mid-rung `RungTrainState` (one remaining iteration, not
  two). Atomic-write is tested against a simulated mid-write crash (original file intact, no temp litter).

**Open**
- Recommended resume commands (checkpoint path defaults to `<out>.ckpt.pt`, ladder to
  `<checkpoint-dir>/ladder.ckpt.pt`):
  - MAP-Elites: add `--checkpoint-every 8` to the launch; resume with
    `... map_elites --dataset data/market_dataset --resume <out>.ckpt.pt --iterations <same-or-larger>`.
  - PBT: `--checkpoint-every 1`; resume with `... pbt --dataset ... --resume <out>.ckpt.pt`.
  - Ladder: `--checkpoint-dir <dir> --checkpoint-every 50`; resume with
    `... train_market --dataset ... --checkpoint-dir <dir> --resume <dir>/ladder.ckpt.pt`.
- The in-flight 100-agent GPU MAP-Elites run predates this and has no checkpoint; the NEXT overnight
  launch should add `--checkpoint-every`.

## 2026-08-23 (v) — GPU device support: training now actually runs on the RTX 3080

**Decisions**
- **One device seam, no scattered `.cuda()`.** A single `resolve_device(spec)` helper
  (`agent/device.py`) maps `auto|cuda|cpu` → a `torch.device` (`auto` = cuda iff
  `torch.cuda.is_available()`, else cpu; explicit `cuda` with no GPU raises rather than silently
  degrading). The device is chosen ONCE at the CLI and threaded into model construction
  (`build_actor_critic(..., device=...)`). Every downstream tensor-building site — rollout collection,
  the PPO update, the eval `TorchPolicy` — reads the device back off the model's own parameters
  (`next(model.parameters()).device`), so there is exactly one place a device is picked.

**Changes**
- `--device auto|cuda|cpu` (default `auto`) added to the three entry points: `train_market`,
  `population/pbt`, `population/map_elites`. Threaded through `train_market_policy` / `run_ladder`,
  `_init_member` / `run_pbt`, and `_build_model` / `_random_genome` / `_polish_and_evaluate` /
  `run_map_elites` as a keyword-only `device` (default `None` = CPU, so every existing call and the
  CPU-only path are unchanged).
- Tensors move to the device at the numpy→torch boundary: `collect.py` (obs + truncation-bootstrap
  tensors), `ppo.py` (the six batch tensors + the minibatch index), `torch_actor.py`
  (`TorchPolicy.act` / `value_distribution`). Env/sim stay CPU-numpy; results already come back via
  `.cpu().numpy()`/`.item()`. Seeds (`torch.manual_seed`/`np.random.seed`/`random.seed`) untouched.
- Tests: `tests/test_device.py` — `resolve_device` mapping (auto/cpu/cuda via monkeypatched
  `torch.cuda.is_available`, junk raises, cuda-unavailable raises) and that a constructed model's params
  AND the critic's `taus` buffer land on the requested device (cuda assertion `skipif` no GPU).

**Findings** (real GPU smoke: tiny MAP-Elites, init_pop 4 / iters 4 / batch 4 on `data/market_dataset`)
- Proof it trained on the GPU: model param `is_cuda=True` (`cuda:0`) and critic `taus.is_cuda=True` at
  train time; `torch.cuda.max_memory_allocated() = 17,214,464 bytes (~16.4 MiB)` after the run (0 before).
- CLI paths all verified: `--device cpu` → cpu, `--device auto` → cuda (on the `.venv-cuda` box),
  `--device cuda` → cuda across `map_elites`, `pbt`, and `train_market` (rung 10 ladder completed, agent
  TRADES: 63 trades / 3-of-3 tokens).
- Gates: ruff clean; full pytest green on `.venv-cuda` (472 passed, 3 pre-existing skips); strict mypy in
  the canonical **lean** (torch-absent) config is unchanged at 35 pre-existing errors, **none in any of the
  8 touched/added files** (the ~50 errors mypy reports when torch IS installed are pre-existing
  torch-distribution stub noise on untouched lines, not from this change).

**Open**
- Full GPU MAP-Elites launch command (for the orchestrator):
  `.venv-cuda\Scripts\python.exe -m oct_trading_agent.agent.population.map_elites --dataset data/market_dataset --tokens 120 --init-population 24 --iterations 96 --batch-size 8 --device auto`.

## 2026-08-23 (iv) — MAP-Elites lands: diversity SURVIVES where PBT collapsed; roles renamed to goofy codenames

**Decisions**
- **Role vocabulary is now goofy codenames** (`GOBLIN/GREMLIN/GIZMO/NOODLE/PICKLE/GECKO`), replacing the
  functional names (`SNIPER/SCAN/WHALE/RUG/SHILL/EXIT`) that misled — "RUG" read as a rug-checker when it
  is just a niche label. The rename is **cell-for-cell** (the descriptor grid `trade_frequency ×
  mean_hold_secs` is unchanged), so PBT, MAP-Elites, and the viz stay comparable. Shared population code
  (`descriptor.py`, `telemetry.py`) carries the change; every consumer of `MEMECOIN_ROLES` follows.

**Changes**
- **MAP-Elites trainer shipped** (`agent/population/map_elites.py`): an `EliteArchive` holding one elite
  per behavioral niche, illuminated by sample-parent → mutate (Gaussian weight-perturbation +
  hyperparameter explore) → short PPO polish → held-out eval → try-take-cell. The cell-replacement rule
  (`elite_beats`): a challenger takes a niche iff it is **empty** or its held-out `pnl_bps` **strictly
  exceeds** the incumbent's — so a filled niche never empties and only ever improves (the monotonicity PBT
  lacked). Reuses the descriptor→niche seam, env/sim/eval, PPO update, policy, and telemetry contract
  verbatim; `DeskTelemetryWriter` gained an `algo` param so the file reports `algo:"map_elites"`. Archive +
  rule are pure/torch-free (unit-tested without `learn`); mutation/train/eval are `learn`-gated.
- Tests: `test_population_map_elites.py` (elite-replacement rule, niche stays filled once landed, coverage
  monotone, snapshot renders schema-valid, torch-gated mutate + smoke run). Existing population tests
  updated to the new role names. Full suite green (456 passed, 3 pre-existing skips); ruff + strict mypy
  clean on the touched files.

**Findings** (real run: `data/desk_telemetry/mapelites-2026-08-23-seed0.json`; 120 tokens, train=84/test=36,
init_population=12, iterations=48, batch_size=8, 1 PPO polish step, seed 0)
- **Diversity survived.** Coverage held **flat at 0.667 (4/6 niches)** across all 7 generations — it never
  fell. Contrast the PBT 24×6 run (`pbt-2026-08-23-seed0.json`), which started at the same **0.667 and
  COLLAPSED to 0.333** (four niches → two) as fitness pressure piled the population into `NOODLE`/`PICKLE`.
  MAP-Elites is archive-centric, so a niche once filled cannot be evicted — exactly the fix the program
  thesis demanded.
- **Champions improved per niche** (held-out bps, gen0→gen6): GIZMO −4.4 → **+23.2**, NOODLE +12.9 →
  **+63.7**, PICKLE −1.6 → **+48.4**; GREMLIN sat at 0.0 (its champion is a non-trader — the LOW-freq/
  SHORT-hold cell). 10 of 56 evaluated children were admitted.

**Open**
- Coverage **held but did not grow** past the seed's 0.667: the two SHORT-hold niches (`GOBLIN`, `GECKO`)
  stayed empty — mutation off long-hold parents never produced short-hold high/med-freq behavior on this
  data. To animate coverage *climbing* we'd want a lower-diversity seed and/or descriptor-aware mutation
  (biasing children toward empty cells). The anti-collapse property is proven; illuminating the last two
  cells is the next tuning pass. ES remains the other unbuilt population trainer.

## 2026-08-23 (iii) — Cohort backfill made survivable at scale: real backoff + per-wallet fault isolation

**Findings**
- The Phase-2 cohort pull (`imitation.cohort`) fell over at ~80 wallets: sustained load on the Pinax
  REST endpoint (`/v1/svm/swaps`) drove 429/5xx, and the client's old retry ladder was too weak to ride
  it out — capped at 10 s, no jitter, no `Retry-After` — so requests exhausted their retries and a hard
  failure could abort the whole run. An 8-wallet pull survived; 80 did not.

**Changes**
- **REST client backoff hardened** (`data/pinax_client/rest.py`): retryable failures (429, 5xx, and
  transient `OSError` connection errors) now get **exponential backoff with full jitter** — base **1 s**,
  ×2 per attempt, capped at **~30 s**, plus jitter in `[0, base)` — and **honour a `Retry-After`** header
  when present (integer-seconds or HTTP-date), ceiling-bounded at 120 s so a hostile value can't park the
  run. Default `max_retries` raised 4→**5**. Non-retryable 4xx (auth/not-found/bad-request) still **fail
  fast** — no wasted quota. New knobs surfaced on the client: `inter_request_delay_s` (deliberate pacing
  before each live request), `base_delay_s`, `max_backoff_s`, injectable `rng`/`now` for deterministic
  tests. `transport.py` now surfaces lower-cased response headers (needed for `Retry-After`); the field
  is optional so existing `HttpResponse(status, body)` fakes keep working.
- **Per-wallet fault isolation** (`imitation/cohort.py`): `load_cohort_from_pinax` now returns a
  `CohortPullResult` (`wallets`, `n_requested`, `skipped[(name, reason)]`). A wallet that still fails
  **after** the client's backoff is caught, counted, and **skipped — never fatal**; the run continues and
  reports the skips (`format_pull_summary`). `cohort_is_usable` is the exit-code contract: the CLI exits
  **0** with a summary when ≥1 wallet came back with trades, and only **exits 1** ("essentially nothing")
  when the pull is empty. Pacing/backoff knobs (`--inter-request-delay`, `--max-retries`, `--base-delay`)
  are now CLI flags with safe defaults. `train_market._load_cohort` updated for the new return type.
- **Tests** (mock the HTTP layer, never the real API): backoff schedule is exponential + jittered, gives
  up after N and raises, transient `OSError` retried-then-succeeds, non-retryable 4xx fails fast (one
  call), `Retry-After` respected; and cohort-level — a failing wallet is skipped-not-fatal, an all-skip
  pull is not-usable, a summary names the skips. `make check`: ruff clean, mypy clean on all touched
  files (pre-existing errors remain only in other agents' in-flight population/torch files), and the full
  pytest suite passes bar one unrelated pre-existing failure in `population/map_elites.py`.

**Open**
- Recommended safe invocation once Pinax is quiet: 80 wallets →
  `python -m oct_trading_agent.agent.imitation.cohort --wallets-file <export> --max-wallets 80 --max-pages 4 --inter-request-delay 0.5 --max-retries 6 --cache-dir .cache/pinax`;
  the full ~969-wallet roster → bump `--max-wallets 969` and lean on `--cache-dir` so reruns are free
  (raise `--inter-request-delay` to ~1.0 if 429s reappear). Not run live here — Pinax is under load from
  other jobs and hammering it is the exact failure mode this fixes.

## 2026-08-23 (ii) — Phase-D first pass: PBT population trainer + archetype-niche archive + desk telemetry

**Decisions**
- Stood up the **first real population trainer** (`agent/population/pbt.py`): PBT over N clones of the
  Phase-1 hybrid actor-critic, each with perturbed hyperparameters (LR, entropy coef, and the
  risk-weighting β — an explicit PBT dimension, paper §3.5.3-B). Fitness is the honest held-out-token
  pnl in bps, net of the sim's modeled costs — same eval discipline as the ladder. Reuses the env,
  sim, PPO update, and policy verbatim; nothing reinvented.
- **Exploit/explore rule:** each generation the bottom `exploit_frac` (default 25%) of the population
  by fitness copies a RANDOM top-`exploit_frac` member's **weights + observation-normalizer + hyperparams**
  (deep-copied so slots evolve independently), then perturbs the inherited hyperparams (×0.8/×1.2 for
  LR & entropy, additive jitter for β, all clamped). A slot that ranks both top and bottom (tiny-pop
  overlap) is left untouched.
- **Descriptor→niche mapping** (`agent/population/descriptor.py`) is a fixed, documented **3×2
  MAP-Elites-style grid** over the two axes the telemetry contract mandates — turnover
  `trade_frequency` (LOW `<0.08` / MED / HIGH `>=0.20` fills-per-step) × `mean_hold_secs`
  (SHORT `<90s` / LONG). Cells: (SHORT: SCAN, EXIT, SNIPER) / (LONG: WHALE, SHILL, RUG). The niche is a
  **pure function of the agent's own behaviour**, never hand-assigned; a non-trader (freq 0, hold 0)
  lands in SCAN. Extra axes (entry-latency, sell-ratio, mean-size) are recorded for flavour but don't
  bin — the clean seam a full CVT/adaptive MAP-Elites archive replaces later.
- **Archive accumulates from mini-batches** (`agent/population/archive.py`, operator steer): a
  `NicheArchive` keeps only per-niche **occupancy + one champion + a pnl summary** — the durable
  O(roles) state. A mini-batch of trained agents is binned in (`add_batch`) and dropped, so the
  resident set is one mini-batch, never the whole population. The trainer trains+evals in mini-batches
  and feeds the archive incrementally; this is what lets the population scale past memory.
- **Telemetry exporter** (`agent/population/telemetry.py`) renders the archive to the
  `desk-telemetry-schema.md` contract — per-niche aggregates only, `O(roles × generations)`, growing
  JSON re-written each generation. `cost_bps=125` declares the modeled-cost regime pnl is net of.

**Findings (real run — `--population 24 --generations 6` on `data/market_dataset`, 140 pumpfun_amm
tokens, held-out-by-token split, torch `learn` extra)**
- **Fitness climbed monotonically:** best `+692 → +995 bps`, population mean `+69 → +660 bps` across
  gens 0–5. Exploit propagated the winners as designed.
- **PBT ate the diversity:** coverage `0.67 → 0.33`; the population collapsed from a SCAN/WHALE/RUG/SHILL
  spread into RUG (23/24) + SHILL (1) by gen 5. This is the canonical "PBT maximizes fitness and
  destroys behavioural diversity" result — and exactly the motivation for the MAP-Elites archive the
  descriptor→niche seam is built for. Pure PBT is the fitness engine; QD is what preserves the ensemble.
- **Only LONG-hold niches filled** (SNIPER/EXIT/SCAN-trading stayed empty at convergence): full-life
  pumpfun_amm episodes drive multi-minute holds (champion `hold_secs` 400–960s), so no short-flip
  sniper archetype emerged under this reward/data. Honest, not a bug.
- **Caveat (honest):** pnl_bps are large-positive because long-only exposure on survivor pumpfun
  tokens is strongly positively skewed (win-rates are low, 0.08–0.17 — a few big winners carry the
  mean). Median-per-niche is reported alongside so the skew is visible. The dataset only holds tokens
  with `>=24` swaps (survivor bias), same as the ladder's denominator.
- Telemetry JSON validates against the schema; artifact at `data/desk_telemetry/pbt-2026-08-23-seed0.json`
  (gitignored `data/`).

**Changes (code)**
- New `agent/population/{descriptor,archive,telemetry,pbt}.py` + package `__init__` exports. Pure
  pieces (descriptor→niche, archive accumulation, telemetry aggregation, hyperparam perturbation,
  exploit/explore selection) are torch-free; training/eval is `learn`-gated exactly as the Phase-1
  learner. CLI: `python -m oct_trading_agent.agent.population.pbt --dataset … --population … --generations …`.
- 30 new tests (`tests/test_population_{descriptor,telemetry,pbt}.py`): grid binning, real-rollout
  descriptors, streaming-archive equivalence, schema-shape validation, hyperparam bounds/perturb,
  exploit/explore selection, torch-gated weight-copy + end-to-end smoke (all `importorskip` for torch).
- `make check`: ruff clean; mypy unchanged from baseline (50 pre-existing torch/test-stub errors, ZERO
  added); pytest **434 passed**, 3 skips (2 pre-existing CLMM-fixture, 1 reference-fixture-absent).

**Open**
- Pure PBT's diversity collapse is the headline gap: swap the fixed-grid archive for real MAP-Elites
  (elitism-per-niche selection, CVT/adaptive bins) so diversity is *preserved*, not just measured. The
  `NicheArchive` + descriptor seam is already the interface for it.
- Short-hold niches (SNIPER/EXIT) never populate under full-life pumpfun episodes; exercising them may
  need a shorter episode horizon or a reward that rewards fast flips — a data/reward question, not a
  trainer one.

## 2026-08-23 (i) — North-star baseline: score the agent against the tracked traders THEMSELVES

**Decisions**
- The operator's real bar is NOT "beat hold-SOL" — it is **"out-trade the tracked traders
  themselves."** So the eval battery gains a FOURTH baseline, `tracked_traders`, run through the
  SAME env at the SAME costs as the learned agent and the three mechanical floors. The Phase-1 GATE
  is untouched (still keyed on hold-SOL / buy-and-hold — a separate, mechanical question); the
  cohort comparison is an ADDITIONAL head-to-head reported per rung, not a gate input.
- The comparison is on **decisions under identical execution**, not the traders' real on-chain
  fills (which no baseline could reproduce). Replaying the cohort's intents into our sim and paying
  our fills/costs is the apples-to-apples the battery demands.

**Changes (code)**
- `agent/imitation/demos.py` — `build_cohort_action_tape(wallets, *, mints=None)` + `CohortAction`.
  REUSES the demos machinery (`build_trajectories` per-token reconstruction + `_size_target`): each
  reconstructed episode step becomes a timestamped env action (OPEN_LONG/ADD/TRIM/CLOSE with the
  demos' [0,1] size), pooled per mint into one time-ordered "cohort as a single trader" tape. The
  `mints=` filter is the honesty gate — build ONLY from the held-out tokens' cohort trades so no
  train-token behaviour can leak into the test comparison.
- `eval/baselines.py` — `CohortReplayPolicy` (an `EnvPolicy`). Reads `observation.bundle.mint`/
  `as_of`; FIRES the next due cohort decision at the first env instant at/after its timestamp and
  emits passive HOLD (holding) / NO_OP (flat) in between. A mint the cohort never traded yields all
  NO_OP/HOLD — it degenerates to hold-SOL on that token honestly, never fabricating a trade. Pure
  numpy, no torch (stays in the base suite).
- `agent/train_market.py` — `evaluate_rung` / `run_ladder` take an optional `cohort`; when given,
  the rung scores `tracked_traders` on the held-out mints (tape restricted to those mints), records
  its per-token edge, and `format_rung` prints the head-to-head row + edge line. Backward-compatible:
  no cohort → the three-baseline report is unchanged. CLI gained opt-in `--wallets-file`
  (`--max-wallets`, `--cohort-pages`), loaded via the existing Phase-2 Pinax cohort loader.

**Findings (validated offline, torch-free)**
- Unit + end-to-end: the replay fires the traders' real intents/sizes at the right instants, an
  untouched token books ZERO trades (honest hold-SOL fallback), and a real `MarketReplayEnv` rollout
  under the shared eval battery shows the cohort actually trades the tokens it touched. 15 new tests.
- `make check`: ruff clean; mypy unchanged from stock main (50 pre-existing torch/test-stub errors,
  ZERO added by this work); pytest 403 passed, 2 pre-existing CLMM-fixture skips.

**Open**
- Cohort-as-one-trader pools multiple wallets onto one env position, so per-wallet OPEN vs ADD and
  TRIM fractions are approximations against the single aggregate book (documented on the policy). A
  future refinement could weight the pooled tape by conviction or run a per-wallet ensemble.
- The heavy ladder run that actually prints `learned_agent` vs `tracked_traders` numbers is deferred
  (a separate run is in progress; not re-run here to avoid Pinax rate-limits).

## 2026-08-23 (h) — Full-chart MULTI-VENUE env + token-count ladder trainer (unblocks migrated tokens)

**Decisions**
- The bonding-only `TradingEnv` is kept intact; a NEW generic env sits beside it. The bonding env
  seeds the pump.fun virtual reserves and fills every order with the flat constant-product law —
  correct for the pre-migration regime it was built for, garbage on MIGRATED / multi-venue tokens
  (a long-only agent could show −2000×, which is impossible). The fix changes ONLY the fill/sim path.

**Changes (code)**
- `sim/replay/reconstruct.py` — generic reserve reconstruction. A decoded swap stream carries no
  reserves, so pre-trade depth is anchored two honest ways: (default) a **self-consistency fit** of
  constant-product depth `(base0, quote0)` at the token's first swap — reusing the CLMM
  `RollingLocalLiquidityEstimator` (for a CP pool the v3 virtual reserves `(L/√P, L·√P)` ARE the
  reserves) — then rolled FORWARD by the existing `PoolReconstructor` (the forward dual of
  `calibration_independent`'s roll-back); or an explicit independent-reserve anchor when a fresh
  on-chain snapshot exists. Output is a sim-ready tape shaped exactly like `prepare_bonding_curve_tape`.
- `sim/replay/generic_simulator.py` — `MarketReplaySimulator(ReplaySimulator)`: overrides ONLY the
  buy/sell fill to route through a venue `Curve` resolved from the registry; every other part (rug
  check, causal reconstruction, execution realism, realized-only book, terminals) is inherited. A
  curve that refuses a fill → honest `INSUFFICIENT_LIQUIDITY`, never a fabricated number.
- `agent/envs/generic_env.py` — `MarketReplayEnv(TradingEnv)` + `build_market_regime`. Resolves the
  token's venue → curve via `try_resolve_curve` (`pumpfun_amm` → validated CP+fee-stack ~30 bps;
  CLMM venues → effective-`L` curve fit from the token's own swaps; `pumpfun` → closed-form bonding
  curve on the KNOWN seed, not a fit; constant-product venues → CP curve). Unsupported venues
  (`jupiter_v6` router, unknown DEXes) resolve to a NON-tradeable regime with a reason — skipped and
  counted, never faked. Same §3.3 action / tier-A obs / §3.5 reward as the bonding env (it IS a
  `TradingEnv`, so the eval battery + baselines score it unchanged). `env.py` gained one seam:
  `_build_simulator()`.
- `data/dataset.py` — `MarketSwapDataset`: a resumable, pool-partitioned, **venue-preserving** raw
  Pinax swap cache (Parquet + manifest), idempotent on swap identity — the substrate for the
  token-count ladder (the append-only tape log drops `protocol`, so it can't back the venue env).
  `build_dataset` does a paginated, resumable REST backfill.
- `agent/train_market.py` — `run_ladder`: trains the heavier net (128-hidden, 16-quantile) with an
  entropy-decay schedule and 1000+ PPO iters, on a progressive token-count ladder
  (10 → 100 → 1k → 10k → 100k), WARM-STARTING each rung from the previous (checkpointed). Reports at
  each rung: does the agent TRADE (trade count + tokens touched), the risk-adjusted battery vs
  hold-SOL/buy-and-hold, and the held-out-**tokens** edge. `agent/train_data.load_live_market_tapes`
  is the single-page multi-venue loader.

**Findings (validated offline, torch-free)**
- On a synthetic `pumpfun_amm` token the self-consistency fit recovers the true mid to <0.3% and a
  long-only buy→close books a small COST-scale loss (~4bps of the risk budget), not a catastrophe —
  the −2000× bug is a bonding-seed artefact, fixed. All curve families (pumpfun_amm, raydium CP,
  the three CLMM venues, bonding) fill sanely; `jupiter_v6` is flagged unsupported.
- **Scale limit (honest):** paginated REST reaches the 10 / 100 / 1k rungs and into the low
  thousands; **10k / 100k tokens is a bulk-historical job for the Substreams gRPC firehose**
  (`solana.substreams.pinax.network:443`, bearer = raw `PINAX_API_KEY`, pkg `dex-swaps-v0.5.2.spkg`).
  The dataset's on-disk format is the same target a gRPC backfill writes into, so the top rungs are a
  data-collection job, not a code change.

**Open**
- The heavy multi-token training run itself needs the `learn` extra (torch) + real data volume;
  results reported separately once the run lands.

---

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
separate measurement this does not make.

**FIRST LIVE RESULT (bounded): BC produces a policy that TRADES.** Ran the pipeline on the top-8
balance-ranked wallets, ≤2 Pinax pages each (3 wallets skipped on transient 5xx after retries — the
resilience path worked; 4 of the 5 pulled carried trades):
- **2,006 real swaps → 283 per-token episodes** (140 win / 104 loss / 39 still-open — the full
  win-and-loss record, as intended) → **2,058 env-aligned demos**.
- **Held-out-by-token intent accuracy = 85.0%.** BC val predictions are a genuine trading mix
  (open_long 77, add 399, trim 43, close 121; no_op/hold 0), tracking the expert val distribution
  (open_long 74, add 380, trim 69, close 91) — whereas the **untrained** same-arch net predicts a
  degenerate scatter (add 0, close 299 dominating). BC clearly moved the policy off the from-scratch
  corner toward the experts. Mean cloned size on sized intents ≈ 0.28.
- **Caveat on the passive classes:** HOLD/NO_OP demos are sparse here (9 / 43) because passive
  decision instants come only from *other* cohort members' prints on the same mint, and a 4–5-wallet
  pool overlaps little within any one wallet's hold window. Expected with a tiny cohort; grows as the
  cohort scales. The verdict ("does it trade?") is unaffected.

Scale-up (more wallets, more pages, the balance of the 968) is a config change, deliberately not run
here (bounded first pass). The mechanism, tests (ruff/mypy/pytest green), and this honest live result
ship in the PR.

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

**Dataset-scale ladder (operator directive):** train progressively on **10 → 100 → 1,000 → 10,000 →
100,000 tokens**, reporting does-it-trade + risk-adjusted OOS metrics at each rung, warm-starting each
rung from the last. Engineering reality: 10–1,000 run on paginated REST; **10k needs a persisted
resumable Parquet dataset cache; 100k realistically needs the Substreams firehose bulk backfill**, not
one-page REST. Ladder is the plan; low rungs run now, high rungs gated on the dataset pipeline scaling.

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

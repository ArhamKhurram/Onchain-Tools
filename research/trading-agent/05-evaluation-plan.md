# 05 — Evaluation & Benchmarks

**Program:** OCT Autonomous Trading Agent
**Status:** In execution — first exercised for real at the Phase-1 gate (NO-GO, 2026-08-24; see the §1.1 field note and §5)
**Source of truth:** [`00-paper.md`](./00-paper.md) §8. This doc pins the metrics, the promotion gate, the ablation protocol, and the statistical-rigor rules into an executable evaluation contract.

**Governing principle:** the evaluation exists to answer the go/no-go question (charter §2) *honestly* —
its job is to stop us fooling ourselves, not to make the agent look good. Metrics and bars are
**pre-registered before runs**; goalposts never move post hoc.

---

## 1. Metrics

### 1.1 Risk-adjusted & distributional (the core — paper §8.3)
- **Sharpe** and **Sortino** (downside-only) ratios.
- **Maximum drawdown** and time-to-recovery.
- **Full PnL distribution:** mean, median, skew, kurtosis, and **CVaR / tail loss** — essential given violently fat-tailed returns.
- **Hit-rate and expectancy** (avg win × win-rate − avg loss × loss-rate) — **never reported alone**: a low hit-rate can still be highly profitable via a few tail winners, so hit-rate in isolation is misleading.
- **Turnover, fees paid, realized slippage** — to catch strategies that only "work" under unrealistic costs.
- **Capacity** — performance as a function of deployed size (does the edge survive *real* position sizes given liquidity?). A capacity-blind edge is not a shippable edge.

> **Field note (2026-08-24) — best-PnL alone is as misleading as hit-rate alone.** The first real
> population runs made the converse of the hit-rate rule concrete: across four MAP-Elites scale runs
> the best-niche held-out PnL bounced +130 → +7 → +3 → +90 bps between runs — pure lottery variance
> on fat-tailed survivor tokens, where a bigger population just holds more tickets — while the stable,
> informative statistic was the **win-rate distribution** (0.00–0.22, mostly ≤0.10, in every run:
> lottery-shaped, no skill). Rule adopted: headline PnL is never read without the win-rate/expectancy
> shape behind it, and a "best agent" whose win rate sits in lottery territory is a ticket, not an edge.

### 1.2 Per-token outperformance vs labeled traders (paper §8.2 — the operator's explicit objective)
For each token the agent traded, measure realized edge vs the labeled-trader cohort on that **same**
token, matched on the token and controlling for entry/exit timing. Report:
- the **distribution** of per-token edge (not just the mean),
- the **fraction of tokens beaten**,
- the edge vs the **top decile** of traders, not only the median.
Discount headline outperformance modestly for the residual selection effect (paper §9.3).

> **Field note (2026-08-26) — the degenerate-baseline trap: an absent comparison is not a lost one.**
> A `tracked_traders` baseline is only defined on the **intersection** of the held-out tokens and the
> tokens the cohort actually traded. If that intersection is empty, "fraction beaten" is
> **undefined** — it is not 0%, and it is certainly not a win for the agent. This happened for real:
> the rung-100 evaluation's cohort pull was rate-limited down to ~8 of 40 wallets, those survivors had
> traded none of the held-out tokens, and the run duly printed a `tracked_traders` line the agent
> "beat 0% of" — a number that measured nothing at all and, read carelessly, looks like a *finding*
> about the traders. Rules adopted:
> - **Report the intersection first.** Every trader-relative number carries `n_tokens_compared` (and
>   the cohort size behind it) beside it. `n = 0` prints as **N/A — no overlap**, never as a rate.
> - **Pre-register a minimum overlap.** Below it the comparison is reported as not made; the rung is
>   scored against the remaining baselines only, and the report says which baselines it was scored on.
> - **A baseline whose input is fetched at eval time must be checkpointed or ratcheted,** or a
>   transient upstream failure silently degrades the *yardstick* rather than the agent. (Fixed here by
>   caching the resolved cohort so coverage accumulates across runs — `PROGRESS.md` 2026-08-26 (a).)
> - **Generalize the shape:** a baseline that is empty, near-empty, or non-overlapping is a **broken
>   instrument**, and a broken instrument is reported as broken. This applies to every comparator,
>   not just this one.

### 1.3 The 1→100 SOL run — north-star, not teacher (paper §8.1)
Report the balance trajectory from 1 SOL under the portfolio-episode setting as the headline single
number — **and** the full distribution of such runs across seeds/periods. A strategy that reaches
100 SOL in 1 run of 50 and zeroes the other 49 is a **lottery, not an edge**. Judged jointly with the
risk metrics: a 100× reached only via near-ruin drawdowns is a **failure**. This is a report card,
never a training signal.

### 1.4 Fidelity metric — the paper→live gap (paper §6.2, §8.5)
The **paper-vs-live performance gap** is itself a monitored metric and the definitive measure of
sim-to-real fidelity. We expect and budget for degradation; a *large* gap means overfitting/leakage
or an unfaithful simulator and triggers a halt/demotion.

---

## 2. The strict backtest → paper → live promotion gate (paper §8.5, §9.8, §10.4)

A **hard, non-negotiable promotion ladder.** No stage is skipped; any stage regressing below its bar
**auto-demotes** the policy.

```
   BACKTEST (replay sim)            PAPER (live, simulated fills)         LIVE (real money)
   ───────────────────             ─────────────────────────            ─────────────────
   Clear pre-registered      ──►   Trade live new pairs with       ──►  Only after paper clears.
   risk-adjusted bars on            the sim's execution model            Only inside sniper hard
   HELD-OUT tokens AND              against real-time data for a         caps + kill switch.
   HELD-OUT time periods            sustained window. Must reproduce     Start minimal size; scale
   (walk-forward, never             backtest within tolerance.           ONLY as live reproduces
   random splits).                  Large paper-vs-backtest gap =        paper. Human approval for
                                    overfitting/leakage → HALT.          any scale-up. Hard absolute
                                                                         loss limit halts regardless
                                                                         of confidence.
```

- **Backtest → Paper:** clear pre-registered risk-adjusted bars on held-out tokens *and* held-out time periods, walk-forward.
- **Paper → Live:** paper must reproduce backtest within a pre-registered tolerance over a sustained window; a large gap halts (overfitting/leakage).
- **Live:** minimal size, inside the sniper's caps and kill switch; scale only as live reproduces paper; human-in-the-loop approval for any cap scale-up; a hard, small absolute loss limit halts the agent regardless of its confidence.

**No override may bypass caps or the kill switch — ever** (paper §10.6).

---

## 3. Ablation protocol — the curriculum as instrument (paper §5.6, §8.4)

Because the five information tiers are introduced cleanly and gated, **each gate is an ablation** — the
performance delta at each gate *is* the measured marginal edge of that information source.

1. **Per-tier ablations:** measure risk-adjusted performance and per-token edge **with vs without** each tier, in order: raw-chart-only → +wallet-flows → +metadata → +social → +chatter. Isolating wallet flows *first* prices what "who is trading" is worth before any metadata/narrative confounds it. This directly tests the operator's information-flow hypothesis and quantifies *how much* each tier contributes.
2. **Leakage-guard ablations:** replace a tier with **noise**; performance must **drop to the prior tier's level**. If it stays high, the model was exploiting leakage — a **failing** result, not a passing one.
3. **Convergence A/B (paper §4.3):** OCT ranking/decisions **with vs without** Model N — a clean marginal measurement of the agent's contribution to the ensemble.
4. **Honest-null reporting:** a tier that does not add edge is **reported and dropped**. That is a valid scientific outcome; the curriculum is designed to tell us cleanly when a tier fails.

### 3.1 Tier-A result (2026-08-28): reported and dropped

The raw-chart tier is the first to complete this protocol, and it failed it. Three rungs, two
independent methods, `hold_sol` never beaten. Per rule 4 the tier is **priced at ~zero and dropped
as an edge source** — recorded here so the null is part of the evaluation record rather than a gap
in it.

The closing run also demonstrates why the metric set is plural. Read on max drawdown alone the
agent is the *best* policy in the table (0.031 against buy-and-hold's 5.005); read on hit rate
alone `random` wins (22.0%); read on "beats buy-and-hold" alone the agent wins 82.7% of tokens.
Only the joint read — return, versus the do-nothing baseline, net of the fees it took to get there
— gives the right answer. **Any single number here would have reported a success.**

### 3.2 Split-sample protocol for wallet-derived labels

A label computed over a wallet's history is not evaluated like a tier. Correlating past behaviour
with past profit is circular; the question is whether a ranking built on the past orders the
future. The protocol used for earliness, and required for anything like it:

1. Split every (wallet, token) pair at the median first-buy timestamp.
2. Rank wallets using **period A only**, with a minimum evidence threshold per wallet.
3. Measure realized outcome in **period B**, again with a minimum threshold.
4. **Report the pair overlap.** For earliness it was zero of 100,715 — period-B outcomes were
   earned entirely on tokens the ranking never saw. Without that number the test proves nothing.
5. Report the in-sample and out-of-sample effect sizes **together**. Earliness spans 0.606→0.063
   in sample and 0.403→0.350 out of sample; the shrinkage is expected — the in-sample figure is
   inflated by a mechanical component — and quoting only the larger number would be dishonest.

---

## 4. Statistical-rigor rules (paper §8.5, §9.6)

- **Pre-registration.** Metrics, bars, and hypotheses are fixed *before* runs and recorded. No post-hoc goalpost moves (paper §10.6).
- **Walk-forward only.** Time ordering is sacred; held-out time periods and tokens; **never random splits** (they leak future into past — paper §8.5).
- **Multiple-comparison discipline.** With five tiers, a population of archetypes, and many metrics, apparent edges will arise by chance; corrections/discipline are applied before calling a marginal edge "credible" (paper §10.3).
- **Seeds & regimes.** Report across seeds and across recent regimes; **stability** (low variance across seeds/regimes) is a gating criterion, not a footnote (paper §5.6).
- **Population validity (paper §6.4).** Behavioral diversity must persist **out-of-sample and across regimes** — a population that all overfit one replay window is 100 correlated ways to fail, not robustness. Each retained archetype must be **individually edge-positive** after realistic costs; "diverse but unprofitable" does not pass. Where independently evolved archetypes **converge** on the same trade, that agreement is itself a robustness signal (and feeds the convergence layer).
- **Baseline validity.** A comparison is only as real as the baseline's coverage: every
  benchmark-relative number is reported with the count of tokens actually compared, and a baseline
  with no overlap (or below its pre-registered minimum) is reported as **not measured**, never as a
  0% beat rate. See the §1.2 field note — this failure mode has already occurred once.
- **Cost realism.** Every reported number is **after** modeled fees, slippage, and price impact. Numbers that only survive under unrealistic costs are treated as failures, not results.
- **Luck-vs-skill.** For the trader benchmark, apply persistence / cross-period edge-stability tests before trusting any single trader's label (paper §9.3).

---

## 5. What "success" reports look like

Every headline number carries its caveats attached (paper §10.6):
- Risk-adjusted metrics **after realistic costs**, with the CVaR/tail explicitly shown.
- Per-token edge vs traders as a **distribution + fraction beaten + top-decile edge**, discounted for the residual selection effect.
- The 1→100 run as a **distribution across seeds/periods**, judged jointly with drawdown/CVaR.
- The **paper→live gap** stated as the fidelity measure.
- Any tier that failed to add edge, **named and dropped**.

A defensible, caveated **"no"** at any gate is a successful outcome of this evaluation — it answers the
open question and prevents lighting real capital on fire (charter §2, paper §11).

*This clause has now been exercised for real: on 2026-08-24 the Phase-1 chart-only gate returned a
defensible, caveated NO-GO — replicated across two independent methods (a PPO token-count ladder and
MAP-Elites population search), leakage guard passed, caveats attached (paper §12.1,
`03-experiment-plan.md` Phase 1). The evaluation did its job.*

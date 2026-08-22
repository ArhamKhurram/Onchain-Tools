# 05 — Evaluation & Benchmarks

**Program:** OCT Autonomous Trading Agent
**Status:** Proposal / pre-Phase-0
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

### 1.2 Per-token outperformance vs labeled traders (paper §8.2 — the operator's explicit objective)
For each token the agent traded, measure realized edge vs the labeled-trader cohort on that **same**
token, matched on the token and controlling for entry/exit timing. Report:
- the **distribution** of per-token edge (not just the mean),
- the **fraction of tokens beaten**,
- the edge vs the **top decile** of traders, not only the median.
Discount headline outperformance modestly for the residual selection effect (paper §9.3).

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

---

## 4. Statistical-rigor rules (paper §8.5, §9.6)

- **Pre-registration.** Metrics, bars, and hypotheses are fixed *before* runs and recorded. No post-hoc goalpost moves (paper §10.6).
- **Walk-forward only.** Time ordering is sacred; held-out time periods and tokens; **never random splits** (they leak future into past — paper §8.5).
- **Multiple-comparison discipline.** With five tiers, a population of archetypes, and many metrics, apparent edges will arise by chance; corrections/discipline are applied before calling a marginal edge "credible" (paper §10.3).
- **Seeds & regimes.** Report across seeds and across recent regimes; **stability** (low variance across seeds/regimes) is a gating criterion, not a footnote (paper §5.6).
- **Population validity (paper §6.4).** Behavioral diversity must persist **out-of-sample and across regimes** — a population that all overfit one replay window is 100 correlated ways to fail, not robustness. Each retained archetype must be **individually edge-positive** after realistic costs; "diverse but unprofitable" does not pass. Where independently evolved archetypes **converge** on the same trade, that agreement is itself a robustness signal (and feeds the convergence layer).
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

# Revival scanner — training report

**Generated 2026-08-05 · Solana + BNB Chain · Pinax substreams full-chain replay**

## Headline

The revival signal is real, and **a learned model beats the hand-gate baseline
out-of-time by ~50% on both precision and recall at the same alert budget.**
**ATR% is the single dominant feature; absorption (the accumulation footprint)
is second; crowd size — unique buyers — is one of the *weakest* signals**, which
is exactly why the buyers-heavy hand gates underperformed.

This supersedes the earlier REST keyhole (130 pools, 5 revivals). The corpus is
**~170× larger** and, for the first time, big enough to train and evaluate
honestly.

## Corpus & coverage

Full-chain substreams replay, aggregated in-stream to 1m candles (raw swaps not
retained), episodes labelled per the C0 dormancy→revival definition.

| Window | Role | Candle rows | Pools | Episodes | Base rate (≥2×/24h) |
| --- | --- | --- | --- | --- | --- |
| sol-w1 | train | 2.45M | 45,990 | 3,299 | 4.1% |
| sol-w2 | test | 2.50M | 46,418 | 3,410 | 6.8% |
| bsc-w1 | split by ts | 3.18M | 15,508 | 6,129 | 3.6% |

**~8.1M candle rows → 12,838 usable episodes** (after the outlier filter below).
Out-of-time split: **train = sol-w1 + BSC before the sol-w2 cutoff (5,919
episodes); test = sol-w2 + BSC after it (6,919).** No episode from the training
period appears in test. Product event = **peak ≥ 2× within 24h of the episode**.

## Model

- **Classifier** — LightGBM, `P(peak_24h ≥ 2×)`, early-stopped (best_iter 55).
- **Magnitude head** — LightGBM quantile regressors (P10/P50/P90) on
  `log(peak_24h)`.
- 16 decision-time features, all computable at alert time (no future leakage):
  ATR% + its expansion z-score, RVOL, unique buyers 10m, buy/sell ratio,
  absorption (|Δprice|/volume), volume, dormancy hours, token age, prior-episode
  and prior-2× counts, trades-in-minute, hour/day, chain.

## Results (test = held-out later window)

### Classifier

| Metric | Value |
| --- | --- |
| PR-AUC | **0.214** (base rate 0.052 → **4.1× lift**) |
| precision @ top 5% | **25.2%** (4.9× lift) |
| precision @ top 10% | 22.0% (4.3×) |
| precision @ top 20% | 17.5% (3.4×) |

At the tightest threshold, **1 in 4 alerts hits ≥2× vs 1 in 20 at random.**

### vs the hand-gate baseline — the decision that matters

Same test episodes, matched alert budget:

| | Alerts | Precision | Recall (2×) |
| --- | --- | --- | --- |
| Hand gates (trigger + RVOL + buyers + b/s) | 378 | 16.9% | 17.9% |
| **Model @ same 378-alert budget** | 378 | **25.9%** | **27.5%** |

**+53% precision, +53% recall, for free** — the model earns its place. Per
TRAINING_ARCHITECTURE §3 the gates remain as vetoes, but the scorer replaces
them for ranking.

### Magnitude head

P10–P90 interval coverage **0.756** (target 0.80 — intervals slightly too
narrow), P50 median absolute error **0.037×**. Usable for ranking "small chance
of a big move" vs "likely small move," not yet trustworthy as a calibrated
interval.

## Insights — which pattern dominates (the question that started this)

Feature importance (gain) and SHAP mean|value| agree on the ordering:

| Rank | Feature | Gain | SHAP | Read |
| --- | --- | --- | --- | --- |
| 1 | **atrPct** | 37.2% | 0.67 | Range expansion is the signal. The original ATR instinct is validated as #1 by a wide margin. |
| 2 | **absorption** | 5.9% | 0.27 | Volume with little price move = supply being absorbed. The **accumulation-footprint / Tier-1 thesis (the PIPECAT pattern) is confirmed as the #2 predictor.** |
| 3 | atrPctZ | 8.2% | 0.20 | Expansion vs the token's own baseline. |
| 4 | dispFromBaseline | 9.5% | 0.20 | Distance already travelled. |
| … | | | | |
| low | **uniqueBuyers10m** | 2.5% | 0.03 | **Crowd size is near-useless as a predictor** — second-lowest SHAP. |

**The counterintuitive finding:** the hand gates leaned hardest on unique-buyers
and buy/sell ratio (the "is a crowd arriving" test), and those are among the
*least* predictive features. The model wins precisely by down-weighting the
crowd and up-weighting volatility + absorption. This is evidence for entering on
the **accumulation** footprint, not the crowd — the lead-time argument the spike
kept pointing at.

**Cross-chain:** `chainId` carries almost no weight (0.7% gain), and BSC + Solana
train together without a chain flag mattering — the signal transfers across
chains, supporting the chain-agnostic-analytics design.

## Honest limitations

- **Outlier filter:** 19/12,879 episodes (0.15%) had `peak_24h > 100×` — every
  one a near-zero dormancy-baseline division artifact (baseline ~1e-5, 0–1
  buyers). Excluded as data-quality; left in they inject fake positives and
  wreck the log-peak target. The near-zero-baseline denominator is a **known
  pipeline weakness** (PROJECT_CONTEXT flagged it) — the mid-price-from-reserves
  approach would fix it at the source; the spike uses per-candle VWAP.
- **Two Solana windows + one BSC window**, ~3 chain-days each — one meta-regime.
  Out-of-time guards against the worst overfitting but not against regime shift
  between now and production.
- **No 10–20× tail events** in the labelled positives after filtering — the far
  tail is power-law and needs far more token-days to populate. Magnitude
  predictions above ~10× are extrapolation.
- **Collection was interrupted** repeatedly (ECONNRESET storms ~11h in, an
  OOM that took the orchestrator down, a machine reboot). All recovered from
  checkpoints with no data loss, but total wall-clock was ~a day, not the
  ~3.5h a clean run would take. Root causes fixed (per-worker heap caps, retry
  cap 10→60).
- Unique-buyer features are **swap-derived**; on a future Robinhood lane they'd
  be live-only (see ROBINHOOD_ADAPTER.md).

## Open questions

1. **Fix the baseline denominator** (reserve mid-price) and re-label — does the
   0.15% artifact rate drop to ~0, and do any real 5–50× events currently
   mis-scored reappear?
2. **Does a dedicated Tier-1 (accumulation) model beat the general one** for
   lead time? Absorption being #2 says the footprint is there; measure whether
   scoring it *before* ATR expansion buys positive lead.
3. **Regime durability** — retrain on a later window and test the current model
   forward. How fast does precision decay as the meta rotates?
4. **Magnitude calibration** — the P10/P90 under-covers (0.756 vs 0.80); widen
   or switch to conformal intervals before surfacing any predicted multiple.
5. **Shadow deploy** — run the classifier live (log, fire nothing) and confirm
   the out-of-time numbers hold on genuinely unseen forward data before it
   ranks anything a user sees.

## Artifacts

- `train/models/` — `classifier_2x.txt`, `magnitude_p{10,50,90}.txt`,
  `features.json` (LightGBM text format).
- `train/metrics.json` — full metrics.
- `data/corpus/episodes.jsonl` — 12,879 labelled episodes (committed).
- `data/corpus/` raw shards (~2 GB) are gitignored — rebuildable via replay.

# A Trade-Flow Attention Model for New-Pair Memecoins: Inferring Endogenous Attention from the Swap Tape

**Onchain Tools (OCT) — Research & Specification Paper (sub-project of the Autonomous Trading Agent program)**
**Status:** Proposal / specification (not a results paper)
**Version:** 0.1 (draft for internal review)
**Date:** 2026-08-22
**Parent:** `../autonomous-trading-agent.md` — this sub-project produces the **flow-tier attention signal** that feeds the parent agent's Phase-B observation space and the convergence layer, and could stand alone as its own paper.
**Condensed in the main paper:** a paper-scale version of this model now appears as **§4.4 (The trade-flow attention model)** of `../autonomous-trading-agent.md`, with its identification risk folded into that paper's **§9.10**. This document remains the full companion treatment (extended related work, estimation detail, evaluation protocol, and mini-roadmap).

---

## Abstract

Memecoin markets are attention markets: a new token has no cash flows, no fundamentals, and almost no history — what it has is a crowd, arriving or leaving, and price is very nearly the second-derivative of that crowd's attention. The dominant academic way to measure investor attention is *exogenous* — Google search volume (Da, Engelberg & Gao, 2011), news counts, Wikipedia views, social-media mentions. These proxies are coarse (daily, platform-lagged, easily detached from the specific token), and for a coin that is minutes old they mostly do not exist yet. We propose instead to measure attention **endogenously, from the swap tape itself** — from nothing but the sequence of on-chain buys and sells — producing a continuous *attention chart* over a token's life that is available from its first block.

The operator originally framed this as an "orderbook attention model." We make one correction up front and keep it throughout: new pairs trade on **AMM bonding curves, not a central-limit order book**, so there is no resting book of bids and asks to read. The precise object is therefore a **trade-flow attention model** over the swap stream: a model whose state variable is the instantaneous, self-reinforcing intensity of trading, interpreted as the market's attention on the token.

We build the proposal on two literatures that share a word and almost nothing else, and we are explicit that the paper uses both senses deliberately: **(a) *investor attention*** from behavioral finance (a scarce cognitive resource that drives who buys what and when), and **(b) the *attention mechanism*** from machine learning (Vaswani et al., 2017 — a differentiable operation that weights a sequence by learned relevance). Our thesis is that (b) is a natural tool for estimating (a) from raw flow. We specify two complementary backbones for the estimator: a **Hawkes-process** model, whose fitted conditional intensity *is* the attention chart and whose branching ratio is a principled "endogeneity / attention-momentum" scalar (Bacry, Mastromatteo & Muzy, 2015; Filimonov & Sornette, 2012), and a **transformer/self-attention encoder** over the swap sequence as a learned alternative and representation for the parent agent. We describe the candidate flow features, how the two backbones relate, how the output feeds the parent RL agent as an encoder and the convergence layer as an independent signal, an evaluation protocol centered on lead–lag against external attention proxies and ablation inside the main agent, and — at length, because it is the crux — the identification and manipulation threats that make "attention measured from flow" a genuinely hard and partly unidentifiable quantity. As with the parent program, this is a specification: it reports no returns, no numbers, only targets, thresholds, and real prior work cited by name.

---

## 1. Motivation

### 1.1 Attention is the fundamental of an asset with no fundamentals

For an equity, attention is a *modifier* on top of fundamentals: Da, Engelberg & Gao (2011) show a spike in Google search volume predicts higher prices over the next two weeks and an eventual reversal — attention moves price *around* a fundamental anchor. A new-pair memecoin has no anchor. Its entire market value is a claim on future attention: the token is worth something only insofar as more people will notice it and buy. In that limit, attention stops being a modifier and becomes the fundamental itself. A model of attention is therefore not a sentiment overlay for this asset class — it is the closest thing to a valuation model that exists.

### 1.2 Why endogenous, and why from flow

The standard attention proxies are external and, for this use case, structurally inadequate:

- **They lag and are coarse.** Google Search Volume Index is daily; social APIs are minutes-to-hours behind and rate-limited. A memecoin's decisive window is often its *first thirty minutes* — the interval that empirical studies of pump.fun launches find largely determines whether a token accumulates enough buyer momentum to survive at all. An attention measure that updates once a day is blind to the only window that matters.
- **They are hard to attribute.** "crypto" or even a ticker search does not resolve to *this* contract among the thousands sharing a meme. The swap tape, by contrast, is unambiguously about one pool.
- **They can be entirely absent.** Most new pairs never trend anywhere off-chain; they live and die purely on-chain. Their attention, if it exists, is visible *only* in the tape.

The swap tape is the one signal that is real-time, token-specific, and always present. Every buy is a revealed act of attention-plus-conviction; every sell is attention-plus-exit; the *timing* between trades, the *acceleration* of buys, the *widening* of the unique-buyer set — these are the on-chain shadow of a crowd forming or dispersing. The proposal is to reconstruct the attention state from that shadow.

### 1.3 Relationship to the parent program

The parent agent's progressive-information curriculum holds **wallet flows as its own gated tier (Phase B)** precisely so their marginal value can be priced. This sub-project is the machinery that turns that raw flow tier into a *compact, semantically meaningful state* — an attention encoder — rather than a bag of hand-built ratios. It also stands alone: an "attention is igniting on this pair" alert is a legitimate OCT signal in its own right, independent of whether the RL agent ever consumes it, and it enters the convergence layer as one more independent detector (parent §4.3).

---

## 2. Two senses of "attention," and the bridge between them

The word "attention" is load-bearing in two different fields, and this paper uses both on purpose. Conflating them silently would be a category error; using one to estimate the other is the whole idea. We separate them explicitly.

### 2.1 Sense A — Investor attention (behavioral finance)

Here attention is a **scarce human cognitive resource**. Peng & Xiong (2006) model it formally: investors cannot process everything, so they allocate limited attention, which shapes what gets priced and when. Barber & Odean (2008) show the asymmetry it induces — retail investors are *net buyers* of attention-grabbing stocks (those in the news, with abnormal volume, or extreme returns), because you can only buy what you have noticed, while you sell from the small set you already own. Da, Engelberg & Gao (2011) make it measurable with search volume and show it predicts a run-up then a reversal. Andrei & Hasler (2015) tie attention to *volatility*: return variance and risk premia rise with the level of attention. The common thread: attention is an unobservable state of the crowd, and price/volume/volatility are its observable consequences. In a memecoin, this state is nearly the entire story.

### 2.2 Sense B — The attention mechanism (machine learning)

Here "attention" is a **differentiable operation**, introduced in the Transformer (Vaswani et al., 2017): for each position in a sequence, compute a set of learned weights ("how much should this element attend to each other element") and take the weighted combination. It has no intrinsic connection to human psychology; it is a way of letting a model decide, per element, which parts of a sequence are relevant. It is now the default sequence-modeling primitive, and it has been carried into market-microstructure prediction — TransLOB (Wallbridge, 2020) and more recent limit-order-book transformers apply masked self-attention over order-book event sequences, building on the CNN/LSTM lineage of DeepLOB (Zhang, Zohren & Roberts, 2019).

### 2.3 The bridge

The two senses are different objects — one is a latent human state, the other is a neural operator — but they meet cleanly here, in two independent ways, and the paper exploits both:

1. **Self-excitation as a formal model of attention dynamics.** Investor attention is *self-reinforcing*: a trade draws eyes, which draw trades. That is exactly the generative assumption of a **Hawkes process** — each event raises the probability of near-future events. So a self-exciting point process fit to the swap tape is not a metaphor for attention; it is a literal dynamical model of the Sense-A feedback loop, with a scalar (the branching ratio) that measures how self-sustaining the current attention is. This is the *model-based* bridge (§4).

2. **The ML attention mechanism as the estimator.** A Transformer encoder over the swap sequence learns, per trade, which past trades are relevant to the token's current state — and that learned relevance weighting is a flexible, data-driven way to summarize the flow into an attention representation without committing to the Hawkes functional form. This is the *learned* bridge (§5). Sense B is, quite literally, a tool for estimating Sense A.

We will keep the naming disciplined below: **"attention state / attention chart"** always means Sense A (the thing we are measuring); **"self-attention / attention weights"** always means Sense B (a mechanism we may use to measure it).

---

## 3. Related work (real, cited by name)

### 3.1 Investor attention and prices

- **Da, Engelberg & Gao (2011), "In Search of Attention," *Journal of Finance* 66(5):1461–1499.** The canonical direct-attention paper: Google Search Volume Index as a timely, retail-tilted attention proxy that predicts a ~2-week price increase and a later reversal, and explains IPO first-day pops and long-run underperformance. This is the template for the very idea of an "attention chart that leads price," and the reversal result is a direct warning for memecoins (attention-driven run-ups mean-revert).
- **Barber & Odean (2008), "All That Glitters," *Review of Financial Studies* 21(2):785–818.** Attention-driven *buying*: retail are net buyers of attention-grabbing assets because of the search asymmetry between buying and selling. Motivates why *buy*-side flow specifically is the attention-carrying side of the tape.
- **Peng & Xiong (2006), "Investor Attention, Overconfidence and Category Learning," *Journal of Financial Economics* 80(3):563–602.** Attention as a scarce resource that is *allocated*; limited attention drives category-level (meta-level) rather than asset-specific processing — directly relevant to "meta" rotation in memecoins (dogs, politics, AI).
- **Andrei & Hasler (2015), "Investor Attention and Stock Market Volatility," *Review of Financial Studies* 28(1):33–72.** Links attention to variance and risk premia. Predicts that our attention chart should co-move with realized volatility, giving us an external consistency check.
- **Kristoufek (2013, 2015) and the Google-Trends-crypto literature.** Extends search-attention work to cryptocurrencies (Bitcoin returns/volatility, bubble dynamics). Establishes that attention proxies are informative in crypto specifically — and, by their coarseness, motivates an endogenous alternative for the new-pair regime where they are absent.

### 3.2 Self-exciting order flow — the core math

- **Hawkes (1971), "Spectra of some self-exciting and mutually exciting point processes," *Biometrika* 58(1):83–90.** The original self-exciting point process. Foundational.
- **Bacry, Mastromatteo & Muzy (2015), "Hawkes Processes in Finance," *Market Microstructure and Liquidity* 1(1):1550005.** The definitive survey of Hawkes in high-frequency finance — clustering of trades, order-flow dynamics, price-impact and microstructure applications, estimation. Our primary methodological reference for the Hawkes backbone.
- **Filimonov & Sornette (2012), "Quantifying reflexivity in financial markets," *Physical Review E* 85:056108.** Introduces the **branching ratio** of a Hawkes fit as a direct measure of market *endogeneity* — the fraction of activity generated by the market's own feedback vs exogenous news — and frames a value near 1 as *criticality*. This is exactly our "attention momentum / self-sustainment" scalar, and their endogeneity-vs-exogeneity framing is exactly our central identification problem (§7).
- **Hardiman, Bercot & Bouchaud (2013), "Critical reflexivity in financial markets: a Hawkes process analysis," *Eur. Phys. J. B* 86:442.** Argues the branching ratio sits *near unity* (near-critical) persistently, and flags estimation subtleties (power-law kernels, apparent-criticality artifacts). A necessary caution: naive Hawkes calibration can *manufacture* near-criticality — we must not read every high branching ratio as real attention.
- **Crypto-specific Hawkes work.** A growing line fits univariate/multivariate Hawkes models to crypto trade and LOB event streams (e.g., self-exciting models of Bitcoin trade arrivals; multivariate Hawkes for BTC/USD return-sign forecasting; studies quantifying *endogeneity of cryptocurrency markets*). Establishes that the machinery transfers to crypto flow; none, to our knowledge, targets first-minutes AMM new-pairs or interprets the intensity as an attention signal for an agent.

### 3.3 Market microstructure — flow, impact, memory

- **Kyle (1985), "Continuous Auctions and Insider Trading," *Econometrica* 53(6):1315–1336.** The origin of linear price impact: price moves in signed order flow with slope **λ**, inversely proportional to depth. On an AMM the impact function is *known in closed form* from the bonding curve, which both simplifies and sharpens the mapping from flow to price.
- **Cont, Kukanov & Stoikov (2014), "The Price Impact of Order Book Events," *Journal of Financial Econometrics* 12(1):47–88.** Over short intervals, price change is driven mainly by **order-flow imbalance (OFI)**, linearly, with slope inversely proportional to depth. OFI is a first-class feature in our design; on an AMM we compute its exact analogue (net signed base-token flow against pool reserves).
- **Lillo & Farmer (2004), "The Long Memory of the Efficient Market," and the Lillo–Mike–Farmer order-splitting model.** Trade signs exhibit *long memory* (power-law-decaying autocorrelation, Hurst > ½), largely from metaorder splitting. Two consequences for us: (i) buy/sell runs are persistent and predictable in sign, which is signal; (ii) that same persistence is what a single large actor *splitting orders* produces — the microstructure signature of one whale is hard to distinguish from many small buyers, which is central to the sybil/manipulation threat (§7).

### 3.4 The ML attention mechanism and its use on order flow

- **Vaswani et al. (2017), "Attention Is All You Need," *NeurIPS 2017*.** The Transformer / self-attention mechanism (Sense B). The estimator primitive for the learned backbone.
- **Zhang, Zohren & Roberts (2019), "DeepLOB," *IEEE Trans. Signal Processing* 67(11):3001–3012.** CNN+LSTM on raw LOB data for price-move prediction; established deep learning on microstructure sequences and the practice of learning "universal" microstructure features that transfer across instruments — encouraging for cross-token transfer on new pairs where per-token data is tiny.
- **Wallbridge (2020), "Transformers for Limit Order Books" (TransLOB); and subsequent LOB transformers (e.g., dual-attention TLOB, LiT, 2025).** Self-attention over microstructure event sequences, outperforming/complementing DeepLOB. This is the closest existing work to our learned backbone; the key novelty we add is (i) AMM swap streams rather than LOB events, (ii) the first-minutes new-pair regime, and (iii) interpreting the representation as an *attention state* fed to an RL agent, not just a price-direction classifier.

### 3.5 The adversary — manipulation and fake flow

- **Cong, Li, Tang & Yang, "Crypto Wash Trading" (NBER w30783 / SSRN).** Statistical detection of fake volume (Benford / first-significant-digit, size-rounding, tail-distribution tests); estimates that wash trading averaged **>70% of reported volume** on unregulated exchanges. This is the single most important threat reference: *the thing we call attention is exactly the thing manipulators manufacture.* Their detection tests are candidate filters for our feature pipeline.
- **DEX wash-trading and pump.fun empirical studies.** Work detecting wash trading on decentralized exchanges, and studies of Solana launchpads reporting that the overwhelming majority of new pairs are pump-and-dumps or rugs, with coordinated sniper wallet-rings active in the first hour. These document that our input stream is adversarially generated by construction — the base rate of "fake attention" is not a tail risk here, it is the norm.

---

## 4. The proposed model — Part I: the Hawkes backbone (the attention chart)

### 4.1 Object of interest

The precise object is the **conditional intensity** of the token's trade process. For a marked point process of swaps with event times \(\{t_i\}\) and marks (side, size, wallet), a multivariate Hawkes model posits, for each stream type \(k\) (e.g., buys, sells):

\[
\lambda_k(t) = \mu_k(t) \;+\; \sum_{j:\,t_j < t} \sum_{\ell} \phi_{k\ell}(t - t_j)\, m_j
\]

where \(\mu_k(t)\) is the exogenous ("news/discovery") base rate, \(\phi_{k\ell}\) are the excitation kernels (how a stream-\(\ell\) event of mark \(m_j\) raises the future intensity of stream \(k\)), and the sum is over past events. **The fitted \(\lambda_{\text{buy}}(t)\) — the instantaneous, self-reinforcing rate of buying — is the attention chart.** It is defined from the first trade, updates on every event, and is token-specific by construction. Sells give a complementary "exit-attention" curve; the buy/sell cross-excitation terms capture whether buying begets selling (distribution) or buying begets buying (ignition).

### 4.2 The branching ratio as attention momentum

The **branching ratio** \(n\) (the spectral norm / integral of the excitation kernels) is the expected number of future trades directly triggered by one trade. It is a single, interpretable scalar with a clean reading:

- \(n \to 0\): trades arrive only from exogenous discovery; no self-sustained crowd. *Attention is not compounding.*
- \(n \to 1\): the process is **near-critical** — each trade nearly reproduces itself — so a small spark sustains a large cascade. *Attention is self-sustaining; a run is dynamically possible.*
- \(n \ge 1\): explosive/unstable, the signature of a runaway (or a manipulated) cascade.

This is precisely Filimonov & Sornette's (2012) *endogeneity* measure, repurposed: \(n\) is our **attention-momentum scalar**, a compact feature that says how much of the current activity is the crowd feeding on itself versus fresh external arrivals. It is exactly the quantity a memecoin trader means by "is this thing actually catching, or is it just the deployer's bots?" — and, as §7 stresses, those two are the hard-to-separate cases.

### 4.3 Why AMM, not orderbook — and what changes

New pairs trade against an **AMM bonding curve** (pump.fun-style constant-product / bonding curve), not a central-limit order book. There is no resting book of quotes to read, which is why "orderbook attention model" is the wrong name. What this changes, concretely:

- **No book-pressure features** (no bid/ask queue imbalance, no depth-at-levels). The observable is the *trade tape* only: a sequence of executed swaps.
- **Price impact is known in closed form.** On a constant-product curve, a buy of a given size moves price by an exactly computable amount (the parent simulator already needs this). So we do not *estimate* λ à la Kyle; we *know* the impact map and can therefore cleanly separate "price moved because of one big trade" from "price moved because many traders arrived" — a genuine advantage over equity microstructure for attribution.
- **The point process is the whole game.** Because the only stochastic input is *who trades, when, and how big*, a marked point process over the swap tape is a near-complete description of the token's dynamics. That is unusually favorable for a Hawkes formulation.

### 4.4 Candidate flow features (the marks and covariates)

The Hawkes marks and the parallel feature vector (shared with the learned backbone, §5) are drawn from pure flow:

- **Buy/sell velocity and acceleration** — event rates and their time-derivatives; acceleration is the "igniting" signal.
- **Inter-trade time** (the raw point-process input) and its clustering — shrinking gaps = rising intensity.
- **Order-flow imbalance (OFI)** — net signed base-token flow per window (Cont–Kukanov–Stoikov analogue on the AMM), and its AMM-exact price-impact-adjusted form.
- **Unique-buyer growth** — the rate at which *new* wallets enter, distinct from repeat trading. This is the feature most aligned with Sense-A attention (breadth of the crowd) and least easily faked by a single actor churning.
- **Buyer concentration** — top-holder / top-buyer share, Gini/Herfindahl of buy volume. Low concentration + rising unique buyers = broad attention; high concentration = one actor, i.e., *suspect* attention.
- **Trade-size distribution shape** — Benford / first-significant-digit and round-number tests (Cong et al.) as *inline* fake-flow features, not just offline filters.
- **Creator/sniper-wallet activity** — deployer and first-hour-ring behavior as a covariate that *down-weights* apparent attention.

### 4.5 Estimation and its hazards

We fit the multivariate Hawkes model online per token (MLE or EM on the event stream; parametric exponential-sum kernels for speed, with a power-law kernel option per Hardiman et al.). Three hazards, stated plainly:

- **Tiny samples.** A new pair may have tens of trades in its decisive first minutes; Hawkes MLE is unstable in that regime. Mitigation: hierarchical/partial-pooling priors across tokens (a cross-token prior on kernels, updated per token), and the cross-token context encoder the parent already specifies — the learned backbone (§5) is partly a response to this.
- **Apparent criticality.** Hardiman et al. (2013) show naive calibration can push \(n\) spuriously toward 1 (kernel misspecification, edge effects). We treat any \(n \approx 1\) as *a hypothesis to be corroborated* by unique-buyer breadth, never as a standalone "it's mooning" trigger.
- **Non-stationary base rate.** \(\mu(t)\) is not constant (discovery arrives in bursts). Conflating a rising exogenous \(\mu\) with rising self-excitation \(n\) is the core identification problem (§7).

---

## 5. The proposed model — Part II: the self-attention backbone (the learned encoder)

### 5.1 Rationale

The Hawkes model is interpretable and gives us \(n\) for free, but it *commits to a functional form* (excitation is additive, kernels are fixed shapes) that real flow may violate — and it struggles on tiny per-token samples. The learned alternative is a **self-attention encoder over the swap sequence** (Vaswani et al., 2017; in the spirit of TransLOB and the LOB-transformer line), which relaxes the functional form and can *transfer* across tokens (DeepLOB's "universal features" finding is the encouraging precedent).

### 5.2 Architecture sketch

- **Input:** the causal sequence of the token's swaps, each a token-embedding of (Δt since last trade, side, size, price-impact-on-curve, wallet-tags: fresh/smart/sniper/creator, running concentration). Multi-resolution: raw event stream plus fixed-interval bar summaries.
- **Encoder:** a causal (masked) self-attention stack. Per trade, the attention weights learn which past trades are relevant to the current state — *this is Sense B estimating Sense A*. Positional/temporal encoding uses actual timestamps (irregular sampling), not index positions.
- **Outputs (heads):** (i) a compact **attention-state embedding** (the vector handed to the parent RL agent); (ii) a scalar **attention score/curve** (a calibrated 0–1 "how much genuine attention is on this pair now"); (iii) optional auxiliary heads for self-supervision — next-inter-trade-time, next-side, short-horizon realized-volatility — that give dense training signal without labels and align the representation with the microstructure.

### 5.3 How the two backbones relate

They are **complementary, not competing**, and we deliberately keep both:

- The **Hawkes model is the interpretable prior and the teacher.** Its \(\lambda(t)\) and \(n\) are (a) directly usable features, (b) a *self-supervision target* for the encoder (train the encoder to predict the Hawkes intensity, distilling structure into the learned model), and (c) the human-legible explanation when the encoder fires.
- The **encoder is the flexible student and the parent-facing representation.** It absorbs whatever the Hawkes form misses, transfers across tokens to survive the small-sample regime, and produces the embedding the RL agent actually consumes.
- **Agreement between them is itself signal** (mirroring the parent's convergence philosophy): when the parametric \(n\) and the learned score both say "igniting," that is a more robust attention call than either alone; when they diverge, the divergence flags either manipulation (structured fake flow the encoder learned to distrust but the Hawkes form does not) or model misspecification.

### 5.4 What the model outputs

For any token at any time \(t\), causally: an **attention state** = { \(\lambda_{\text{buy}}(t)\), \(\lambda_{\text{sell}}(t)\), branching ratio \(n(t)\), unique-buyer-breadth, concentration, a manipulation-suspicion score, the learned embedding, and a single calibrated attention score }. Over the token's life this traces the **attention chart** — the deliverable object — with, crucially, an accompanying *confidence/authenticity* channel so downstream consumers know whether the attention looks organic or manufactured.

---

## 6. How it feeds the parent agent

### 6.1 As an encoder / feature in the observation space (the flow tier)

The parent's Phase B grants "wallet flows." This sub-project *is* the Phase-B encoder: instead of feeding the RL agent a raw bag of flow ratios, we feed the **attention-state vector** (§5.4) as a learned, compact, pretrained representation of the flow tier. Pretraining the encoder self-supervised on the swap firehose (before any RL) is exactly the "representation-first pretraining / privileged-encoder" move the parent gestures at (parent §5.6), and it directly addresses the parent's small-per-token-data problem via cross-token transfer.

### 6.2 As an independent signal into the convergence layer

Per the parent's non-negotiable design principle — **signals stay independent, fused only at scoring** (parent §4.3) — the trade-flow attention model is registered as *one more independent detector*. Its calibrated attention score (with its authenticity channel) enters the convergence scorer alongside honest-caller scoring, FOMO smart-money, revival, and pump/KOL callouts. Because it is derived purely from flow, it is *mechanically independent* of the social/caller signals — which is what makes convergence between "flow says igniting" and "callers say igniting" meaningful rather than double-counting.

### 6.3 As a standalone OCT signal

Independently of the RL agent, "**attention is igniting on this pair**" — a rising \(\lambda_{\text{buy}}\) with broadening unique buyers and a branching ratio climbing toward 1, *and a low manipulation-suspicion score* — is a shippable OCT alert on its own, in the same family as the existing revival and missed-runner alerts. This gives the sub-project a delivery path that does not depend on the full agent landing.

### 6.4 Codependent training with the agent (mechanics)

§6.1–6.3 can misread as a one-way pipeline; the mature design is **codependent** (parent §4.4, "Codependent training"). New pairs *are* attention markets — price ≈ the derivative of crowd attention — so an agent trading here trades *within* the system this model estimates, and the two are jointly optimized. The mechanics the parent defers to here:

- **Joint objective.** After self-supervised pretraining the encoder is **not frozen**. Total loss during agent training is \(\mathcal{L} = \mathcal{L}_{\text{RL}} + \beta\,\mathcal{L}_{\text{SSL}}\), where \(\mathcal{L}_{\text{SSL}}\) is the standing self-supervised head (next-event timing/mark prediction + Hawkes-intensity distillation) and \(\mathcal{L}_{\text{RL}}\) is the policy/critic loss. RL gradients flow into the shared encoder alongside \(\mathcal{L}_{\text{SSL}}\), so the representation is shaped by *both* "reconstructs the tape" and "is decision-relevant." \(\beta\) is annealed: high early (keep the representation honest and stable on tiny per-token samples), lower later (let the task specialize it). **When to unfreeze** — immediately with a small encoder LR, or after an RL warmup — is a Phase-1 ablation.
- **The reflexive-impact correction is why joint training is mandatory, not optional.** The agent's own fills enter \(\lambda_{\text{buy}}/\lambda_{\text{sell}}\) and inflate the branching ratio \(n\) that would justify them (§8.4). An encoder frozen on passive-observer flow misreads the tape the instant the agent acts. Co-training on the agent's *own* interaction stream — with own-flow tagged as a covariate the model must subtract — is how the policy learns its impact on attention rather than trading its own shadow.
- **The stop-gradient boundary keeps the standalone signal clean.** The convergence/alert consumer (§6.2–6.3) reads a **stop-gradient copy of the SSL representation** — the attention state *without* the policy's task-shaping — so the shared signal stays flow-derived and mechanically independent of the agent's objective (preserving the non-double-counting property of parent §4.3), while the agent consumes the fully co-trained, task-specialized view. One backbone, two heads: a `detach()`ed public head and a task-coupled private head.
- **Ordering.** The model can be *born alone* — pretrained on the firehose and shipped as the §6.3 alert before the agent exists — then folded into joint training when Model N comes online. Standalone-first is the delivery hedge; codependence is the mature state.

---

## 7. Evaluation

The evaluation must answer three separable questions, and we keep them separate.

### 7.1 Does flow-derived attention predict runs / precede volume and price?

- **Lead–lag against price and volume.** Does the attention chart *lead* subsequent volume and price (cross-correlation at positive lag, Granger-style tests with the usual causality caveats)? Da et al.'s equity result — attention leads a run-up then a reversal — is the pattern to test for and, importantly, the **reversal is a predicted feature, not just the run-up**: a good attention chart should also anticipate the round-trip.
- **Run prediction.** Framed as prediction of forward outcomes (graduation / survival / a defined "run"), report the *distribution* of outcomes conditioned on the attention state, with strict walk-forward, time-ordered splits (never random) — inheriting the parent's data-hygiene and anti-leakage discipline.

### 7.2 Lead–lag vs external attention proxies (the endogenous-vs-exogenous test)

The distinctive scientific claim is that *endogenous* flow-attention is **earlier and more token-specific** than *exogenous* proxies. Test it directly: on tokens that *do* trend on Google/X, does \(\lambda_{\text{buy}}(t)\) rise *before* the search/social spike? If flow-attention consistently leads the external proxy, the endogenous measure earns its keep; if it merely lags social, it is redundant. This is the cleanest external-validity check available and it is honest — it can fail.

### 7.3 Ablation inside the parent agent (does the tier add edge?)

This reuses the parent's built-in ablation instrument (parent §8.4): compare the RL agent's risk-adjusted performance **with vs without** the attention encoder as the Phase-B representation, and against a raw-flow-features baseline (does the *learned attention encoder* beat hand-built ratios?). Plus the **leakage-guard**: replace the attention state with noise; performance must fall back to the raw-chart (Phase-A) level, proving the agent used real attention structure and not a leak. And the **convergence A/B**: OCT ranking with vs without the attention signal.

### 7.4 Calibration of the Hawkes estimate

- **Goodness-of-fit** via the time-rescaling theorem (rescaled inter-event times should be unit-rate exponential / the residual process should be Poisson) — a standard, honest point-process diagnostic.
- **Branching-ratio stability** across kernel specifications (exponential vs power-law), explicitly checking for the Hardiman et al. apparent-criticality artifact before trusting any \(n \approx 1\).
- **Authenticity calibration.** On tokens with *known* wash-trading / sniper-ring labels (from Cong et al.-style detectors and post-hoc rug labels), does the manipulation-suspicion channel actually separate organic from manufactured attention? This is where §7 meets §8.

---

## 8. Threats to validity / limitations (honest)

These are not a coda; for this sub-project they are the substance. Measuring "attention" from flow is *partially unidentifiable*, and pretending otherwise would be the paper's biggest failure.

### 8.1 The identification problem (the single biggest risk)

**Self-excitation is not identifiable from a common exogenous driver using flow alone.** A burst of clustered buys is equally consistent with (a) genuine endogenous attention — a real crowd feeding on itself — and (b) a hidden common cause — one piece of off-chain news, one influencer, or one coordinated actor — driving many arrivals that *look* self-exciting. The Hawkes decomposition into \(\mu(t)\) (exogenous) and the excitation term (endogenous) is notoriously fragile: a rising base rate \(\mu(t)\) and a high branching ratio \(n\) are substitutes in the likelihood, so the model can attribute the same tape to "lots of news" or "critical self-excitation" almost interchangeably. Filimonov & Sornette treat exactly this endogeneity estimate as the object of interest, and Hardiman et al. show its estimate is unstable and prone to spurious criticality. **Consequence: a high attention reading cannot, from flow alone, be decomposed into "genuine crowd attention" vs "one driver / manufactured cascade."** Everything else in §8 is a special, adversarial case of this one problem. Our honest posture: the attention chart is a *measurement of clustered flow intensity*, and its interpretation as "genuine crowd attention" is a **hypothesis that requires corroboration** (unique-buyer breadth, cross-signal convergence, authenticity channel) — never an identity.

### 8.2 Manipulation is the adversary — wash trading, bot volume, sybil buyers

This is §8.1 made hostile and made the *base case*. Cong et al. estimate wash trading exceeds 70% of reported volume on unregulated venues; pump.fun-style studies find the overwhelming majority of new pairs are pump-and-dumps or rugs with coordinated first-hour sniper rings. So the input stream is **adversarially generated by default**:

- **Wash trading / bot volume** manufactures precisely the clustered, self-exciting tape our model reads as attention. A deployer can *synthesize a high branching ratio* to fake ignition.
- **Sybil buyers** defeat the one feature that most resists a single actor — unique-buyer growth — by splitting one entity across many fresh wallets. And Lillo–Farmer's order-splitting result tells us the microstructure of *one actor splitting orders* is genuinely hard to distinguish from *many independent buyers*: the long-memory sign signature is the same. This is not a solvable-in-principle nuisance; it is a fundamental limit of what flow can reveal.

Mitigations reduce, they do not eliminate: inline Benford/round-number/size-distribution features (Cong et al.), wallet-age and funding-graph features (are the "unique" buyers freshly funded from one source?), concentration penalties, and the explicit *authenticity channel* that down-weights attention whose breadth is not corroborated. **We must never ship an attention signal without its manipulation-suspicion companion.**

### 8.3 Attention ≠ profit

Even *perfectly* measured genuine attention is not edge. Da et al.'s own result is that attention predicts a run-up **and then a reversal** — trading it naively is a good way to buy the top. High attention is where volume and volatility are (Andrei & Hasler), which is also where slippage, MEV, and rug risk are worst. The attention chart is an *input to* a decision, not a decision; the parent agent's risk-adjusted, cost-inclusive, benchmark-relative reward is what must convert attention into (or reject it as) profit. We state plainly: this sub-project measures a *driver*, and a driver of both gains and losses.

### 8.4 Reflexivity (measuring cannot be cleanly separated from acting)

At any non-trivial scale, acting on the attention signal *changes the tape it is measured from*: OCT's own buys (and its users', and copycats') add to \(\lambda_{\text{buy}}\), inflating the very branching ratio used to justify the buy — a feedback the parent flags as a general reflexivity risk. In the limit this is self-fulfilling ignition (and self-defeating on exit). The measurement is therefore not of a fixed external quantity but of a system that includes the measurer. We can bound but not remove this: model own-flow explicitly and subtract it from the intensity estimate, and treat the standalone-signal-vs-at-scale gap as a monitored metric (echoing the parent's paper→live fidelity meter).

### 8.5 Non-stationarity

The mapping from flow-attention to outcomes is regime-dependent: the branching ratio that meant "run incoming" in one meta may mean "efficient bot farm" in the next. The kernels themselves drift. This inherits the parent's stance — non-stationarity is the design, handled by recent-window fitting, continual re-estimation, and regime-context inputs — but it means the attention model, like everything else here, is perpetually mid-adaptation, not trained once.

### 8.6 Small-sample and cold-start

The decisive first minutes are exactly when the tape is shortest and Hawkes estimates are least stable (§4.5). Cross-token pooling and the transfer-learning encoder mitigate but cannot conjure information that is not yet in the tape; the earliest attention readings are the least reliable, which is the opposite of what a first-mover would want. We report attention *with* an uncertainty band widest at cold-start, and refuse point-estimate confidence there.

---

## 9. Phased mini-roadmap (and how it slots into the parent program)

The sub-project's phases are deliberately aligned to the parent's, so it lands as the parent needs it.

- **M0 — Data & the tape (aligns with parent Phase 0 / simulator foundations).** Reuse the parent's Pinax new-pair firehose to assemble the point-in-time swap tape (swaps, liquidity events, holder deltas, wallet tags), leakage-audited. *Exit:* a causal, per-token event stream reconstructable at any timestamp, with wallet-tag and rug/wash labels attached for evaluation.

- **M1 — Hawkes backbone & the attention chart (aligns with parent Phase B onset).** Fit multivariate Hawkes per token with cross-token pooling; produce \(\lambda(t)\), \(n(t)\), and the authenticity features; validate with time-rescaling GoF and branching-ratio-stability checks. *Exit:* an attention chart with calibrated goodness-of-fit and a manipulation-suspicion channel that separates known wash/organic tokens above a pre-registered bar.

- **M2 — Self-attention encoder & standalone signal.** Train the causal transformer encoder self-supervised on the firehose (with the Hawkes intensity as a distillation target); calibrate the standalone "attention igniting" alert; run the lead–lag-vs-external-proxy study (§7.2). *Exit:* an out-of-sample-validated encoder whose attention score leads external proxies on the tokens where both exist, and a shippable standalone OCT alert with its authenticity companion.

- **M3 — Integration into the parent agent (aligns with parent Phase 2/Phase B ablation).** Wire the encoder as the Phase-B observation representation; run the with/without and leakage-guard ablations (§7.3); register the signal in the convergence layer and run the convergence A/B. *Exit:* a credible measured marginal edge from the attention encoder inside the agent (or an honest report that hand-built flow features suffice and the encoder does not add), plus a positive convergence A/B.

- **M4 — Reflexivity & at-scale monitoring.** Add own-flow subtraction, monitor the standalone-vs-at-scale gap, and fold the attention model into the parent's continual-learning loop with regime-conditioned re-estimation. *Exit:* a monitored reflexivity/fidelity gap and a re-estimation cadence that tracks the meta.

**Net slotting:** M0–M1 deliver the Phase-B encoder the parent needs; M2 delivers a standalone OCT signal that ships independently; M3 delivers the ablation number that tells the parent program whether the flow tier is worth its complexity; M4 keeps it honest at scale. If the lead–lag test (§7.2) or the ablation (§7.3) fails, the correct outcome is to *report that flow-attention adds no edge over raw flow features* and simplify — the same falsifiability discipline the parent program insists on.

---

## References (by name; representative prior work)

- Hawkes, A. G. (1971). *Spectra of some self-exciting and mutually exciting point processes.* Biometrika 58(1):83–90.
- Kyle, A. S. (1985). *Continuous Auctions and Insider Trading.* Econometrica 53(6):1315–1336.
- Lillo, F. & Farmer, J. D. (2004). *The Long Memory of the Efficient Market.* (with the Lillo–Mike–Farmer order-splitting model, 2005.)
- Peng, L. & Xiong, W. (2006). *Investor Attention, Overconfidence and Category Learning.* J. Financial Economics 80(3):563–602.
- Barber, B. M. & Odean, T. (2008). *All That Glitters: The Effect of Attention and News on the Buying Behavior of Individual and Institutional Investors.* Review of Financial Studies 21(2):785–818.
- Da, Z., Engelberg, J. & Gao, P. (2011). *In Search of Attention.* Journal of Finance 66(5):1461–1499.
- Filimonov, V. & Sornette, D. (2012). *Quantifying reflexivity in financial markets: towards a prediction of flash crashes.* Physical Review E 85:056108.
- Hardiman, S. J., Bercot, N. & Bouchaud, J.-P. (2013). *Critical reflexivity in financial markets: a Hawkes process analysis.* Eur. Phys. J. B 86:442.
- Kristoufek, L. (2013; 2015). *BitCoin meets Google Trends and Wikipedia*; and later work on search attention, crypto returns and bubbles.
- Cont, R., Kukanov, A. & Stoikov, S. (2014). *The Price Impact of Order Book Events.* J. Financial Econometrics 12(1):47–88.
- Bacry, E., Mastromatteo, I. & Muzy, J.-F. (2015). *Hawkes Processes in Finance.* Market Microstructure and Liquidity 1(1):1550005.
- Andrei, D. & Hasler, M. (2015). *Investor Attention and Stock Market Volatility.* Review of Financial Studies 28(1):33–72.
- Vaswani, A., et al. (2017). *Attention Is All You Need.* NeurIPS 2017.
- Zhang, Z., Zohren, S. & Roberts, S. (2019). *DeepLOB: Deep Convolutional Neural Networks for Limit Order Books.* IEEE Trans. Signal Processing 67(11):3001–3012.
- Wallbridge, J. (2020). *Transformers for Limit Order Books* (TransLOB); and subsequent LOB transformers (e.g., dual-attention TLOB; LiT, 2025).
- Cong, L. W., Li, X., Tang, K. & Yang, Y. *Crypto Wash Trading.* (NBER w30783 / SSRN.)
- Crypto-Hawkes and endogeneity-of-crypto-markets literature; DEX wash-trading and pump.fun launchpad empirical studies (self-exciting crypto trade arrivals; multivariate Hawkes for BTC/USD; quantifying endogeneity of cryptocurrency markets; coordinated first-hour sniper cohorts on Solana launchpads).

*Note: citations are to real, well-known prior work identified by name and year for the reader to locate; this proposal reports no experimental results and cites no numeric findings from these works except where explicitly attributed to a named source (e.g., Cong et al.'s >70% wash-volume estimate) as motivating context, not as a claimed result of this project.*

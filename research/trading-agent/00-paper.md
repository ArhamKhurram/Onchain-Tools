# An Autonomous Reinforcement-Learning Agent for New-Pair Memecoin Trading: A Progressive-Information Curriculum, Design Specification, and Research Program

**Onchain Tools (OCT) — Research & Specification Paper**
**Status:** Proposal / specification (not a results paper)
**Version:** 0.1 (draft for internal review)
**Date:** 2026-08-22

> **Note.** This is the canonical in-repo copy of the source-of-truth research paper for
> the OCT autonomous-trading-agent R&D program. It is also intended for publication as a
> shareable artifact. Every other document in `research/trading-agent/` is derived from and
> must stay consistent with this paper — if a downstream doc and this paper disagree, this
> paper wins. See [`README.md`](./README.md) for the reading order and workspace overview.

---

## Abstract

We specify — and critically evaluate the feasibility of — an autonomous agent that learns to trade newly launched ("new-pair") memecoins on Solana (and later BNB Chain) through reinforcement learning (RL). The agent is designed as a companion to Onchain Tools' existing *revival* detector, which fires on dormant tokens re-igniting; the new subsystem instead focuses on tokens in their first minutes-to-hours of life and *acts* on them by self-trading a paper balance. The operator's stated north-star is to grow a simulated balance from 1 SOL to 100 SOL learning "from nothing but the goal," in the spirit of DeepMind's from-scratch game-playing agents, and subsequently to *outperform a database of labeled real traders on a per-token basis* so as to discover an idiosyncratic edge or "personality."

The central novel contribution we propose is a **progressive-information curriculum**: the agent starts from *nothing but the raw numbers* — price, liquidity, and volume series only, no wallet data and no metadata ("trading the chart naked") — and is then successively granted **on-chain wallet flows**, then token metadata, then narrative/social signals with a web-search tool, and finally the live Discord/Telegram caller chatter that OCT already ingests — with mastery of each tier gating access to the next. Ordering the tiers this way (and, in particular, holding wallet flows out of the first phase) lets us price each information source separately, starting from a genuinely information-free baseline. This curriculum is both a training device (it isolates the marginal value of each information source, giving us built-in ablations) and a hypothesis about how information flow itself drives memecoin price formation.

We are deliberately honest about what will and will not work. Markets are non-stationary, partial-information, adversarial, and — unlike Go, StarCraft, or Dota — **not self-playable**: a paper agent's simulated fills do not move the real market, so market impact, slippage, MEV, and liquidity dynamics, which are much of the actual game, are absent from a *naive* simulator. We are explicit that *exploiting asymmetric opportunity is the goal, not a bug* — the entire on-chain game is finding and taking asymmetric bets — so the real constraint is not "does the agent exploit?" but **simulator fidelity**: an exploit found in a *faithful* simulator (honest slippage, impact, MEV, liquidity, latency, and rug dynamics) is a genuine transferable edge, whereas only exploits of simulator *artifacts* (infinite size at zero impact, impossible fills) are worthless. The engineering bar is therefore a simulator faithful enough that its exploits equal the chain's — then let the agent hunt asymmetry aggressively. We further argue that the 1→100 SOL objective, taken literally as a reward, explicitly incentivizes lottery-like, martingale risk. We therefore propose: (i) a high-fidelity replay simulator built from real on-chain data with an explicit execution/impact model; (ii) offline and imitation-RL bootstrapping from a database of active, daily-trading wallets with full win-and-loss histories (CQL/IQL, GAIL) so the agent does not start from absolute zero; (iii) risk-adjusted, benchmark-relative, shaped rewards for training, with 1→100 SOL retained only as an evaluation north-star; (iv) distributional critics to respect fat-tailed returns; (v) a **population/evolutionary** design — Population-Based Training, evolution strategies, and quality-diversity (MAP-Elites) — whose deliverable is a *diverse ensemble of profitable archetypes* (distinct evolved "personalities"), not a single optimum; and (vi) **non-stationarity treated as the design, not a caveat**: recent-window replay (on the order of the past few days) with continual online adaptation, fast meta-adaptation, regime detection, and explicit defenses against catastrophic forgetting. We define a strict backtest → paper → live promotion gate, reusing OCT's existing sniper safety envelope (per-fire/daily caps, kill switch) as the live boundary, and we catalog the threats to validity — reward hacking, the residual selection bias in *which* traders are active enough to be labeled, sim-to-real fidelity gaps, adversarial rugs/MEV, and the catastrophic-risk profile of an autonomous agent handed real money and a 100× goal. The paper closes with a phased roadmap, per-phase compute/data/engineering requirements, and concrete milestones.

---

## 1. Introduction

### 1.1 Problem

Memecoin markets on high-throughput chains (Solana; BNB Chain via analogous launchpads) produce thousands of new token pairs per day. A small minority "run" — appreciate by one to three orders of magnitude within minutes to days — while the overwhelming majority go to zero, many by explicit design (rug pulls, honeypots, sniped-and-dumped launches). The distribution of per-token returns is extremely fat-tailed, heavily right-skewed at the winners' end and censored at zero on the losers' end. Human traders in this arena rely on a fluid mixture of on-chain flow reading, social-narrative judgment, and information-network position (who is calling what, and when). No published system, to our knowledge, learns this end-to-end.

OCT already operates the surrounding intelligence console: it ingests Discord and Telegram streams, detects and enriches contract addresses, tracks fomo.family traders, and raises convergence/missed-runner alerts. It also ships a *revival* model (dormant tokens re-igniting) and a custodial *sniper* that can execute operator-declared buys under hard caps and a kill switch. The question this paper addresses is whether — and how — we can build an agent that *decides for itself* what to trade among new pairs, learning continuously from its own outcomes.

### 1.2 Thesis

We argue four things:

1. **The right framing is a partially observable Markov decision process (POMDP) with a shaped, risk-adjusted, benchmark-relative reward — not a sparse "reach 100 SOL" reward.** The literal 1→100 objective is a valid *evaluation* north-star but a pathological *training* signal.

2. **Pure from-scratch self-play RL, the paradigm behind the DeepMind game agents the operator cites, does not transfer *as a data-generation strategy*** — not because exploiting the environment is wrong (finding and taking asymmetric bets is the entire point), but because markets are not self-playable and *a naive simulator's exploits are artifacts, not edge*. The distinction that matters is **simulator fidelity**: exploits of a faithful sim transfer; exploits of an unfaithful one do not. The realistic path bootstraps from real data (offline/imitation RL from a database of active, full-history trading wallets) and trains against a high-fidelity replay simulator with an explicit execution model, then continues online — and then lets the agent exploit that faithful sim as aggressively as it can.

3. **The progressive-information curriculum is the paper's novel core.** Structuring learning as a sequence of information tiers — raw chart → wallet flows → metadata → narrative/social → crowd chatter — is simultaneously (a) a curriculum-learning device that improves sample efficiency and stability, (b) a built-in ablation that quantifies the marginal edge of each information source (with a genuinely information-free Phase-A baseline), and (c) a substantive hypothesis about memecoin price formation being driven by information *flow*.

4. **The deliverable is a diverse population, and non-stationarity is the design.** We do not seek a single optimal policy; we breed and keep a *diverse ensemble of profitable archetypes* via population-based/evolutionary and quality-diversity methods, on the premise that — as in a real market — many distinct styles survive and outperform at once. And because the memecoin meta shifts continuously, the system is built around recent-window replay and continual online adaptation from the outset, not trained once and frozen.

### 1.3 Contributions

- A POMDP formulation of new-pair memecoin trading with per-phase observation spaces, a concrete action space, and a **short-horizon episode definition** — the default archetype is a fast, high-volume scalper on freshly launched tokens (seconds-to-minutes), with population diversity permitting some longer-hold personalities — plus a principled critique of the 1→100 reward with a proposed replacement (§3).
- A two-model system architecture (revival + new-pair) with a later independent-signal ensemble/convergence layer consistent with OCT's design principle that signals stay independent and are fused only at scoring (§4).
- The progressive-information curriculum — raw chart → wallet flows → metadata → narrative/social → crowd chatter — with explicit gating criteria and tools introduced per phase, starting from a genuinely information-free baseline (§5).
- A training methodology that confronts the sim-to-real gap directly: high-fidelity replay simulation, offline/imitation bootstrapping, distributional critics, a **population/evolutionary and quality-diversity design** (PBT, evolution strategies, MAP-Elites) whose product is a diverse ensemble of profitable archetypes, a decision-transformer alternative, and an online continual-learning loop — with non-stationarity treated as the core methodology, not a caveat — with anti-forgetting defenses (§6).
- A data plan distinguishing what OCT already has from what must be built (§7).
- An evaluation protocol: risk-adjusted metrics, per-token outperformance vs labeled traders, per-phase ablations, and a strict backtest → paper → live gate reusing the sniper safety envelope (§8).
- A rigorous threats-to-validity analysis, including the catastrophic-risk and ethics dimensions of releasing an autonomous money-spending agent (§9).
- A phased roadmap with compute/data/engineering requirements and measurable milestones (§10).

We stress throughout: this is a *specification and research program*, not a results report. We report no returns, no Sharpe ratios, no win rates. Any number in this document is a target, a threshold, or an illustrative parameter, never a claimed outcome.

---

## 2. Related Work

### 2.1 From-scratch and self-play RL in games

The operator's inspiration is the DeepMind lineage of agents that learn superhuman play "from nothing but the goal." **DQN** (Mnih et al., 2015) learned Atari from pixels and reward alone. **AlphaGo** and then **AlphaGo Zero** / **AlphaZero** (Silver et al., 2016; 2017; 2018) reached superhuman Go, chess, and shogi via self-play and Monte-Carlo tree search with no human data in the Zero variants. **MuZero** (Schrittwieser et al., 2020) removed the need for a known environment model, learning a latent dynamics model and planning within it. **AlphaStar** (Vinyals et al., 2019) reached grandmaster StarCraft II using imitation from human replays *plus* league-based self-play and population-based training. **OpenAI Five** (Berner et al., 2019) mastered Dota 2 through large-scale self-play PPO.

These systems share four properties that make them succeed and that a memecoin market **violates**:

1. **A stationary, known ruleset.** Go's rules never change; a memecoin "meta" shifts weekly and adversaries adapt to any exploited pattern.
2. **Self-playability.** In a game, the agent's actions *are* the environment for a symmetric opponent, so self-play generates unlimited on-distribution data and a natural curriculum of ever-stronger opponents. In a market, a paper agent's trades do not move price; the environment is exogenous and cannot be regenerated by self-play. (Multi-agent market *simulation* is possible but is a research problem in its own right and does not reproduce the real order flow.)
3. **A perfectly faithful simulator.** Games are their own simulators. A market simulator is an approximation whose gaps (impact, slippage, MEV, latency, liquidity withdrawal) are exactly where money is made and lost.
4. **Cheap, safe exploration.** A losing game move costs nothing; a losing trade costs real capital, and the winning-tail structure means naive exploration is dominated by ruin risk.

We cite this lineage not to promise it transfers, but to be explicit that **the parts of it that transfer are the algorithms (PPO, MCTS/MuZero-style planning, population-based training, imitation-plus-RL as in AlphaStar), not the from-scratch-self-play data-generation paradigm.**

### 2.2 RL for trading and finance

There is a substantial literature applying RL to portfolio allocation, execution, and market making (e.g., Moody & Saffell's early recurrent-RL trading; Deng et al. on deep direct RL; Nevmyvaka et al. on RL for optimal execution; and a large body of deep-RL-for-trading work through the 2020s). The consistent lessons are cautionary: results are highly sensitive to transaction-cost and slippage modeling; backtest overfitting is rampant; non-stationarity degrades live performance relative to backtests; and many published "profits" evaporate under realistic execution. Memecoin new-pairs are an *extreme* instance of every one of these hazards — thin liquidity, enormous slippage, adversarial counterparties — which raises the bar on execution realism rather than lowering it.

### 2.3 Imitation and inverse RL

**Behavioral cloning** learns a policy by supervised imitation of expert actions but suffers covariate shift (compounding errors off the expert's state distribution; DAgger, Ross et al. 2011, addresses this with on-policy correction). **Inverse RL** (Ng & Russell, 2000; Abbeel & Ng, 2004) infers a reward function from expert demonstrations. **GAIL** (Ho & Ermon, 2016) learns to imitate via an adversarial discriminator without recovering an explicit reward, and **AIRL** (Fu et al., 2018) recovers a transferable reward. These are directly relevant to the "learn from labeled traders" stage: we can bootstrap a policy from real traders' on-chain actions before switching to RL that surpasses them. The caveat — developed in §9 — is a **residual selection effect**: because we label *active, daily* traders by their *full* on-chain histories (wins and losses alike, not cherry-picked winning trades), the demonstration data already contains failure, which defuses the classic survivorship trap; what remains is the milder "who is still active enough to be worth labeling" bias, which we mitigate by broadening the labeled cohort and by treating imitation as a warm-start prior only.

### 2.4 Curriculum learning

**Curriculum learning** (Bengio et al., 2009) orders training from easier to harder to improve convergence and generalization. **Automatic curricula** and self-play leagues (AlphaStar) generate their own difficulty gradient. **Teacher-student / automatic goal generation** and **POET**-style open-ended approaches co-evolve tasks and agents. Our progressive-information curriculum is an *information-availability* curriculum rather than a task-difficulty curriculum: the environment is fixed but the observation space is expanded in stages. This is closer in spirit to *privileged-information* and *asymmetric actor-critic* schemes (e.g., learning with a privileged critic then distilling to a restricted-observation actor) and to representation-first pretraining, and we draw on those framings in §5–§6.

### 2.5 Offline RL and offline→online

**Offline (batch) RL** learns from a fixed dataset without environment interaction, which matches our situation of abundant historical on-chain data and expensive/ risky live interaction. The core problem is distributional shift and overestimation of out-of-distribution actions; **CQL** (Kumar et al., 2020) learns conservative Q-values that lower-bound the true value, and **IQL** (Kostrikov et al., 2022) avoids querying out-of-sample actions via expectile regression. **Offline-to-online** fine-tuning (e.g., AWAC, Nair et al. 2020; and subsequent work) initializes from offline data then continues online. This is the backbone of our training plan: offline-pretrain on historical data and demonstrations, then carefully fine-tune in paper-live.

### 2.6 Distributional RL

**C51** (Bellemare et al., 2017) learns a categorical distribution over returns rather than a scalar mean; **QR-DQN** (Dabney et al., 2018) uses quantile regression; **IQN** (Dabney et al., 2018) learns an implicit quantile function. For memecoins — where the return distribution is violently fat-tailed and the whole point is to size positions against tail risk — modeling the *distribution* of returns (and its quantiles/CVaR) is not a refinement but a requirement. Distributional critics also enable risk-sensitive policies (optimize CVaR, not expectation), directly addressing the martingale pathology of the naive goal.

### 2.7 Population-based / evolutionary training, quality-diversity, and decision transformers

This family of methods is **first-class** to our design, not a tuning add-on (§6.4). **Population-Based Training** (Jaderberg et al., 2017) jointly optimizes a population of agents and their hyperparameters, exploiting and exploring across the population. **Evolution strategies** (Salimans et al., 2017) treat policy search as black-box evolutionary optimization, which is naturally parallel and robust to noisy, non-differentiable objectives — a good fit for fat-tailed trading returns. **Quality-diversity** methods, in particular **MAP-Elites** (Mouret & Clune, 2015) and Novelty Search (Lehman & Stanley, 2011), explicitly optimize for an *illuminated archive* of high-performing solutions that are diverse along chosen behavioral axes (e.g., holding time, risk appetite, narrative sensitivity) rather than for a single optimum. Together these give the founder's intuition a formal backbone: as in a genetic algorithm — where a few genes may be "best" yet the population retains real diversity — and as in a real market where many trader *types* survive and outperform simultaneously, the deliverable is a diverse ensemble of profitable archetypes, each an evolved "personality," not one policy. Two honest constraints travel with this (developed in §6.4): the diversity must be validated **out-of-sample and across regimes** (a hundred agents overfit to one replay window are correlated failure, not robustness), and each surviving personality must be **individually edge-positive**, not merely different. **Decision Transformer** (Chen et al., 2021) and **Trajectory Transformer** (Janner et al., 2021) recast RL as return-conditioned sequence modeling, which is an attractive alternative given (a) the sequential, multi-modal nature of the observation stream (numeric series + text chatter) and (b) the ability to condition on a desired return — though return-conditioning must be used cautiously here precisely because conditioning on extreme returns re-introduces the lottery-seeking behavior we want to avoid.

---

## 3. Problem Formulation

### 3.1 A POMDP

We model new-pair trading as a POMDP
\((\mathcal{S}, \mathcal{A}, \mathcal{O}, T, Z, R, \gamma)\):
states \(s \in \mathcal{S}\) (the full market/social/network state, never fully observed); actions \(a \in \mathcal{A}\); observations \(o \in \mathcal{O}\) drawn via \(Z(o\mid s)\); transition \(T(s'\mid s,a)\); reward \(R\); discount \(\gamma\). Partial observability is fundamental, not incidental: the agent never sees insiders' intentions, pending rug transactions, or off-chain coordination. The agent must therefore maintain **belief state** — in practice, a recurrent or transformer encoder over the observation history.

### 3.2 Observation space (per curriculum phase)

The observation is the concatenation of an always-present *raw chart core* with phase-gated additions (§5) — beginning with wallet flows, which are deliberately *not* part of the always-present core. All features are causal (no look-ahead) and timestamped; text is embedded with a frozen or slowly-updated encoder.

- **Raw chart core (Phase A):** per-token price, liquidity (pool reserves), traded volume, trade count, and buy/sell *volume* imbalance — everything computable from the price/liquidity/volume tape **without resolving individual wallets**. Represented as multi-resolution time series (e.g., event-time and fixed-interval bars) plus a snapshot vector. **No wallet identities or holder attribution, and no names, tickers, or text.** This is the "naked chart" tier — the deliberately information-free starting point.
- **+ Wallet flows (Phase B):** the on-chain flow features derived from OCT's feed once wallets may be resolved — unique-buyer/seller counts, holder-count deltas, inflow from wallets tagged smart-money vs fresh/bot, concentration (top-holder share), and creator-wallet behavior. This is the first tier that reads *who* is trading, not just *how much*; several of these (creator dumping, concentration) are early rug-flow signatures.
- **+ Token metadata (Phase C):** name, ticker, decimals, total/circulating supply, mint/freeze authority status, LP-burn/lock status, launchpad/venue, contract-safety flags. These are largely static per token; several are *rug-risk* features.
- **+ Narrative/social (Phase D):** the token's X/Twitter account and its stats; cross-platform social engagement (TikTok/Instagram/X); and the *outputs of a web-search tool* the agent may invoke to research the narrative. Represented as text embeddings + structured counts. Introduces an **active information-gathering action** (query the web-search tool), i.e., the observation is partly agent-elicited.
- **+ Crowd chatter (Phase E):** the Discord/Telegram caller messages OCT ingests, resolved to the token — who is calling it, how loudly, with what latency relative to price, and the caller's historical reliability (OCT's honest-caller scoring). This is the "information-flow" tier.

We standardize/normalize per-feature with causal statistics and explicitly encode missingness (new pairs have sparse, ragged data). A key modeling choice: **per-token encoder → cross-token context**, so the agent can condition a token's decision on the current market-wide regime (how are new pairs behaving *today*), which is essential given non-stationarity.

### 3.3 Action space

The domain itself constrains the action space. Freshly launched pairs live and die in seconds to minutes, so the **default archetype is a fast, high-volume, short-horizon scalper**, not a buy-and-holder: the agent decides frequently, sizes into brief asymmetric windows, and exits quickly. The action cadence is therefore high-frequency and the position lifetime short by default. (Population diversity, §6.4, may evolve some longer-hold personalities — a slower "let a runner run" style is a legitimate archetype — but the base case, and the base episode below, is the scalper.)

We propose a **hybrid discrete-continuous** action per decision step, per candidate token:

- **Discrete intent:** {no-op / ignore, open-long, add, trim, close, hold}. (Memecoin new-pairs are effectively long-only; shorting infrastructure is largely absent, so we do not model shorts in the alpha.)
- **Continuous size:** target position as a fraction of a *risk budget*, bounded (e.g., \([0, f_{\max}]\)) with a hard per-token cap. Sizing is where distributional/risk-sensitive value estimates enter.
- **Phase-D+ information actions:** {issue web-search query, no query}, with a cost (see reward) to prevent free unlimited querying.
- **Execution parameters (optional, later):** slippage tolerance / limit offset, order-splitting — only meaningful once the execution model (§6.2) is rich enough to reward them.

Discretizing size into a few buckets (as in many trading-RL works) is a viable simplification for early phases; we prefer a continuous head with a squashing bound (as in PPO/SAC-style policies) so the "personality" can express nuanced sizing. Candidate generation (which tokens are even eligible each step) is handled upstream by OCT's new-pair detection; the agent acts on a rolling watchlist, not the entire chain.

### 3.4 Episode definition

Two complementary episode structures, used at different stages:

- **Per-token episodes** (default for early phases and for per-token benchmarking): an episode begins when a new pair enters the watchlist and ends at a **short horizon** — reflecting the scalper default (§3.3), the max holding time is on the order of seconds-to-minutes, with earlier termination on full exit, token death, or liquidity below a floor. This isolates the token-level decision and matches the "outperform traders on every single token" objective. Longer-hold horizons are permitted only for the specific population members (§6.4) whose evolved archetype is a slower style; they are the exception, not the default.
- **Per-session (portfolio) episodes** (later): a fixed wall-clock window over the whole watchlist, with a shared balance and portfolio constraints (max concurrent positions, total exposure). This is where capital allocation *across* tokens, and the 1→100 balance trajectory, actually live.

The two are consistent: per-token value functions feed the portfolio-level allocator. We recommend developing per-token competence first, then composing.

### 3.5 The objective — and why "1 SOL → 100 SOL" is the wrong *reward*

The operator's north-star is to grow 1 SOL to 100 SOL. As a **reward signal**, taken literally, this is a terminal, sparse, all-or-nothing bonus for reaching a 100× balance. This is pathological for three compounding reasons:

1. **Sparsity.** A 100× terminal reward gives almost no gradient over the millions of intermediate decisions; credit assignment is hopeless without shaping.
2. **It explicitly rewards ruin-seeking.** The expected-value-maximizing way to turn 1 into 100 with a terminal-only "did you reach 100?" reward is to bet as aggressively as possible — the classic *bold-play* solution to the gambler's-ruin problem is optimal for hitting a fixed multiple in a sub-fair game. The agent would learn a martingale/lottery policy that occasionally 100×'s and usually goes to zero. This is *exactly* the tilt failure the operator is trying to cage in human traders; encoding it as the reward hard-codes the pathology.
3. **No risk term.** It is indifferent between reaching 100 SOL smoothly and reaching it via a near-death drawdown, so it will not learn risk control.

**Proposed training reward.** We optimize a **shaped, risk-adjusted, benchmark-relative** reward, with the 1→100 run retained purely as an *evaluation* metric (§8):

- **Per-step PnL with realistic costs.** Mark-to-market change net of modeled fees, slippage, and price impact (§6.2). This densifies the signal.
- **Risk penalty.** Penalize drawdown and return volatility — e.g., a differential Sharpe/Sortino-style ratio (Moody & Saffell) updated online, or a CVaR/downside-deviation penalty. Equivalently, optimize a risk-sensitive objective directly via the distributional critic (§6.3), maximizing e.g. CVaR\(_\alpha\) of returns rather than the mean.
- **Benchmark-relative term (the traders-as-opponents stage).** For each token the agent traded, reward its *outperformance versus the labeled traders on that same token* — the realized-PnL edge over the cohort's actions on that token, controlling for entry/exit timing. This operationalizes "outperform these traders on every single token" as a dense, per-token advantage rather than a global balance.
- **Information-cost term.** Small negative reward per web-search/tool invocation (Phase D+), so the agent learns *when* information is worth acquiring.
- **Explicit no-trade baseline.** Holding SOL (doing nothing) is a legitimate, often-correct action; the reward must not implicitly punish inaction relative to a churn policy. We benchmark against "hold SOL" and against "buy-and-hold the token."

We also *constrain* rather than merely penalize the worst behaviors: hard per-token and per-session position caps and a max-drawdown circuit-breaker enter as **environment constraints / action masks**, not soft rewards — consistent with treating catastrophic risk as a safety layer, not a tunable trade-off (§9, §10). This is a constrained-MDP (CMDP) framing: maximize risk-adjusted return subject to hard risk constraints.

**Why keep 1→100 at all?** As an evaluation north-star it is honest and legible: it is the operator's success criterion and a single, interpretable headline. But it is a *report card*, not a *teacher*.

---

## 4. System Architecture

### 4.1 Two models

**Model R — Revival (existing, extended).** OCT already runs a revival detector that fires on dormant tokens re-igniting. We extend it from a *detector/alerter* toward a *policy* that can also size and time entries on revival setups, reusing the same RL scaffolding (§6) but on a different candidate stream (dormant-then-reawakening tokens) and a different feature regime (tokens with history). Revival tokens have a *past*, which makes their features richer and their simulation more tractable than brand-new pairs.

**Model N — New-pair (new).** The subject of this paper: acts on tokens in their first minutes-to-hours, where history is nearly absent and the signal is dominated by flow, metadata safety, narrative, and chatter.

The two are trained separately because their observation distributions, horizons, and failure modes differ, and because OCT's design principle is that **distinct signals stay independent and are fused only at a scoring layer** (never merged at the detection level).

### 4.2 Interfaces

Each model exposes a common interface to the rest of OCT:

- **Input:** a candidate token + its causal feature bundle (assembled by OCT's existing ingestion/enrichment: contract detection, GMGN/DexScreener enrichment, on-chain resolve, caller attribution).
- **Output:** a *typed decision* — intent, size, confidence/value distribution, and a rationale trace (which features/tools drove it) — plus a *signal contribution* for the convergence layer.

Model N never touches funds directly. In paper mode it writes to a simulated ledger; in any eventual live mode it can only *propose* to the existing sniper control plane (`/sniper/v1`), which independently enforces caps, kill switch, and auth (§10.4). The agent is a *policy*, the sniper is the *actuator and safety envelope*; they are separate by construction.

### 4.3 The ensemble / convergence layer

OCT already computes multi-signal convergence across independent signals: honest caller scoring, FOMO smart-money wallets, revival, and pump/KOL callouts. Model N becomes **one more independent signal** into that layer. Crucially, per OCT's principle, we **do not fuse the underlying detections** — we fuse *scores*. The convergence layer takes each signal's calibrated output and combines them (e.g., a learned or rules-based scorer) into the console's ranking and, later, into any gated live action. This preserves interpretability (each signal can be inspected and disabled independently) and prevents a single model's failure from silently corrupting the others. It also means the RL agent's edge can be *measured marginally*: convergence-with-N vs convergence-without-N is a clean A/B.

---

## 5. The Curriculum

The curriculum expands the observation space in **five** gated phases. The environment (real token histories / live pairs) is fixed; what changes is *what the agent is allowed to see and do*. Each phase adds an information tier and, from Phase D, a tool. The ordering is deliberate: wallet flows — arguably the single most powerful non-price signal — are held out of the first phase so that Phase A measures what can be earned from *nothing but the chart*, and Phase B then prices what wallet data alone is worth. The point is to measure what each information tier is worth, one tier at a time, starting from truly nothing.

### 5.1 Phase A — "Trade the chart, naked"

**Observations:** raw chart core only — price, liquidity, volume, trade count, buy/sell volume imbalance. **No wallet data, no metadata, no text.**
**Rationale:** the deliberately information-free starting point. It forces the agent to learn pure price/liquidity microstructure — the substrate every later tier modulates — and it produces the cleanest conceivable baseline: whatever edge exists here comes from the chart alone, before *any* knowledge of who is trading, what the token is, or what anyone is saying about it.
**Actions:** trade only (no information actions yet).
**What we expect it can and cannot learn:** it can learn momentum/liquidity/price-microstructure patterns; it *cannot* see who is buying (that is Phase B) or distinguish two identical-looking charts that differ in flow, safety, or narrative — those ceilings motivate each subsequent tier.

### 5.2 Phase B — Wallet flows

**Adds:** on-chain flow features once wallets may be resolved — unique-buyer/seller counts, holder-count deltas, smart-money vs fresh/bot inflow, top-holder concentration, and creator-wallet behavior.
**Rationale:** this is the first tier that reads *who* is trading rather than only *how much*. Wallet flow is where rug-adjacent signatures (creator dumping, extreme concentration) and smart-money footprints first appear; isolating it as its own gate measures exactly how much the "who" is worth on top of the "how much."
**Gating:** unlocked once Phase A reaches a stability/competence bar (§5.6).

### 5.3 Phase C — Token metadata

**Adds:** name, ticker, supply, mint/freeze authority, LP lock/burn, venue, safety flags.
**Rationale:** much of this is *rug-risk* and *legitimacy* signal that neither chart nor flow reveals. Ticker/name embeddings also begin to capture crude narrative priors (meta words) without full social access.
**Gating:** unlocked once Phase B reaches its bar (§5.6).

### 5.4 Phase D — Narrative / social

**Adds:** the token's X/Twitter account and stats; cross-platform social engagement (TikTok/Instagram/X); and a **web-search tool** the agent can invoke to research the narrative.
**New action:** issue a web-search query (costed). The agent must learn *when* researching is worth the latency/cost and how to convert retrieved text into a decision.
**Rationale:** memecoin runs are narrative phenomena; this tier tests whether narrative comprehension adds edge beyond flow+metadata.
**Engineering:** requires a retrieval/tooling harness, social-stats connectors, and a text encoder. Tool outputs are untrusted external content and are treated as *data*, never as instructions to the agent's controller (a prompt-injection surface — see §9.7).

### 5.5 Phase E — Information flow (crowd chatter)

**Adds:** Discord/Telegram caller messages resolved to the token (OCT already ingests these), with caller identity, call timing relative to price, and caller reliability (honest-caller scoring).
**Rationale:** this is the operator's core hypothesis — that *information flow* (who says what, when, and how the crowd reacts) moves coins. Phase E lets the agent learn the propagation of a call through the network and to *front-run the crowd's reaction rather than the crowd's tip*.
**Risk:** this tier is the most adversarial (callers coordinate, shill, and bait) and the most prone to teaching the agent manipulation-following; §9 treats it.

### 5.6 Gating: mastery unlocks the next tier

A phase unlocks the next only when the agent demonstrates **stable competence** at the current tier, judged on held-out tokens/time windows by: (i) risk-adjusted performance clearing a pre-registered bar; (ii) *stability* (low variance across seeds and across recent regimes); and (iii) **no degradation** when the new features are ablated to noise (a guard against the agent having already latched onto leakage). We use **asymmetric / privileged-information training** as an option: train a privileged critic that sees the richer tier while the actor is still restricted, then distill — this smooths the transition between tiers and gives an upper bound on the marginal value of the next tier before we commit to it.

The gating is also our **ablation design** (§8.4): because each of the five tiers is introduced cleanly, the performance delta at each gate *is* the measured marginal edge of that information source — chart alone, then the increment from wallet flows, then metadata, then narrative/social, then chatter. This is the mechanism by which the curriculum doubles as a scientific instrument.

---

## 6. Training Methodology

This is the honest core of the paper. We first confront why the operator's cited paradigm does not transfer, then specify the path that can.

### 6.1 The sim-to-real gap, stated plainly

First, a framing correction, because it changes what "the gap" even means. **Exploiting asymmetric opportunity is the objective, not a failure mode.** The entire on-chain game — the whole reason this domain is interesting — is finding and taking asymmetric bets before others do; an agent that aggressively hunts and exploits mispricings is doing exactly what we want. So the question is never "is the agent exploiting?" — we *hope* it is — but rather **whether what it exploits is real**. That reduces to a single engineering variable: **simulator fidelity**.

- An exploit discovered in a **faithful** simulator — one that models honest slippage, price impact, MEV, liquidity withdrawal, latency, fees, and rug dynamics — **is a genuine, transferable edge**, because by construction the same asymmetry exists on-chain. This is the good case and the goal.
- An exploit of a simulator **artifact** — infinite size at zero impact, fills that could never clear, a data glitch treated as free money — is worthless, because the asymmetry exists only in the model, not the chain.

The two are indistinguishable *to the agent*; they are distinguished only by how faithful we made the sim. So the engineering bar is precise: **build a simulator faithful enough that its exploits equal the chain's exploits — then let the agent hunt asymmetry as aggressively as it can.**

This is why markets being **non-stationary** (the meta shifts continuously), **partially observed** (insiders and pending transactions are hidden), **adversarial** (counterparties adapt), and — decisively — **not self-playable** matters. In AlphaZero, the agent's move *is* the opponent's environment, so self-play regenerates unlimited, perfectly faithful, on-distribution experience. In a market, a paper agent's simulated buy **does not move the real price**; the environment is exogenous. Consequently a *naive* replay omits market impact, slippage, MEV, and liquidity dynamics — which for thin new-pairs are much of the actual game — and an agent trained on a fill-at-mid simulator will look brilliant and be worthless, because it "buys" size that in reality would move the price against it or be sandwiched. That is not a reason to suppress exploitation; it is a reason to **raise fidelity until exploitation transfers**.

The conclusion is therefore not "RL cannot work here," nor "the agent must not exploit." It is: **simulator fidelity and the bootstrapping data are the whole ballgame** — from-scratch self-play is the wrong *data-generation* strategy, but exploiting a *faithful* sim is precisely the *right* objective.

### 6.2 High-fidelity replay simulation with an explicit execution model

We propose training primarily against a **replay simulator built from real on-chain data**. OCT can source a new-pair firehose (transaction-level swaps, liquidity events, holder changes) via Pinax gRPC; this gives us the *true* trade tape per token.

**Recent-window replay is the default, by design.** Because the meta is non-stationary (§6.6, §9.1), the primary training distribution is a *rolling recent window* — on the order of the past few days — so the agent is always fitting the market as it is *now*, not as it was a quarter ago. Older tape is retained as a curated core set for anti-forgetting and for a frozen regime battery (§6.6), but the live-tracking objective is weighted toward recent windows. This makes "train once" a non-goal from the start: the replay window slides forward continuously and the agent adapts with it.

The simulator must model, at minimum:

- **Execution against real liquidity:** fills are simulated against the reconstructed pool state (AMM curve) at the decision timestamp, so a buy pays realistic **slippage** as a function of size vs pool depth, and **price impact** is applied to the agent's own fills.
- **Counterfactual impact.** Because the agent's order was not in the historical tape, we must estimate how its presence would have altered subsequent fills. A conservative approach: apply impact to the agent's own execution but *do not* assume it changes others' behavior (a lower bound on adversariality); a richer approach uses an agent-based/multi-agent market simulator calibrated to the tape. We start conservative and clearly flag this as a fidelity limit.
- **Latency and ordering:** model the delay between decision and on-chain inclusion, and the possibility of being back-run/sandwiched (**MEV**) — at least as a stochastic slippage/failure penalty in early versions, with an explicit MEV model later.
- **Fees, failed transactions, and priority fees.**
- **Rugs/honeypots as terminal states:** liquidity-pull and sell-disable events from the tape become absorbing zero states; learning to avoid them is a first-class objective, not an afterthought.

Every fidelity gap is a documented threat to validity (§9). The rule: **the paper→live performance gap is our primary measure of simulator fidelity**, and we expect and budget for degradation.

### 6.3 Algorithms

We are algorithm-plural by design and will select empirically. The credible candidates:

- **PPO** (Schulman et al., 2017) — robust, on-policy, the workhorse behind OpenAI Five; our default for online fine-tuning once a reasonable policy exists. Good stability, tolerates the noisy, non-stationary signal better than value-based methods.
- **Offline RL — CQL / IQL** — for the *pretraining* phase on historical data and demonstrations, precisely because it is conservative about out-of-distribution actions (critical when the data can't be regenerated).
- **Distributional critics — C51 / QR-DQN / IQN** — to model the fat-tailed return distribution and to enable *risk-sensitive* objectives (optimize CVaR/quantiles, not the mean). This is how we bake risk-aversion into the value estimate rather than only the reward.
- **Model-based / MuZero-style world model** — learn a latent dynamics model of a token's evolution and plan within it. Attractive because (a) it improves sample efficiency (scarce for live data) and (b) the learned model can *generate* synthetic rollouts to augment training — with the caveat that model errors compound and can be reward-hacked just like a hand-built sim, so planning horizons stay short and are validated against replay.
- **Decision Transformer / return-conditioned sequence models** — an alternative framing that naturally ingests the multi-modal sequence (numeric + text) and sidesteps some RL instability. Used cautiously: return-conditioning on extreme targets re-imports lottery-seeking, so we condition on *risk-adjusted* targets and clip the achievable-return prompt.

We do not commit to one; we commit to a bake-off with pre-registered metrics (§8).

### 6.4 Population / evolutionary training and quality-diversity: the deliverable is a *diverse ensemble*, not one optimum

This is a **first-class pillar of the design, not a hyperparameter-tuning convenience.** The founder's intuition is the anchor: like a genetic algorithm, a few "genes" may score best, but that does not mean the population collapses to no diversity — and in a real market many trader *types* survive and outperform *at the same time*. The goal is therefore explicitly **not** to converge on a single optimal policy; it is to breed, and then keep, a **diverse ensemble of profitable archetypes**, each with an evolved "personality."

We operationalize this with three complementary mechanisms:

- **Population-Based Training** (Jaderberg et al., 2017): train a *population* of policies with diverse hyperparameters, risk appetites, reward weightings, horizons, and even curriculum orderings; periodically exploit (copy strong members) and explore (perturb). This is the online, jointly-optimizing backbone.
- **Evolution strategies** (Salimans et al., 2017): black-box, gradient-free policy search that is embarrassingly parallel and robust to the noisy, non-differentiable, fat-tailed reward — a natural fit where clean gradients are scarce.
- **Quality-diversity — MAP-Elites** (Mouret & Clune, 2015) and novelty search (Lehman & Stanley, 2011): rather than optimizing a single scalar, maintain an *archive* of the best policy found in each cell of a **behavioral-descriptor space** — e.g., holding time (scalper ↔ runner), risk appetite, turnover, narrative sensitivity, wallet-flow reliance. The archive *is* the deliverable: an illuminated map of profitable archetypes spanning the behavior space. This is what turns "personality" from a metaphor into a coordinate.

Two honest constraints are load-bearing and cannot be skipped:

1. **Diversity must be validated out-of-sample and across regimes.** A population of 100 agents that all overfit the same replay window is not robustness — it is 100 correlated ways to fail together. Diversity is only meaningful if it persists on held-out tokens, held-out time periods, and distinct regimes; we validate behavioral spread on forward data, not just on the training window.
2. **Each retained personality must be *individually edge-positive*.** Being different is not enough; a member is kept only if, on its own, it clears the risk-adjusted bar after realistic costs. We select for *diverse survivors that each carry edge*, not for variety per se.

This reframes robustness in a way we can measure: **where independent, differently-evolved agents converge on the same trade is itself a signal.** If archetypes that reason from different information tiers and different behavioral descriptors independently agree on a token, that agreement is a robustness indicator (and feeds naturally into the convergence layer, §4.3); where they disagree, the disagreement is informative about regime ambiguity. The design mirrors the AlphaStar league idea adapted to a non-self-play setting — diversity for robustness and coverage, not for beating a symmetric opponent — and the surviving population, not any single champion, is what ships.

### 6.5 Bootstrapping from labeled traders: imitation → surpass

Starting from absolute zero is both sample-inefficient and dangerous (an untrained policy exploring with size is a ruin machine). We bootstrap:

1. **Behavioral cloning / offline RL from the labeled-trader database.** Treat each labeled trader's *full* on-chain history — every trade, wins and losses alike — as demonstrations; pretrain a policy to reproduce competent trading, using IQL/CQL to stay conservative and DAgger-style corrections where we can query "what would the trader do here." Because the demonstrations include each trader's losing trades, not just their winners, the policy learns what these traders *avoid* and *cut*, not only what they buy.
2. **Inverse RL / GAIL** to learn *why* good traders act — a reward or discriminator that captures their revealed preferences — giving a denser, transferable signal than raw action-matching.
3. **RL to surpass.** Switch to the benchmark-relative reward (§3.5): reward outperforming the cohort per token. The agent starts near the traders' behavior and is pushed past it.

The **selection-bias caveat, developed in §9.3, is real but bounded**: the cohort is *active, daily* traders labeled by their *complete* histories (wins and losses), not a set of cherry-picked winning trades, so the demonstration data already contains failure and the classic survivorship trap is largely defused. What remains is the milder residual effect of *which* traders were active and prominent enough to be labeled at all; we broaden the cohort to dilute it and treat imitation as a warm-start prior only.

### 6.6 The self-feeding online / continual-learning loop

The operator wants live, self-feeding training rather than "training on previous data," and this is **core methodology, not a caveat bolted on at the end**: non-stationarity is *assumed*, so the system is built to keep adapting rather than to train once and freeze. We frame this as **offline-pretrain → online continual fine-tune**:

```
live new pairs → agent paper-trades (proposes, sim/paper executes)
  → outcomes realized over the token's horizon
  → (state, action, realistic-reward) written to a replay buffer
  → periodic conservative policy update (offline-RL step on recent buffer + curated history)
  → updated policy trades the next cohort
  → repeat
```

Key design decisions for continual learning:

- **It is still data-driven — just its *own* fresh data.** "Not training on previous data" cannot mean "no data"; it means *prioritizing recent, self-generated, on-distribution experience* to track the current meta. We implement this as a **prioritized, recency-weighted replay buffer** — weighted toward roughly the past few days of tape (§6.2) — with a retained *core set* of older experience to prevent forgetting.
- **Fast meta-adaptation.** Beyond slow fine-tuning, we want the policy to adapt *within* a regime quickly. Meta-RL / rapid-adaptation framings (context-conditioned policies, short-horizon adaptation on the recent window) let the agent shift behavior on a fresh regime without waiting for a full retrain — adaptation speed is itself a design target, not an afterthought.
- **Catastrophic forgetting** is a first-class risk: naive online fine-tuning overwrites competence on regimes that vanished but will return. Defenses: experience replay / rehearsal with a curated core set, elastic-weight-consolidation-style regularization, and periodic re-evaluation on a *frozen* regime battery.
- **Regime-shift / non-stationarity detection:** monitor for distribution shift (features and reward) and trigger faster adaptation or a fallback to a conservative policy when the world changes abruptly. A meta-context input (§3.2) lets a single policy condition on regime rather than needing to forget/relearn. Because non-stationarity is the design assumption, regime detection is a permanent, always-on component, not an exception handler.
- **Update cadence and safety.** Updates are *conservative* (offline-RL objectives bound OOD optimism) and gated: a freshly updated policy must clear the evaluation battery (§8) before it is allowed to size up, and always stays inside the hard caps.

### 6.7 The traders-as-opponents stage in full

Once the agent is competent solo, we make the labeled traders explicit **benchmarks-as-opponents**. This is *not* self-play (they don't respond to the agent) — it is **relative-performance RL against a fixed expert cohort**: for each token, compute each labeled trader's realized edge and reward the agent for beating them, controlling for entry/exit timing and size. As the agent improves, we can *curriculum the opponents* (start against the median trader, progress to the top decile), which restores a difficulty gradient reminiscent of self-play leagues without requiring the opponents to be reactive.

---

## 7. Data

| Source | Status | Use |
|---|---|---|
| **Labeled wallet / trader database** | Operator has a large DB to label — active *daily* traders, labeled by *full* histories (wins and losses); cohort can be broadened | Imitation/IRL bootstrapping; per-token benchmark opponents. **Residual selection effect only, largely mitigated by full histories (§9.3).** |
| **New-pair on-chain firehose (Pinax gRPC)** | To be built/wired | Transaction-level tape for the replay simulator: swaps, liquidity events, holder changes, rug/honeypot events. |
| **Token metadata** | Partly available via OCT enrichment (GMGN/DexScreener) | Phase-C features; safety flags. |
| **Social / narrative** (X account + stats, TikTok/Instagram/X engagement) | Connectors to build; web-search tool to integrate | Phase-D observations; retrieval harness. |
| **Discord/Telegram caller chatter** | OCT already ingests | Phase-E observations; caller attribution + honest-caller reliability. |
| **OCT existing signals** (revival, FOMO smart-money, convergence, honest-caller) | Live in OCT | Features and the convergence/ensemble layer (§4.3). |

**What exists vs must be built.** OCT already has: chat ingestion, contract detection/enrichment, caller scoring, revival, FOMO tracking, convergence, and a capped/kill-switched sniper actuator. Must be built: the Pinax new-pair firehose wiring, the **high-fidelity replay simulator with execution/impact model** (the largest single engineering item), the labeling pipeline for the trader DB, the social/narrative connectors and web-search harness, the RL training infrastructure (replay buffers, distributed rollout, PBT orchestration, checkpoint/eval batteries), and the paper-trading ledger.

**Data hygiene.** All features must be strictly causal (point-in-time, no look-ahead); the single most common way trading backtests lie is subtle future leakage (e.g., using a token's final holder count as an early feature). We enforce point-in-time reconstruction from the tape and audit for leakage as a standing test.

---

## 8. Benchmarks & Evaluation

### 8.1 The 1→100 SOL paper run (north-star, not teacher)

We report the balance trajectory from 1 SOL under the portfolio-episode setting as the headline, single-number success criterion — *and* we report the full distribution of such runs across seeds/periods, because a strategy that reaches 100 SOL in 1 run of 50 and zeroes the other 49 is a lottery, not an edge. The north-star is judged jointly with the risk metrics below; a 100× that only ever happens via near-ruin drawdowns is a failure.

### 8.2 Per-token outperformance vs labeled traders

The operator's explicit objective. For each token the agent traded, measure realized edge vs the labeled-trader cohort on that same token (matched on the token, controlling for entry/exit timing). Report the *distribution* of per-token edge, the fraction of tokens beaten, and the edge vs the top decile of traders, not just the median.

### 8.3 Risk-adjusted and distributional metrics

- **Sharpe** and **Sortino** (downside-only) ratios.
- **Maximum drawdown** and time-to-recovery.
- **Full PnL distribution:** mean, median, skew, kurtosis, and **CVaR / tail loss** — essential given fat tails.
- **Hit-rate and expectancy** (average win × win-rate − average loss × loss-rate), with explicit attention to the fact that a low hit-rate can still be highly profitable (few tail winners) — so hit-rate alone is misleading and is never reported alone.
- **Turnover, fees paid, realized slippage** — to catch strategies that only "work" under unrealistic costs.
- **Capacity:** performance as a function of deployed size (does edge survive real position sizes given liquidity?).

### 8.4 Per-phase ablations (the curriculum as instrument)

Because the curriculum introduces information tiers cleanly (§5.6), each of the five gates yields an ablation: measure risk-adjusted performance and per-token edge **with vs without** each tier (raw-chart-only → +wallet-flows → +metadata → +social → +chatter). Isolating wallet flows as its own step is deliberate — it prices what on-chain "who is trading" information is worth on top of the naked chart, before any metadata or narrative confound it. This directly tests the operator's hypothesis that information flow adds edge, and quantifies *how much* each tier contributes. We also run **leakage-guard ablations** (replace a tier with noise; performance must drop to the prior tier, not stay high — else the model was exploiting leakage) and the **convergence A/B** (§4.3): OCT ranking with vs without Model N.

### 8.5 Strict backtest → paper → live gating

A hard, non-negotiable promotion ladder:

1. **Backtest (replay sim):** must clear pre-registered risk-adjusted bars on *held-out tokens and held-out time periods* (walk-forward, never random splits — time ordering is sacred).
2. **Paper (live, simulated fills):** trade live new pairs with the simulator's execution model against real-time data for a sustained window; must reproduce backtest performance within tolerance (a large paper-vs-backtest gap means overfitting or leakage — halt).
3. **Live (real money):** only after paper clears, and only inside the sniper's hard caps and kill switch (§10.4), starting at minimal size and scaling *only* as live reproduces paper.

The **paper-vs-live gap is itself a monitored metric** and the definitive measure of sim-to-real fidelity. Any stage regressing below its bar demotes the policy automatically.

---

## 9. Threats to Validity / Risks

We take these seriously; several are, in our assessment, potentially *fatal* to the strong form of the vision, and we say so.

### 9.1 Non-stationarity and regime shift

The memecoin meta shifts continuously; an edge learned this month may invert next month. We treat this **as the design premise rather than a threat to be patched** (§6.6): recent-window replay, continual online adaptation, fast meta-adaptation, regime-context inputs, frozen-regime re-evaluation batteries, and fast fallback to conservative policies on detected shift are core methodology, built in from the start. The residual risk that survives that design is real and we state it plainly: adaptation always *lags* the shift; performance will be lumpy and periods of loss are expected, not anomalous. Non-stationarity being the design does not make it solved — it makes the system perpetually mid-adaptation, which is the honest steady state here.

### 9.2 Reward hacking

The agent optimizes exactly what we measure, not what we mean. Failure modes: exploiting simulator artifacts (§6.1); gaming the benchmark-relative reward by only trading tokens where the cohort did nothing; churning to farm a mis-specified shaping term; conditioning a decision transformer on impossible return prompts. Mitigations: conservative offline objectives, adversarial red-teaming of the reward, the leakage-guard ablations (§8.4), hard constraints instead of soft penalties for the worst behaviors, and human review of the rationale traces.

### 9.3 Residual selection bias in the labeled-trader DB (real but bounded)

An earlier draft treated this as potentially fatal. On the actual data design it is not — though a residual effect remains and we keep it in view. The key facts: the cohort is **active, *daily* traders labeled by their *complete* on-chain histories — every trade, wins *and* losses — not a set of cherry-picked winning trades.** Because the demonstrations already contain each trader's failures, drawdowns, and blow-up trades, the classic survivorship trap (imitating hindsight-selected *winning trades*) is largely defused at the source: the policy sees what these traders lost on and cut, not only what they bought. The cohort can also be **broadened** by labeling more traders, further diluting any single-trader luck.

What genuinely remains is a **milder, second-order selection effect**: the traders who are *active and prominent enough to be worth labeling at all* are themselves a mildly selected set (someone who quietly blew up and left the arena is less likely to be in the pool). Given fat-tailed returns, some of a labeled trader's apparent skill is still luck ex post. So the residual consequences are: imitation is warm-started from a *mildly* over-selected pool, and the per-token benchmark is tilted slightly toward tokens the still-active cohort engaged with. Mitigations, now mostly confirmations of the existing design rather than repairs: (a) full-history, wins-and-losses labeling is the *default*, so failure is in the data by construction; (b) evaluate on *forward* data the labels never touched; (c) treat imitation as a warm-start prior only, with RL doing the real work on causal, point-in-time data; (d) model luck vs skill (persistence / cross-period edge-stability tests) before trusting any single trader's label. Net assessment: this is a **real but minor** caveat — worth discounting headline outperformance modestly for regression-to-the-mean, not a threat that invalidates the imitation-and-outperform premise.

### 9.4 Sim-to-real gap

Covered in §6.1–§6.2. The naive simulator omits impact/slippage/MEV/liquidity — the core of the game. Mitigation: high-fidelity replay + explicit execution model + the paper→live gate as the fidelity meter. Residual risk: the counterfactual-impact problem (our order wasn't in the tape) has no perfect solution; multi-agent market simulation is itself unsolved. We proceed with conservative impact assumptions and treat the live gap as ground truth.

### 9.5 Adversarial market: MEV, rugs, honeypots, manipulation

New-pairs are an adversarial environment engineered to extract from newcomers: sandwich/MEV bots, rug pulls, honeypots (buy-enabled, sell-disabled), and coordinated shill-and-dump. Two dangers: (a) the agent *loses* to these mechanisms; (b) worse, the agent *learns to imitate the manipulators* because following-the-pump-then-dumping is locally rewarded. Phase D (chatter) is especially exposed to learning to ride coordinated manipulation. Mitigations: rug/honeypot avoidance as a first-class learned objective and a hard safety filter; MEV modeling in the sim; and an explicit policy constraint against manipulation-following behaviors we can detect. This shades into ethics (§9.8).

### 9.6 Overfitting to a meta / backtest overfitting

The single most common way trading ML lies. Mitigations: strict walk-forward evaluation (never random splits), held-out time periods, the paper→live gap monitor, population-based robustness selection, and pre-registered metrics/bars so we can't move the goalposts post hoc.

### 9.7 Prompt-injection via the web-search and chatter tiers

From Phase D, the agent ingests *untrusted external text* (web pages, social posts, caller messages). An adversary can plant text designed to manipulate the agent ("this is a safe 100× buy now"). All such content is **data, never instructions** to any controller; the policy consumes it as embedded features, tool outputs are sandboxed, and no ingested text may alter caps, safety settings, or the agent's control flow. Coordinated shills are a *training-signal* poisoning risk too (§9.5).

### 9.8 The catastrophic risk of an autonomous, money-spending agent with a 100× goal

This is the risk the operator should weigh most heavily. An autonomous agent that (a) controls real funds, (b) is pointed at a 100× goal, and (c) operates in a domain where the EV-optimal way to hit a fixed multiple is *bold, ruinous play*, is a machine for taking insane risk — the exact tilt failure the operator is trying to cage in himself, now automated and tireless. Compounding factors: reward-hacking can produce confidently-wrong sizing; a regime shift can turn a "working" policy into a rapid-drain policy; and an online-learning agent can *drift* into pathology between evaluations. **Mitigations are non-negotiable and structural, not behavioral:** the 1→100 goal is never the training reward (§3.5); risk enters as hard CMDP constraints and distributional/CVaR objectives; live trading is gated behind paper performance; and *all* live action passes through the existing sniper safety envelope — per-fire, per-trigger, and daily caps, max open positions, and a kill switch — which the agent *cannot* modify (§10.4). We recommend, additionally, a human-in-the-loop approval for any scale-up in caps and a hard, small absolute loss limit that halts the agent regardless of its confidence.

### 9.9 Ethics of releasing autonomous trading agents "into the world"

Beyond OCT's own capital: shipping autonomous trading agents to users raises real questions. Such agents can amplify market manipulation (an agent that learns to ride and trigger pumps is a manipulation participant), harm inexperienced users who over-trust an automated system, and, at scale, degrade market quality. Memecoin markets are already close to zero-sum-minus-fees; an "edge" is largely extraction from other participants, many of them retail. We recommend the team explicitly decide the intended use (internal capital vs a shipped product), and if shipped, treat it with the same seriousness as any financial product: no personalized-advice framing, hard risk caps, transparent disclosure that it can and will lose money, and a refusal to build features whose primary function is manipulation. Scam/manipulation as *training signal* (learning from rugs and shills) must not become scam/manipulation as *learned behavior*.

### 9.10 Feasibility honesty

The strongest form of the vision — *from-scratch self-play* RL reaching a reliable 100× — is, in our assessment, **not achievable as literally stated**, for the structural reasons in §6.1: markets aren't self-playable, so self-play is the wrong data-generation strategy, and the goal-as-reward is pathological. Note what is *not* on this list: aggressive exploitation of asymmetric opportunity is not a barrier but the objective — the barrier is only building a simulator faithful enough that its exploits transfer. Nor is survivorship a fatal barrier: labeling active daily traders by their full win-and-loss histories defuses most of it (§9.3), leaving a minor residual. The *achievable* program is the realistic path in this paper: bootstrap from real data and demonstrations, train against a high-fidelity replay sim with honest execution and then exploit it aggressively, breed a diverse population of profitable archetypes, optimize risk-adjusted benchmark-relative rewards under hard constraints, learn continually online against the shifting meta, and prove edge through strict gating and ablations. Whether *any* durable, capacity-respecting edge exists in new-pairs after realistic costs is the open empirical question (§11).

---

## 10. Phased Roadmap & Requirements

Each phase lists its purpose, what must be built, the compute/data footprint, and a measurable exit milestone. Live real-money trading is gated behind paper performance and hard caps throughout.

### 10.1 Phase 0 — Foundations (simulator + data)

**Purpose:** build the thing everything else depends on.
**Build:** Pinax new-pair firehose wiring; point-in-time feature store (leakage-audited); the **high-fidelity replay simulator with execution/impact/rug model**; the paper-trading ledger; the labeling pipeline for the trader DB.
**Compute/data:** modest GPU for encoders; substantial storage/streaming for the tape; engineering-heavy, not compute-heavy.
**Exit milestone:** simulator reproduces known historical fills within a calibrated slippage tolerance on a validation set of tokens; leakage audit passes; a *trivial* baseline (e.g., buy-and-hold, random) runs end-to-end through sim → paper ledger with correct costs.

### 10.2 Phase 1 — Raw-chart agent (Curriculum Phase A)

**Purpose:** first learned policy; establish the pure-chart ("naked") baseline from a genuinely information-free starting point — no wallet data, no metadata.
**Build:** offline-RL pretraining (IQL/CQL) on historical tape + trader demonstrations; distributional critic; PPO online fine-tune against the sim; the evaluation battery (§8) and walk-forward harness; the short-horizon scalper episode (§3.4).
**Compute:** meaningful but single-node-feasible RL training; distributed rollout optional.
**Exit milestone:** on held-out time periods, the raw-chart agent clears a pre-registered risk-adjusted bar and beats the buy-and-hold and hold-SOL baselines *after realistic costs*; leakage-guard ablation passes.

### 10.3 Phase 2 — Wallet flows + metadata + social + chatter (Curriculum Phases B–E)

**Purpose:** test and quantify the marginal edge of each information tier, one at a time, starting with wallet flows on top of the naked chart; build the tool/retrieval harness.
**Build:** wallet-flow features (smart-money/fresh-bot tagging, concentration, creator behavior); metadata features; social connectors + web-search harness (sandboxed, injection-safe); chatter attribution features; text encoders; per-gate ablation reporting; **population/evolutionary + quality-diversity (MAP-Elites) orchestration** for the diverse-archetype "personality" population.
**Compute:** higher — text encoders, retrieval, and the population multiply cost.
**Exit milestone:** each of the five gates' ablations shows a statistically credible marginal edge (or we honestly report a tier that does *not* help and drop it); an out-of-sample-validated, diverse population of individually edge-positive archetypes exists.

### 10.4 Phase 3 — Traders-as-opponents + paper-live + the safety envelope

**Purpose:** move from solo competence to benchmark-relative outperformance and to sustained live paper trading.
**Build:** benchmark-relative reward and opponent-curriculum; the online continual-learning loop with anti-forgetting + regime detection; integration with the **existing sniper control plane as the live actuator and safety envelope**.
**Safety envelope (reused, not rebuilt):** OCT's sniper already enforces per-fire, per-trigger, and daily caps, a max-open-positions limit, and a kill switch, mounted on its own hardened control plane (`/sniper/v1`, separate auth, not behind wildcard CORS). The agent may only *propose* to this actuator; it cannot modify caps or disable the kill switch. Live scale-up requires human approval and stays inside a hard absolute loss limit.
**Exit milestone:** sustained paper run reproduces backtest within tolerance; per-token edge vs labeled traders is positive on forward data after accounting for the residual selection effect (§9.3); paper→live gate criteria are formally defined and, only then, a minimal-size live pilot begins under caps.

### 10.5 Phase 4 — Ensemble/convergence integration + (optional) revival unification

**Purpose:** make Model N one more independent signal in OCT's convergence layer; extend the shared RL scaffolding to Model R (revival) as a policy; measure the combined system.
**Build:** convergence integration (score-level fusion, signals independent); revival-policy training reusing the stack; combined A/B (convergence with vs without N).
**Exit milestone:** convergence-with-N measurably improves OCT's ranking/decisions in a clean A/B; revival policy clears its own gated battery.

### 10.6 Cross-cutting hard rules

- **Live real-money trading is gated behind paper performance and hard caps — always.** No exceptions, no manual overrides that bypass the caps or kill switch.
- **The 1→100 goal is an evaluation north-star, never the training reward.**
- **Walk-forward only; pre-registered metrics; no post-hoc goalpost moves.**
- **Every fidelity gap and every discount for the residual trader-selection effect is documented, and headline numbers are reported with those caveats attached.**

---

## 11. Conclusion

We have specified an autonomous RL agent for new-pair memecoin trading and, equally, argued honestly about what is and isn't feasible. The operator's inspiration — DeepMind's from-scratch, self-play game agents — supplies the *algorithms* (PPO, MuZero-style planning, population-based and evolutionary training, imitation-plus-RL) but not the *data-generation paradigm*: markets are non-stationary, partially observed, adversarial, and not self-playable, so from-scratch self-play is the wrong way to generate data, and the literal 1→100 SOL goal, used as a reward, would train a ruin-seeking lottery policy. Crucially, *exploiting* asymmetric opportunity is the objective, not the failure — the only real constraint is building a simulator faithful enough (honest slippage, impact, MEV, liquidity, latency, rugs) that its exploits equal the chain's, after which the agent should hunt asymmetry aggressively. The realistic path bootstraps from real on-chain data and full-history labeled-trader demonstrations (offline/imitation RL), trains against that high-fidelity replay simulator with an explicit execution/impact/rug model, breeds a **diverse population of profitable archetypes** (PBT, evolution strategies, MAP-Elites) rather than one brittle optimum, optimizes shaped, risk-adjusted, benchmark-relative rewards under hard constraints and distributional critics, and — treating non-stationarity as the design rather than a caveat — learns continually online on recent-window replay with fast adaptation and defenses against forgetting and regime shift, all promoted through a strict backtest → paper → live gate that reuses OCT's existing sniper safety envelope.

The paper's distinctive contribution is the **progressive-information curriculum** — raw chart → wallet flows → metadata → narrative/social → crowd chatter — which starts from a genuinely information-free baseline and is at once a training device, a built-in ablation that measures the marginal edge of each information tier (wallet flows first among them), and a testable hypothesis that information *flow* drives memecoin price formation. If any tier fails to add edge, the curriculum will tell us so cleanly, and we will report it.

**The single most important open research question** — the one that determines whether this whole program is worth building — is: **After realistic execution costs (slippage, impact, MEV) and after honestly correcting for survivorship bias in the labeled-trader benchmark, does a durable, capacity-respecting predictive edge in new-pair memecoins actually exist and persist out-of-sample across regime shifts?** Every technique here is in service of answering that question rigorously rather than fooling ourselves. If the answer is yes, the curriculum and the online loop are how we capture it safely; if the answer is no, the same rigorous gating is what stops us from lighting real capital on fire to find out the hard way.

---

## References (by name; representative prior work)

- Mnih et al. (2015). *Human-level control through deep reinforcement learning* (DQN / Atari).
- Silver et al. (2016; 2017). *Mastering the game of Go* (AlphaGo; AlphaGo Zero).
- Silver et al. (2018). *A general RL algorithm that masters chess, shogi and Go* (AlphaZero).
- Schrittwieser et al. (2020). *Mastering Atari, Go, chess and shogi by planning with a learned model* (MuZero).
- Vinyals et al. (2019). *Grandmaster level in StarCraft II* (AlphaStar).
- Berner et al. (2019). *Dota 2 with large scale deep reinforcement learning* (OpenAI Five).
- Schulman et al. (2017). *Proximal Policy Optimization Algorithms* (PPO).
- Kumar et al. (2020). *Conservative Q-Learning for Offline RL* (CQL).
- Kostrikov et al. (2022). *Offline RL with Implicit Q-Learning* (IQL).
- Nair et al. (2020). *Accelerating Online RL with Offline Datasets* (AWAC; offline→online).
- Ng & Russell (2000). *Algorithms for Inverse Reinforcement Learning*.
- Abbeel & Ng (2004). *Apprenticeship Learning via Inverse RL*.
- Ho & Ermon (2016). *Generative Adversarial Imitation Learning* (GAIL).
- Fu et al. (2018). *Learning Robust Rewards with Adversarial IRL* (AIRL).
- Ross et al. (2011). *A Reduction of Imitation Learning and Structured Prediction* (DAgger).
- Bengio et al. (2009). *Curriculum Learning*.
- Bellemare et al. (2017). *A Distributional Perspective on Reinforcement Learning* (C51).
- Dabney et al. (2018). *Distributional RL with Quantile Regression* (QR-DQN); *Implicit Quantile Networks* (IQN).
- Jaderberg et al. (2017). *Population Based Training of Neural Networks*.
- Salimans et al. (2017). *Evolution Strategies as a Scalable Alternative to Reinforcement Learning*.
- Mouret & Clune (2015). *Illuminating Search Spaces by Mapping Elites* (MAP-Elites).
- Lehman & Stanley (2011). *Abandoning Objectives: Evolution Through the Search for Novelty Alone* (Novelty Search).
- Chen et al. (2021). *Decision Transformer: RL via Sequence Modeling*.
- Janner et al. (2021). *Offline RL as One Big Sequence Modeling Problem* (Trajectory Transformer).
- Moody & Saffell (2001). *Learning to Trade via Direct Reinforcement* (differential Sharpe).
- Nevmyvaka, Feng & Kearns (2006). *Reinforcement Learning for Optimized Trade Execution*.
- Deng et al. (2016). *Deep Direct Reinforcement Learning for Financial Signal Representation and Trading*.

*Note: citations are to real, well-known prior work identified by name and year for the reader to locate; this proposal reports no experimental results and cites no numeric findings from these works.*

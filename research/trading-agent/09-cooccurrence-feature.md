# 09 — Smart-wallet co-occurrence: the first Tier-B feature

**Source of truth:** [`00-paper.md`](./00-paper.md) §3.2 (observation space), §5 (curriculum
tiers B); the empirical basis is [`PROGRESS.md`](./PROGRESS.md) 2026-08-28 (iv); the leakage
contract is [`04-data-spec.md`](./04-data-spec.md) §3 + the LEAKAGE RULE. This doc specifies one
Tier-B slot end to end: what it is, why it earns its place, how it is computed point-in-time, and —
the load-bearing part — how the *roster it depends on* is kept future-blind.

**Prime directive (inherited):** every value this feature emits must be reconstructable from events
with `block_time <= as_of` **and** from a roster frozen strictly before `as_of`. If either half
reads the future, the feature is leakage, not signal.

---

## 1. Why this feature exists

Earliness ([`census/earliness.py`](./src/oct_trading_agent/data/census/earliness.py)) ranks
*wallets*. Co-occurrence is the first result that turns that ranking into a signal about a *token*,
and it is the strongest number the program has produced (PROGRESS 2026-08-28 (iv)):

- Out of sample — ranking built on period A, tokens measured on period B — the **>10x rate spans
  0.003 → 0.423 across smart-early-buyer count (a 141× difference)**, median run 1.37× → 8.03×,
  monotone throughout.
- **It is not merely "more early buyers."** Splitting each early-buyer-count band at its median
  smart-*share*, the high-share half wins in **every band on both metrics** — so wallet quality
  carries signal independent of crowd size.
- **Crowd size is also real and additive** — median run climbs 1.17× → 4.89× at *zero* smart share.
  The two effects must be represented separately (see the two slots in §2), or the model conflates
  them exactly as the headline table did.
- **The signal is sparse:** smart wallets are 4.3% of early buyers. A few ranked addresses inside a
  crowd of hundreds move the outcome distribution this much — which is precisely why it is worth
  *computing* rather than eyeballing.

The Tier-B row in [`04-data-spec.md`](./04-data-spec.md) already names this slot: *"smart-money vs
fresh/bot inflow."* `core/enums.py` labels `B_WALLET_FLOWS` with *"smart-money inflow."* This doc
fills that slot.

---

## 2. The feature: two slots, not one

Registered under `FeatureTier.B_WALLET_FLOWS`. Both are pure functions of the mint-scoped,
`as_of`-clipped swap tape (`SwapEvent.signer`) **and** an as-of roster `R` (§4).

| slot name | value at `as_of` | status when |
| --- | --- | --- |
| `smart_wallet_count` | number of **distinct** wallets in `R` that have signed a **BUY** on this mint with `block_time <= as_of` | `MISSING_NOT_YET_AVAILABLE` before the first swap; otherwise `OBSERVED` integer `>= 0` |
| `smart_wallet_share` | `smart_wallet_count / (distinct buyers so far)` | `OBSERVED` in `[0,1]` once `>= 1` buyer exists; `MISSING_NOT_APPLICABLE` at zero buyers (0/0) |

**Why "before now" replaces the study's "early window."** The retrospective study used *"entry
inside the first 20% of the token's trade queue,"* which is defined over the **whole** tape and is
therefore hindsight — the final queue length is unknown at decision time. Live, the decision instant
`as_of` **is** the window: "how many known-good wallets have accumulated this token *by now*" is the
tradeable question, and it needs no forward window. The running distinct-buyer count is monotone
non-decreasing in `as_of` and trivially causal. `smart_wallet_share` carries the crowd-size control
into the observation so the model can separate wallet-quality from crowd-size (§1), rather than us
pre-baking an early-window cutoff that hindsight-selects the queue.

**BUY-only, distinct, signer-based.** A roster wallet that only *sold* is not accumulation; count a
wallet once regardless of how many times it bought (matching the "distinct smart wallets" of the
study). `signer` is the tape's wallet identity (`core/tape.py`); no wallet resolution beyond
set-membership is needed, which keeps this inside Tier B and off Tier C+.

---

## 3. Point-in-time semantics

Mirrors the Tier-A discipline in
[`tiers/tier_a.py`](./src/oct_trading_agent/featurestore/tiers/tier_a.py):

1. **Causal by construction.** `compute_as_of(tape, as_of)` re-filters to `block_time <= as_of`
   itself — it never trusts the caller to have pre-clipped. The standing leakage audit
   ([`featurestore/leakage_audit`](./src/oct_trading_agent/featurestore/leakage_audit)) appends
   future swaps and asserts the emitted count is **identical**.
2. **Explicit missingness.** Never a silent zero: `MISSING_NOT_YET_AVAILABLE` before the first
   swap; `smart_wallet_count = 0` once the token is live but no roster wallet has bought is a
   *measured* zero (`OBSERVED`), which is the whole point of the "0 smart buyers" band. `share` is
   `MISSING_NOT_APPLICABLE` only at genuine 0/0.
3. **`as_of` of the value** is the `block_time` of the latest swap counted (or the missingness
   `as_of`), same as every Tier-A slot.

Sketch (structurally a `core.PointInTimeFeature`, dependency-injected roster):

```python
@dataclass(slots=True)
class SmartWalletCount:
    roster: RosterProvider          # §4 — the leakage-critical dependency
    name: str = "smart_wallet_count"
    tier: FeatureTier = FeatureTier.B_WALLET_FLOWS

    def compute_as_of(self, tape, as_of):
        swaps = _swaps_at_or_before(tape, as_of)          # reused Tier-A helper
        if not swaps:
            return _missing(MISSING_NOT_YET_AVAILABLE, as_of)
        roster = self.roster.as_of(as_of)                 # frozenset[Wallet], future-blind
        buyers = {s.signer for s in swaps if s.side is Side.BUY}
        n = len(buyers & roster)
        return _observed(n, swaps[-1].block_time)
```

---

## 4. The roster firewall (the load-bearing part)

`smart_wallet_count` is only as causal as the roster `R` it intersects against. There are **two**
distinct leakage surfaces, and the study's current roster fails the second one:

**(a) Roster construction must be strictly `< as_of`.** `R` is not a constant — it is an as-of
artifact. `RosterProvider.as_of(t)` must return only wallets rankable from history **before** `t`,
refreshed walk-forward. A single roster fitted on the full capture and reused across the backtest
would leak future wallet behaviour into past decisions. Interface:

```python
class RosterProvider(Protocol):
    def as_of(self, t: datetime) -> frozenset[Wallet]: ...   # wallets "smart" as of t, history<t only
```

**(b) The "smart" *definition* must not use hindsight.** The study's roster is *"the earliest
quintile by a token's hindsight peak"* — the peak is computed over the whole tape, so the label is
lookahead (this is exactly what [`04-data-spec.md`](./04-data-spec.md)'s LEAKAGE RULE forbids:
`entry_price_pct_of_peak` is a wallet *label*, never an observation, and any feature derived from it
"must be built strictly from history before the decision instant"). A tradeable roster ranks wallets
on **realized, as-of-knowable** history — repeated early arrival + realized PnL closed before `t`
([`census/earliness.py`](./src/oct_trading_agent/data/census/earliness.py) +
[`census/cohorts.py`](./src/oct_trading_agent/data/census/cohorts.py) already produce the raw
material) — never on a forward peak. PROGRESS 2026-08-28 (iv) flags this re-derivation as the
"obvious next step"; it is a **precondition** for wiring the feature live, not an optional follow-up.

**Refresh cadence** is a config knob (§5), bounded below by how fast the census can re-rank and
above by how stale a roster may drift before it misprices new wallets. The provider caches per
`as_of`-bucket so the feature store's hot loop does not re-rank on every `assemble`.

---

## 5. Config

| knob | default (proposed) | why |
| --- | ---: | --- |
| `min_scored_pairs` | 3 | a wallet needs a track record before it can be "smart" (matches the census `>=3` gate) |
| `roster_quantile` | 0.20 | earliest quintile — the study's cut; revisit once the point-in-time re-rank lands |
| `roster_refresh` | 6 h | walk-forward re-rank cadence; the roster is an as-of artifact, not a constant |
| `count_side` | BUY | accumulation, not churn; sells do not count |
| `distinct` | true | a wallet counts once regardless of buy count |

---

## 6. Registration

The store's registry is already injectable — `PointInTimeFeatureStore(tape, registry=...)`
([`pointintime/store.py`](./src/oct_trading_agent/featurestore/pointintime/store.py)). Tier B is
`present-but-empty` today; this feature fills it via a factory that takes the roster dependency:

```python
def default_tier_b_features(roster: RosterProvider) -> list[PointInTimeFeature]:
    return [SmartWalletCount(roster), SmartWalletShare(roster)]
```

`_default_registry()` gains `FeatureTier.B_WALLET_FLOWS: default_tier_b_features(roster)` **once a
roster provider is available** — until then the tier stays legitimately empty (an absent roster is a
`MISSING_SOURCE_GAP`, not a zero). This is the first tier-B curriculum unlock (paper §5); the agent
observes it only once the curriculum reaches Tier B.

---

## 7. Tests (standing, per the leakage-guard rules)

1. **Append-future invariance** (leakage rule 1): appending swaps with `block_time > as_of` leaves
   both slots unchanged. Reuses the audit harness.
2. **Roster monotonicity in `as_of`** — `roster.as_of(t)` may only add information available by `t`;
   a test asserts `as_of(t2)` with `t2 > t` never retro-injects a wallet into an earlier query.
3. **Measured-zero vs not-yet** — a live token with no roster buyer emits `OBSERVED 0`, not missing;
   a token with no swaps yet emits `NOT_YET_AVAILABLE`. (The "0 smart buyers" band depends on this.)
4. **Leakage-guard ablation** (rule 6): replacing Tier B with noise must drop performance to the
   Tier-A level; if a hindsight roster is wired by mistake, this test stays high and fails — which
   is the intended tripwire for surface (b) above.

---

## 8. Outstanding before this is "live-validated"

Carried from PROGRESS 2026-08-28 (iv), in dependency order:

1. **Point-in-time roster re-derivation** (§4b) — **✅ CLEARED 2026-08-29**
   (`scripts/pit_roster_check.py`, PROGRESS 2026-08-29): ranking wallets from a tape truncated at
   the boundary reproduces the full effect — >10x span 0.003 → 0.367 (vs hindsight 0.002 → 0.361),
   monotone, share-control holds in all four bands, 94.7% roster overlap. The whole-tape-peak leak
   was real but immaterial. `data/pit_smart_roster.csv` is the leakage-safe snapshot for a
   `WalkForwardRosterProvider`.
2. **Tradeable outcome** — **✗ DONE 2026-08-29, NO tradeable standalone edge** (`scripts/tradeable_outcome.py`,
   PROGRESS 2026-08-29 (ii)). Fee-net forward return from a tradeable entry (early-window close), off
   the observed-price path minus round-trip cost — the *optimistic* mid-price bound. Verdict, on a
   2,000-resample bootstrap of the trail EV: **bands 0–4/6 are decisively negative (CIs entirely
   below zero); the 7+ band is statistically indistinguishable from zero** (EV ≈ −2%, 90% CI
   [−17%, +16%], P(EV>0) ≈ 39%). The signal predicts *runs* (§8.1) but frictions bury the return at
   a 20%-late fixed entry — the R14/Rule-18 trap, which even snared this analysis's own first draft
   (a single +5.5% draw that the bootstrap exposed as noise). **The full `sim/replay` depth-priced
   re-measure is NOT worth building** — it can only push an already-zero optimistic bound more
   negative.
3. **Horizon** — same ~21 h capture / ~10 h forward as the earliness split; whether the effect holds
   over days is untested and needs a longer capture.

(1) cleared 2026-08-29. (2) done — it did **not** clear the slot for the live observation vector as a
standalone tradeable signal: no band's EV is distinguishable from zero after costs. The feature is
still a legitimate **agent input** (its statistical reality from §8.1 stands — 7+ tokens do run more;
an RL policy may time/size better than the naive fixed-entry backtest can), so the plumbing (§3, §6)
rightly stays behind the empty-tier gate —
a roster-less Tier B is a correct `MISSING_SOURCE_GAP`, not a wrong number. Standalone-signal
promotion waits on the full-sim §8.2 and a longer horizon.

---

## 9. Build order

1. `RosterProvider` protocol + a file-backed provider reading the census export **as-of** (surface
   (a) only; still hindsight-labelled — dev scaffold, not live).
2. `SmartWalletCount` + `SmartWalletShare` features + tests §7.1/§7.3.
3. Point-in-time roster re-derivation (§8.1) + split-sample re-run → replaces the scaffold.
4. Register under Tier B; leakage-guard ablation §7.4 green.
5. Tradeable-outcome re-measure (§8.2) → decision to admit to the live observation vector.

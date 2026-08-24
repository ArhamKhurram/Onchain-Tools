# 07 — The Improvement Loop

*Methodology imports from a working solo quant operation (the satsmonkes/Meteora
build journal, 2026-05, and the HALO intel system, 2026-08). The LP domain itself
is out of scope — market-making for fees is a different game from directional
new-pair trading, and we are not entering it. What transfers is the **process**:
how a one-person system compounds instead of drifting. This document adapts the
three transferable pieces to this program. Status: adopted as design,
implementation queued behind the wallet-flow tier.*

---

## 1. The closed improvement loop (adopted, build queued)

**Pattern (theirs):** an auto-research module post-mortems every closed trade and
proposes config recalibrations *within bounded ranges*. Read-only: every
suggestion lands in a queue and a human validates before anything ships. Next
rung: a trial-runner allowed to test changes on a tiny capital slice with
auto-rollback.

**Ours:** a post-mortem module over our own artifacts — closed eval episodes,
per-rung ladder reports, per-generation archive telemetry — that emits bounded,
evidence-cited configuration suggestions ("entropy floor 0.002 → 0.004: 3 of 4
runs collapsed exploration before gen 8; telemetry refs …"). Suggestions queue;
the operator gates; nothing self-modifies. This is the signal-first doctrine
(§4.2 of the paper) applied to the research system itself: observe → suggest,
never touch the live config.

Constraints carried over unchanged:
- **Bounded ranges only.** A suggestion may move a knob within a declared band,
  never introduce a new mechanism. Mechanism changes remain human work.
- **Evidence attached.** Every suggestion cites the runs/metrics that motivated
  it, so the operator reviews an argument, not a number.
- **The ladder of autonomy is explicit and gated:** read-only queue (first
  build) → trial-runner on a bounded research slice with pre-registered
  keep/revert criteria (later) → never an ungated writer.

## 2. Audit rounds as a named ritual (adopted, effective immediately)

**Pattern (theirs):** ~16–17 numbered audit rounds per engine — run real
production data through the code, find edge cases, fix, ship, count it.
Calibration on hundreds of real trades, never on "backtested fantasies".

**Ours:** we already practice the substance (sim-fidelity error vs real swaps,
leakage guards, live-tape validation) but not the *ritual*. Adopted: recurring,
numbered audit rounds — "audit round N: <subsystem> vs <real captured tape>" —
logged in PROGRESS.md with what broke and what was fixed. The count is the
point: it makes honesty a cadence instead of a culture, and it gives a cheap
answer to "how hardened is this path?" (Answer: its round number.)

First scheduled targets: the fill/sim path against each week's fresh capture;
the census/realized-PnL crawler against hand-verified wallets.

## 3. Trial-runner discipline for config changes (adopted as experiment style)

**Pattern (theirs):** a change ships to a tiny slice, is observed over a defined
window, and is kept or reverted automatically.

**Ours (research-side, no capital involved):** any config change that claims to
help must run head-to-head against the incumbent on a bounded slice — same
dataset snapshot, same seed, same eval battery — with the keep/revert criterion
written down *before* the run. The attention-features ablation (identical
command ± one flag) is the template. This is now the default shape for testing
changes, replacing "run it and eyeball".

## Explicitly not imported

- The LP/DLMM domain (ranges, fee APR, bid-ask shapes) — different game.
- Consensus-boosted conviction scoring — OCT's signals-stay-independent
  principle holds; wallet-cohort data feeds the flow tier as an *input*, never
  as a fused score.
- Any pattern requiring live capital; §9.8's gate is untouched.

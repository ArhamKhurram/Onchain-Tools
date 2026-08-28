---
title: Revival detection
description: How OCT finds dormant tokens waking up — the two-tier universe, the request budget that shapes everything, and why the gates are not a score.
---

Revival is the signal for a token that went quiet and then ignited. It is deliberately independent
of convergence, FOMO buys, and missed-runner (see [Signals](/architecture/signals/)) — the three
are routed together in the UI and never fused in the detection.

Backend lives in `backend/src/revival/`; the review surface is the **Revival tab** on the Callers
page.

## The constraint that shapes the whole subsystem

Everything below follows from one measured number: **GeckoTerminal's keyless tier sustains about
6-8 successful requests per minute**, shared across every watched chain.

That figure was measured from two independent IPs, not taken from documentation — the widely
quoted "30 calls/min" is wrong in practice, and an earlier version of this code paced against it
and spent most of its time in backoff. The measurement table lives in the module header of
`candles.ts`.

Two consequences are worth internalising before changing anything here:

1. **A 429 is intermittent noise, not a clean "wait N seconds" signal.** Requests spaced 5 seconds
   apart still drew 429s interleaved with 200s in no discernible pattern. So a single 429 widens
   the global spacing a notch rather than halting every chain.
2. **Under-coverage is silent.** A rate-limited poller and a quiet market produce the same empty
   log. That is why every cycle emits a coverage line — tokens scanned over universe size,
   requests spent, 429s absorbed, estimated full-sweep time. Silence must never be mistakable for
   coverage.

## The universe: two tiers

### Feed tier

Contracts detected in users' own feeds within the last 48 hours, capped per user and filled
round-robin across chains so a Solana-heavy feed cannot starve the EVM chains out of the cap.

This tier has a structural blind spot, and it is worth stating plainly: **it can only ever catch a
revival in something a caller mentioned in the last two days.** A token that has been quiet for
three weeks — which is precisely the shape the detector exists to find — is invisible to it.

### Broad tier

The busiest pools per watched chain above a liquidity floor, regardless of whether anyone
mentioned them. Discovery is ranked in bulk, so one request returns twenty pools and a chain costs
a couple of requests per sweep rather than one request per token.

**Off by default** (`OCT_REVIVAL_BROAD_TIER=1` enables it) and separately capped
(`OCT_REVIVAL_BROAD_MAX_PER_NETWORK`). Discovery is cheap; *evaluation* is not — every eligible
token eventually costs candle requests against the budget above. Broad-tier tokens belong to no
one in particular, so they are delivered to everyone already receiving revival alerts.

## Candle sources

| Chain | Source | Why |
| --- | --- | --- |
| Solana | Pinax | Paid, no keyless rate ceiling |
| BNB Chain | Pinax | Same |
| Robinhood Chain | GeckoTerminal | Pinax does not index it — it is an Arbitrum Orbit L3, not Arbitrum One |

Routing Solana and BNB to Pinax leaves the whole GeckoTerminal budget for the one chain that has
nowhere else to go. With no `PINAX_API_KEY` configured, every chain falls back to GeckoTerminal and
behaviour is unchanged.

### Pinax prices are calibrated, not converted

Pinax OHLC is not USD-denominated, and the scaling **cannot be derived from token decimals**. Two
pools measured the same day:

| Chain | Pool | Raw close | Factor needed |
| --- | --- | --- | --- |
| Solana | USDC(d6) / WSOL(d9) | `0.00010727` | ×10⁶ |
| BSC | USDT(d18) / WBNB(d18) | `713.51` | ×10⁰ |

Both land within 0.3% of the real price, and no expression over the two decimal counts produces
both factors. So each pool is calibrated **once** against a reference USD price, and the measured
ratio must round to a clean power of ten. A genuine unit mismatch always is one; anything else
means the two sources are pricing different things, and the pool is refused and falls back to
GeckoTerminal rather than being rescaled by a guess.

The failure this guards against is not a crash. It is gates evaluating against numbers orders of
magnitude wrong, firing nothing, and reading exactly like a quiet market.

## Gates, not a score

The detector applies **independent gates** — ATR expansion, relative volume, dormancy, drawdown
from peak, run-from-baseline — and every one must pass. It deliberately does not blend them into a
single number.

A blended score lets a very strong reading on one axis buy its way past a disqualifying reading on
another, and it hides *which* condition was the marginal one. The gates are calibrated against
labelled real cases, each of which exists because it broke an earlier version:

- a token whose revival the absolute-dormancy ceiling would have blocked, which is why dormancy is
  measured **relative** to a token's own baseline rather than against a fixed floor;
- a token that alerted hundreds of times into an existing run, which is why a run-from-baseline
  gate exists;
- a token that alerted at all-time high off a quiet plateau, which is why a minimum drawdown is
  required before dormancy counts.

**Do not retune these without re-running the labelled cases.** The calibration tables live in
`detector.ts` comments and are asserted by tests.

## Breakout: the sibling signal

Breakout fires when every gate passes **except** drawdown — consolidation near the highs igniting,
rather than a revival from a drawdown. Same detector pass, no extra requests, its own alert
identity, and it shares the alert table discriminated by kind.

It is explicitly *not* a retuned revival. "Consolidation at highs" is a different setup with a
different base rate, and merging the two would have meant loosening the drawdown gate that three
labelled cases exist to defend.

## Alert tiering

Revival is the only signal in the app that uses **Pushover emergency priority** — re-alerting until
acknowledged, with a repeat-until-dismissed sound and a persistent banner. That is a deliberate
product decision, not an oversight: the operator asked for a tier they could not miss. Breakout is
amber at normal loudness. Do not normalise revival down to match the others.

## The alert log is the training set

Every fired alert persists with its market cap at alert time; an outcome tracker then watches the
following 24 hours and records the peak and the multiple, resuming open windows on boot so a
restart does not lose them.

That alert → outcome pairing accrues labelled data automatically, simply by running. It is the
same pairing the research programme's training architecture calls for, which is why the log is
treated as an artefact rather than as debug output.

## Operational notes

See the [runbook](/operations/runbook/) for incident handling. The one distinction worth repeating
here: a Cloudflare block and an application-level `403` look alike and have opposite fixes.
Cloudflare returns **HTML**; a JSON envelope with `"message":"Forbidden"` means the request reached
the application and the *account* was refused — no restart will help.

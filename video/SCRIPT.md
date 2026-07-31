# OCT launch video — script v1

**Target:** ~60s, 1920×1080, calm product-forward showcase.
**Reference:** the Grok 4.5 / xAI cut — real product UI in device frames, soft
neutral background, slow push-ins and cross-dissolves, almost no on-screen copy.
The product does the talking.

## What changes from the previous cut

The v3 showcase was loud kinetic typography carrying one feature. This is the
opposite discipline:

| | v3 (kinetic) | This |
| --- | --- | --- |
| Motion | snap, hard cuts | slow push-in, cross-dissolve |
| Type | oversized, dominant | small, one line, sparingly |
| Content | recreated components | **real product screens** |
| Background | pure black | soft neutral, product floats |
| Features | 1 (missed runner) | 6 |
| Feel | trenches energy | considered, calm, "this is real software" |

The single biggest lever is **real screens**. The reference is ~90% actual UI.
Recreations will read as a mockup no matter how good the motion is.

---

## Shot list

Timings are targets; each beat is a `Sequence` so they retune cheaply.

### 0:00–0:06 — Cold open
**Shot:** Console home (module picker) in a browser frame, centred, small in
frame. Very slow push-in (scale 1.00 → 1.06).
**On screen:** nothing for 2s. Then, small, lower third:
> Every alpha call. One console.

**Why:** the reference opens on the product at rest, not on a claim. Earn the
claim after the viewer has seen something real.

### 0:06–0:16 — The feed
**Shot:** Feed page, multi-pane. Messages arriving live. Push in toward one pane,
then a tighter push onto a single message as a contract address appears and gets
highlighted.
**On screen:** `Discord + Telegram, one stream`
**Motion note:** the CA highlight is the first "moment" — hold on it 1.5s.

### 0:16–0:26 — Detection and enrichment
**Shot:** The same contract, now enriched — symbol, market cap, liquidity, chain
badge, trade links. Cross-dissolve from the raw message to the enriched card.
**On screen:** `Detected and enriched, the second it drops`
**Why:** this is the core mechanic and the clearest "it does work for you" beat.

### 0:26–0:36 — Missed-runner alert  ← the emotional hook
**Shot:** Console at rest, then the alert toast slides in. Push in on it. Then a
cut to the token's chart having run.
**On screen:** `Alerts while it is still early`
**Why:** the strongest story you have. Keep the 1.7×-then-3301x framing from v3 —
the alert fires early, it is not a post-hoc notification.

### 0:36–0:44 — FOMO board
**Shot:** FOMO page — live trades, leaderboard, tracked traders. Slow lateral
drift across the board rather than a push.
**On screen:** `fomo.family, live`

### 0:44–0:52 — Portfolio
**Shot:** Portfolio page — PnL, holdings, activity, chart.
**On screen:** `Your wallets, your P&L`

### 0:52–1:00 — Close
**Shot:** Cross-dissolve to clean background. OCT wordmark, centred. Beat. URL
fades in beneath.
**On screen:**
> **OCT**
> onchaintools.tech

**Why:** the reference ends on a still logo with air around it. Resist adding a
CTA line — the calm ending is the flex.

---

## Production notes

### Background
Soft neutral rather than pure black. The reference floats the product on
near-white; OCT's identity is dark, so the equivalent is a very dark neutral
(`#0a0a0a` surface on `#000` with a subtle vignette) — enough separation that the
UI reads as an object in space, not a full-bleed screenshot.

### Device frames
Browser chrome for desktop shots. Keep it minimal — rounded corners, thin border,
no fake traffic lights or URL bar clutter. The frame exists to separate product
from background, nothing more.

### Motion
- Push-ins: 1.00 → 1.06 over the full beat. Slower than feels right.
- Transitions: 400–600ms cross-dissolve. No wipes, no snap.
- Never move two things at once. If the camera pushes, the UI holds.

### Type
Fraunces for the wordmark only. Everything else IBM Plex Mono at ~28px, low
contrast (`#888`), lower-third, fading in 400ms after the shot settles.

---

## Open items — these gate production

### 1. Real screens (blocking)

This style needs actual OCT UI for six pages: Home, Feed, Call, FOMO, Directory,
Portfolio — with plausible data in them. Options:

- **Demo mode** — the deferred backend/frontend flag that pumps synthetic
  messages through the real pipeline. ~30–60 min. Also solves the product problem
  that people cannot evaluate OCT without a Discord token.
- **Operator capture** — you run the console with real data, I capture and
  redact.

Recreating these in Remotion is the wrong answer here. The reference works
*because* it is real.

### 2. Music (needs a decision)

I will not lift the audio from the reference — it is xAI's licensed track, and a
launch video that a partner retweets is exactly where a content-ID claim or
takedown hurts. Licensed alternatives in the same register (ambient, slow build,
no drums until ~30s):

| Source | Cost | Note |
| --- | --- | --- |
| Uppbeat | free tier w/ credit | fastest path |
| YouTube Audio Library | free | no attribution needed on many tracks |
| Epidemic Sound | ~$15/mo | closest to the reference's production quality |
| Artlist | ~$17/mo | broad ambient catalogue |

Pick a track, drop the file in `video/public/audio/`, and it wires in with
Remotion's `<Audio/>` in one line.

### 3. Asset sourcing (correction)

Mobbin hosts screenshots of **other companies' apps**. Those cannot go in an OCT
launch video — it would show competitors' products as if they were yours. What
Mobbin is genuinely useful for here is *reference*: study how those cuts frame
and pace product shots, then apply it to OCT's own screens.

shadcn/ui is likewise the wrong tool for the product shots — OCT's console is not
shadcn-based, so building with it produces a recreation, not the product. It is
fine for incidental chrome (device frames, a clean end card) if we want it.

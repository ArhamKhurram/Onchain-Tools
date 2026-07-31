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

### 0:44–0:52 — Caller radar  ← the differentiator
**Shot:** Callers page, radar table. Slow push onto a couple of rows so the bands
and hit-rates are legible — an `elite` row next to a `slop` row is the whole
argument in one frame.
**On screen:** `Which callers are actually worth following`

**Why this and not Portfolio.** PnL is table stakes; every terminal has it, and it
shows nothing only OCT can do. The radar does: it scores every caller across your
feeds on their own calls — median multiple, 2x and 5x hit rates, slop rate, calls
per day — and bands them `unrated / slop / mixed / solid / elite` once there are
at least 10 rated calls (`MIN_RATED_CALLS`). `elite` means a 2x hit rate of 40%
or better with a slop rate at or under 40%; `slop` means 80%+ of calls never
cleared 1.2x.

That is the beat that lands the product: you are in ten alpha groups, and this
tells you which handful of people in them are actually worth reading. Keep the
copy understated — the table is doing the persuading.

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

### 1. Real screens — no longer blocked

This style needs actual OCT UI for five surfaces: **Home, Feed, Call, FOMO,
Callers (radar)** — with real data in them.

Demo mode was the plan while the hosted console could not load anything. That is
no longer necessary: the production backend was unreachable from the browser
because the domain was missing from the backend's allowed-origins list, and with
that fixed the console loads config, rooms, contracts, FOMO and callers normally.
**Capture the real thing.**

Demo mode is still worth building later — it is what lets someone evaluate OCT
before pasting a Discord token — but it is not on this video's critical path.

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

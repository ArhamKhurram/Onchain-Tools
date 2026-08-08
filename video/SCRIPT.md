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

### 0:44–0:52 — Radar  ← the differentiator
**Shot:** Callers &rarr; **Radar** tab (not the Contract feed tab). The full token
table: `TOKEN / MENTIONS / CALLERS / GROUPS / LATEST / MC@CALL / MC NOW / × /
FIRST CALLER`, with the `EARLY` and `CROWDED` tags visible on the token column.
Hold wide for ~2s so the density reads, then a slow push toward the right-hand
columns where the multiple and the first caller sit.
**On screen:** `Every call, ranked by who made it`

**What the frame is arguing.** Each row is a token somebody called, with how many
people called it, at what market cap, and what it did since. The `×` column is
the verdict. `EARLY` versus `CROWDED` says whether you are looking at it before
or after the room piled in.

**Caller quality is the point of the beat.** The `FIRST CALLER` column carries the
earned band — the same colour and badge the feed uses — so a name is not just a
name: it is a track record. Bands are `unrated / slop / mixed / solid / elite`,
assigned once a caller has at least 10 rated calls (`MIN_RATED_CALLS`). `elite`
means a 2x hit rate of 40% or better with a slop rate at or under 40%; `slop`
means 80%+ of their calls never cleared 1.2x. Frame the push so at least one
banded name is legible — an `elite` name next to a `slop` name is the whole
argument in a single frame.

**Why this and not Portfolio.** PnL is table stakes; every terminal has it and it
demonstrates nothing only OCT can do. This does: you are in ten alpha groups, and
this tells you which handful of people in them are worth reading. Keep the copy
understated — the table persuades better than a headline.

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
Callers &rarr; Radar** — with real data in them.

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

**Do not reuse the reference's audio.** A candidate mp3 was checked against the
reference video's track: identical duration to the microsecond and a Pearson
correlation of 1.0 across the first 30s — a bit-for-bit rip. On a launch promo
that a partner retweets, a Content ID match can mute or pull the post at the
worst possible moment. Any track dropped in `public/audio/` should be one we hold
a licence for.

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

---

## Rollout cut — pump.fun

**Target:** ~45s, 1920×1080, same calm discipline as the Launch cut — slow
push-ins, cross-dissolves, one small lower-third line per beat, ending on the
still wordmark. Composition: `src/compositions/Rollout.tsx` (registered as
`Rollout`; render with `npm run render:rollout`).

**Why this one is recreated, not captured.** pump.fun trader tracking is a *new*
feature, so there is no `demo.mp4` to punch into the way Launch does. The panels
are native recreations in the ConsoleUI idiom (mono type, surface cards, hard
black header rails, cockpit radius), mirroring the real components in
`frontend/src/components/pumpfun/*` — the profile header, the Recent trades
table (Side / Token / Amount / SOL value / When), PnL per token (Realized /
Unrealized), and the Recent callouts table (Mcap @ call / peak / multiple). When
a real recording exists, swap these for captured shots the way Launch does.

**Hero is the pump.fun trader.** Beats 1–4 all sit on the same tracked wallet
(`@westtrades`) and spend the bulk of the runtime; FOMO and the console montage
are brief nods so the cut lands as "pump.fun tracking, inside the one console."

Timings are targets; each beat is a `Sequence` (30fps) so they retune cheaply.

| # | Beat | Window | Dur | Shot | On screen |
| --- | --- | --- | --- | --- | --- |
| 1 | Track a trader | 0:00–0:05 | 5s | Traders tab: paste a wallet → Track; profile resolves. Slow push-in. | `Track any pump.fun trader.` (from 2s) |
| 2 | Live buys & sells | 0:05–0:13 | 8s | Recent trades table, rows arriving; BUY green / SELL red side pills, SOL size, timestamp. | `Their buys and sells, live.` |
| 3 | PnL per token | 0:13–0:20 | 7s | PnL table: realized + unrealized per coin, green/red. | `Realized and unrealized, per coin.` |
| 4 | Callouts ← the payoff | 0:20–0:29 | 9s | Recent callouts: what they called, mcap @ call → peak, and the multiple. | `And what they called — mcap, and the multiple it hit.` |
| 5 | FOMO live trades | 0:29–0:35 | 6s | fomo.family board — tracked traders' live buys/sells. | `fomo.family traders, live.` |
| 6 | Console montage | 0:35–0:40 | 5s | Three tiles — Feed / Radar / Sniper — as "one console for all of it." | `One console for all of it.` |
| 7 | Close | 0:40–0:45 | 5s | Cross-dissolve to clean black; OCT wordmark, then URL. | `OCT` · `onchaintools.tech` |

**Sample data (all fabricated, `Rollout.tsx`).** Trader `west` / `@westtrades`,
wallet spells FAKE like the fixtures token. Tickers are invented memecoins (TOAD,
GIGA, GONK, MOOSE, WOJAK, NYAN). Trades run 5–25 SOL; PnL is mostly green with one
red (WOJAK). Callouts carry the believable-not-cartoonish range: TOAD `$25.6K →
$6.75M` `263x` down to GONK `36x`. FOMO handles (`solstice`, `degenjeff`,
`moonboy`, `trenchlord`) are invented too.

**Music:** same open item as the Launch cut — none wired yet; drop a licensed
track in `public/audio/` and add one `<Audio/>`. Do not reuse any reference audio.

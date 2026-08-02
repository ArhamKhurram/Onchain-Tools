---
title: "Sniper: execution and risk controls"
description: The fire path, the executor registry, and the one function allowed to spend money.
sidebar:
  order: 11
---

Exactly one function may spend: `executeFire`. Every control lives inside it,
because a control anywhere else can be routed around — by a retry, by a ladder
leg, by a second wallet, or by a future caller who didn't read this page.

## Phase 1 fire path

```mermaid
sequenceDiagram
  participant SS as social-stream
  participant M as Matcher
  participant X as executeFire
  participant DB as SniperStore
  participant V as Venue
  participant P as Pushover

  SS->>M: NormalizedTweet (lineage joined)
  M->>M: fan-out index lookup, AND/OR/NOT eval
  M->>M: staleness gate vs tweet timestamp
  M->>X: FireIntent (rule, trigger_key, mint, sizeTotal)
  Note over X,DB: steps 0-2 run before any external call
  X->>DB: read kill switch
  X->>DB: insert trigger claim, on conflict abort
  X->>DB: reserve perTriggerCap atomically
  X->>DB: insert leg rows, one per wallet per leg

  loop each leg, until filled or fireWindowMs or maxAttempts
    X->>DB: re-read kill switch and pushed mcap
    X->>DB: reserve leg amount plus fees atomically
    X->>V: send with correlation_id
    alt confirmed
      V-->>X: signature
      X->>DB: state filled, record FILLS
    else provably dead (4xx validation, 429, connect refused)
      V-->>X: error
      X->>DB: release leg reservation, attempt_no plus 1
    else indeterminate (timeout, 5xx, no response)
      X->>DB: state unknown, hold reservation
      Note over X,DB: never retried inline — the reconciler resolves it
    end
  end

  X->>DB: terminal state filled, expired, or aborted
  X->>P: notify with outcome
```

Note the asymmetry in the `alt`: **only provably-dead attempts release their
reservation and retry.** An indeterminate send holds its reservation and exits the
loop. The reference implementation this pattern comes from warns about exactly
this — giving up while the trade succeeds makes the operator re-fire and
double-buy.

## Execution venues

**Phase 1 ships exactly one real venue: Slotshark.**

| | Slotshark (Phase 1) |
| --- | --- |
| Chains | Solana only |
| Custody | **custodial** — the account holder funds a wallet in Slotshark's own dashboard |
| Fire path | `POST /buy` |
| Private key in our system | **none** — custodial |
| Our credential | developer API token (Bearer) |
| Credential blast radius | token authorizes **buy, sell and withdraw**: a leak is a total drain of every funded wallet — see [security T3](../sniper-security/) |
| Fee | 0.5% per trade |
| Regions | `us`, `eu` (fixed compile-time enum) |

### GMGN is not a Phase 1 venue, on purpose

OCT already holds a `GMGN_API_KEY` — but it belongs to the **operator** and is
provisioned for enrichment and market data (`utils/gmgnClient.ts`). Promoting it to
a trading credential would route every user's snipes through the operator's own
GMGN account: commingled funds, and a custody problem created by accident rather
than decision.

So `Venue` in `backend/src/sniper/types.ts` is `'slotshark' | 'dryrun'`, and
`venueCredentials.ts` maps no venue to `GMGN_API_KEY`. The exclusion is structural,
not a convention someone can forget.

When GMGN trading does land, it arrives as a **per-user connected credential**
([ADR-012](../../adr/012-venue-tenancy/)) resolved from Vault — the user brings
their own GMGN account. That is milestone M11, and it unlocks the EVM/BSC leg at
the same time. Two properties of GMGN carry forward to that work, both established
during research: it is **custodial** (a swap takes `--from <wallet_address>`, no
private-key parameter, and returns an `order_id` to poll), and it fires
**deterministically** via signed REST at `openapi.gmgn.ai` — the "Agent API" /
gmgn-skills layer is `SKILL.md` markdown plus a CLI over those same `/v1/*`
endpoints, so it belongs to Phase 3 rule *composition*, never the fire path. Its
separate **cooperation router** (1 call / 5 s, unsigned tx) stays disqualified by
the latency budget regardless.

Any additional venue is a new `Executor` — no change to the risk gate or the rule
schema.

### Slotshark request shape

`POST https://{us|eu}.slotshark.xyz/buy`, `Authorization: Bearer <token>`:

```json
{ "mint": "...", "solAmount": 0.5, "wallet": "...", "slippage": 20,
  "antimev": true, "retries": true, "tip": 0.001, "priorityFee": 0.0005 }
```

Omitting `tip` / `priorityFee` is meaningful — it selects the venue's auto
pricing, so they are assigned conditionally rather than sent as `null`. The region
is a **fixed compile-time enum, never operator input**; a free-form base URL would
be an SSRF vector. That pattern is not optional — see threat T4 in
[security](../sniper-security/).

### The executor registry

As shipped in `backend/src/sniper/types.ts`:

```ts
type Venue = 'slotshark' | 'dryrun';

interface Executor {
  readonly venue: Venue;
  readonly chains: readonly Chain[];
  send(intent: FireIntent, leg: FireLeg, correlationId: string): Promise<SendOutcome>;
}

type SendOutcome =
  | { kind: 'filled'; signature: string; amountIn: number; amountOut: number; feePaid: number }
  | { kind: 'dead'; reason: DeadReason; status: number }
  | { kind: 'unknown' };
```

`send` takes the **leg**, not just the intent, because one trigger fans out to one
leg per (wallet x ladder step) and each leg is a separate send with its own
reservation and its own `correlationId`.

`reconcile(wallet, mint, since)` is specified but **not yet implemented** — it lands
with M3, alongside the first real fills. It is deliberately shaped as a history query
rather than `status(ref)`: an indeterminate send returned no response, therefore no
venue reference, so `status(ref)` cannot service the case it exists for.
Reconciliation queries the venue's own fill history by
`(wallet, mint, since)` and matches against our leg rows. Where a venue accepts a
client-supplied idempotency key, `correlationId` is passed through and
reconciliation is exact; where it does not, the match is heuristic and that is
stated at the call site.

### Chain-tagged execution params

Execution params are not portable across chains, so they are modelled as a
discriminated union rather than a flat bag:

```ts
type ExecParams =
  | { kind: 'sol'; tip?: number; priorityFee?: number; antimev: boolean }
  | { kind: 'evm'; maxFeePerGas?: string; maxPriorityFeePerGas?: string;
      gasLimit?: string; mevRelay?: 'bloxroute' | '48club' | 'blockrazor' | null };
```

The Solana fields are the `tip` / `priorityFee` / `antimev` shape in the Slotshark
request above; omitting `tip` / `priorityFee` still selects the venue's auto
pricing. On BSC the Jito analogue is **gas bidding plus a private-relay choice** —
bloXroute, 48Club or BlockRazor — against a ~0.45 s block time. One caveat when
firing **through** GMGN: GMGN's `--anti-mev` is a boolean and GMGN picks the relay,
so `mevRelay` is only actionable if OCT submits to a relay directly.

**BSC carries rug classes Solana does not.** Honeypots, transfer taxes, pausable
and upgradeable-proxy tokens cannot exist on a standard SPL mint but are routine on
BSC. The services that catch them — GoPlus, honeypot.is — take ~3 s, which
**disqualifies them from the hot path** exactly as GMGN's cooperation router is
disqualified. So BSC either pre-screens out of band — a candidate clears screening
*before* it can arm a rule — or the operator accepts the risk at a deliberately low
cap. There is no inline check that fits the budget; state it honestly.

### Error taxonomy

| Venue signal | Kind | Retry? |
| --- | --- | --- |
| 400/422 validation | `validation` | no — the request is wrong, not the network |
| 401/403 | `auth` | no — alert, trip the kill switch |
| 429 | `rate_limit` | yes, with backoff — provably not submitted |
| Connection refused / DNS | `network` | yes — provably not submitted |
| Timeout (`AbortSignal.timeout`) | — | **`unknown`** |
| 5xx | — | **`unknown`** |
| Anything unmapped | — | **`unknown`** |

A 5xx is *not* provably unsubmitted — a gateway can time out downstream of a
submission that landed. Only signals that prove the request never reached the
chain are retryable. **The default for anything unrecognized is `unknown`, not
`dead`**, because the failure mode of guessing wrong is a double buy.

Slotshark's real taxonomy is not documented to us. M5 builds it empirically; until
then only the rows above are mapped and everything else falls through to `unknown`.

## Risk-control enforcement

### The reservation

Check-then-spend is a race. The cap is reserved in the same statement that tests
it, and a zero-row result means refused:

```sql
-- $amount is pre-clamped by the caller to
--   min(rule.per_fire_cap, budget.per_fire_cap, requested)
-- and INCLUDES venue fee, tip and priority fee.
insert into sniper_budget (user_id, wallet_id, chain, unit, day,
                           per_fire_cap, spent_today, open_positions)
values ($user, $wallet, $chain, $unit, $day, $default_cap, 0, 0)
on conflict (wallet_id, chain, day) do nothing;

update sniper_budget
   set spent_today   = spent_today + $amount,
       open_positions = open_positions + 1
 where wallet_id = $wallet
   and chain     = $chain
   and day       = $day
   and unit      = $unit
   and $amount  <= per_fire_cap
   and spent_today + $amount <= daily_cap
   and open_positions < max_open
returning id;
```

Four things here are load-bearing and each was a defect before review:

- **The `insert ... on conflict do nothing` is not optional.** Without it the
  `update` matches zero rows on the first fire after every date rollover, which
  the design reads as "cap refused" — so every fire is refused until someone
  inserts a row by hand.
- **`wallet_id` and `chain` in the predicate.** Keyed on `user_id` alone, a
  two-wallet operator matches both rows, debits both, and returns two rows — so
  the zero-row test passes while the wrong budget was checked.
- **`unit` in the predicate.** Without it, `5` (SOL) validates against a
  `per_fire_cap` of `1000` (USDC) and 5 SOL leaves the wallet. Caps are
  deliberately denominated in native units to avoid an oracle, which only works if
  incommensurable numbers never meet.
- **`$amount` includes fees.** Slotshark's 0.5%, plus `tip` and `priorityFee`, are
  all real funds leaving the wallet. Debiting `solAmount` alone makes a daily cap
  soft by an unbounded margin.

Assert exactly one row updated. Any other count is a hard abort, not a pass.

### Two cap levels

| Cap | Bounds | Reserved |
| --- | --- | --- |
| `perTriggerCap` | `sizeTotal × walletIds.length` — the whole tweet | once, before the first leg sends |
| `perFireCap` | one leg on one wallet | per leg, in the statement above |

Without `perTriggerCap`, a five-leg ladder each at `perFireCap` spends
5 × `perFireCap` on one tweet, and "per-fire cap" bounds nothing an operator
thinks it bounds.

### Where each control lives

| Control | Enforced at | Survives restart |
| --- | --- | --- |
| Kill switch | `sniper_state` row, re-read every attempt | ✔ |
| Trigger idempotency | unique index, written before any send | ✔ |
| Per-trigger cap | `executeFire` step 2 | ✔ |
| Per-fire cap | the reservation statement | ✔ |
| Daily cap | same statement | ✔ |
| Max concurrent positions | same statement | ✔ |
| Fires-per-minute breaker | `executeFire`, trips the kill switch above K | ✔ |
| Auto-disable after fire | same transaction as the reservation | ✔ |
| Retry ceiling | `attempt_no` on the leg row, updated in place | ✔ |

The fires-per-minute breaker is distinct from per-rule caps and exists for
fan-out amplification: 50 rules on one handle and one viral tweet is 50 fires,
each individually within its cap.

### The control plane is part of this

The sniper's API **must not** mount on the existing local `/api` router.
`backend/src/index.ts:621` falls through to `app.use(cors())` in local mode —
wildcard origin — and `backend/src/auth/middleware.ts:32` sets
`req.userId = 'local'` with no credential. Any web page
the operator visits can therefore issue a cross-origin `fetch` to
`http://127.0.0.1:3001/api/...` and read the response. For today's endpoints that
leaks tokens; for a money-spending endpoint it would let a web page author an
armed rule with caps of its own choosing, and every control above would be intact
and irrelevant because the attacker wrote the rule.

Requirements, in both modes:

- A per-boot random bearer token written to a `0600` file under `OCT_DATA_DIR`.
- A strict `Origin` / `Host` check on every sniper request.
- Mount outside `/api` (e.g. `/sniper/v1`) or add the route to the hosted
  `generalLimiter` skip predicate — that limiter (300 req/min/IP,
  `index.ts:654`) covers the `/api` prefix, and a burst of terminal-state
  callbacks must not be throttled into the retry loop.

[ADR-008](../../adr/008-local-loopback/) argues loopback binding is sufficient for
the current surface. **That argument does not extend to an API that spends money.**

## The dry-run seam

Three switches, in precedence order:

| Switch | Scope | Notes |
| --- | --- | --- |
| `OCT_SNIPER_DRY_RUN=1` | process | uncleavable; wins over everything |
| `EXECUTION_VENUES.enabled = false` | venue | how the optional Slotshark venue ships off by default |
| `SnipeRule.dryRun` | rule | per-rule |

Dry run **exercises the risk machinery rather than bypassing it** — the
reservation is taken for real, so M4's adversarial tests are meaningful. It
therefore also needs a release path: a synthetic fill decrements
`open_positions` and reverses `spent_today` on the same transaction that records
it, because no balance poll will ever show a synthetic position closing.

## M4: the tests that prove the caps bind

Adversarial, not happy-path:

1. Ladder of 5 legs, each at `perFireCap` → total spend must equal
   `perTriggerCap`, not 5 × `perFireCap`.
2. Multi-wallet fan-out across 3 wallets → 3 leg rows, 3 budget rows, one trigger.
3. Fire at 23:59:59.9 → the rollover insert fires, the next fire is not refused.
4. Kill switch tripped mid-retry → the in-flight loop aborts before the next send.
5. Process killed between reservation and send, then restarted → the trigger claim
   suppresses the replay; the orphaned reservation is released by the reconciler.
6. Venue times out but the trade landed → `unknown`, reconciler finds the fill,
   exactly one `FILLS` row.
7. Rule with `sizeUnit: 'USDC'` and a SOL wallet → refused at arm time.

/**
 * Market-cap crossing poller — "ping me when ANY coin crosses $750K, minus the
 * scams."
 *
 * ITS OWN SIGNAL, END TO END. Per CLAUDE.md, convergence, FOMO buys and
 * missed-runner are distinct signals that may be displayed together and must
 * never be fused. So this lives in its own directory beside `revival/`,
 * `priceAlerts/` and `journal/`, with its own universe, its own store and its
 * own delivery. It REUSES pure helpers from those subsystems — `evaluateCrossing`
 * (priceAlerts), the DexScreener batch read (marketData), the GeckoTerminal pool
 * sweep (marketData), the network table (revival/networks) — and it reads none
 * of their detection state. Nothing in here can see a revival verdict, and the
 * revival poller cannot see a crossing.
 *
 * WHY IT IS NOT PART OF priceAlerts. Superficially this is "an alert on a
 * market-cap level", which is what that poller does. Structurally it is the
 * opposite: price alerts have no discovery and no detection (an operator names
 * the token and the level), while this one has nothing BUT discovery — the
 * whole feature is finding tokens nobody named. Folding it in would put a
 * chain-wide sweep inside a subsystem whose defining property is that it costs
 * nothing when the operator has set no levels.
 *
 * THE CYCLE, every OCT_MCAP_CROSS_POLL_MS (default 3 min):
 *   1. Self-gate. No subscribed Telegram chat → return immediately, before any
 *      request. See the note on cost below; this is the whole reason the
 *      feature is safe to ship switched on.
 *   2. Universe: the busiest tokens on each watched chain (universe.ts,
 *      GeckoTerminal, hour-cached).
 *   3. Load each token's last seen market cap (state.ts).
 *   4. Read current market caps from DexScreener in batches (marketData/
 *      dexBatch.ts, including the 30-pair-cap halving retry).
 *   5. Per token: `evaluateCrossing` with a FIXED target of 750K and direction
 *      'above'. Same semantics as a price alert — a transition, never a level
 *      test, first observation arms without firing, and a missing reading is
 *      an abstain that writes nothing.
 *   6. ONLY on a crossing: one GMGN security lookup and the gates (gates.ts).
 *      Pass → alert. Reject → drop silently, log the failed gates. Abstain →
 *      write nothing so the crossing is re-detected, bounded by the ledger.
 *   7. One batched state write for the cycle.
 *
 * THE COST MODEL IS THE FEATURE. The universe is thousands of tokens; only the
 * ~30-80 a day that actually cross 750K ever cost a security call. That is a
 * few calls an hour against GMGN, whose limiter is already shared with token
 * enrichment. Discovery costs ~15 GeckoTerminal requests an hour (about 4% of
 * the ~6/min budget revival depends on — see universe.ts), and market-cap
 * polling costs ~10 DexScreener requests per cycle against a ~300/min keyless
 * ceiling shared politely with the price-alert poller. Move the security check
 * any earlier in this list and the economics collapse.
 *
 * AND WHEN NOBODY IS SUBSCRIBED IT COSTS NOTHING AT ALL. Step 1 is not an
 * optimisation. The Telegram alert class defaults to OFF in every chat
 * (tgbot/alertPolicy.ts, and the flood incident it documents), so on a fresh
 * deploy this poller makes zero requests to anything until a human deliberately
 * turns it on. That is the same self-gating shape the price-alert poller uses
 * for "zero armed alerts, zero requests", and it is what lets a chain-wide
 * sweep default to enabled without spending anyone's budget speculatively.
 *
 * COOLDOWN. A token that has alerted is muted for OCT_MCAP_CROSS_COOLDOWN_MS
 * (default 24h). A market cap oscillating around the threshold would otherwise
 * produce a genuine crossing every few minutes, all of them true and all of
 * them noise — the same shape as the missed-runner poller's 24h row.
 *
 * PER-USER FILTERS SIT AT DELIVERY, NOT AT DETECTION (see filters.ts). Steps
 * 1-6 above are shared by everyone and unchanged: one universe, one crossing
 * state per token, one security lookup. What changed is step 6's last word.
 * The OPERATOR baseline (env) still decides what gets WRITTEN — pass, reject
 * and, critically, abstain — because the crossing ledger is global and a
 * per-user threshold must never be able to make the sweep re-spend a security
 * call. Then, and only for a crossing that got as far as a verdict, the same
 * pure gate function is re-run once per CONNECTED user against their own
 * thresholds to decide who sees it.
 *
 * That re-run is free: `evaluateMcapGates` is pure and the security payload is
 * already in hand, so N users cost N comparisons and zero requests. Filters
 * themselves are read at most once per user per firing crossing and cached for
 * a minute, which on the observed 30-80 crossings a day is a rounding error
 * against the Supabase egress budget — nothing per-message, nothing per-cycle.
 *
 * ABSTAIN STAYS ABSTAIN ON BOTH LAYERS. If the baseline abstains, nobody is
 * evaluated and nothing is delivered. If a user's own evaluation abstains, that
 * user does not receive it either — a threshold can narrow or widen a
 * comparison, but it can never turn "we could not tell" into "clear".
 */

import type { WsServer } from '../ws/server.js';
import type { RevivalNetwork } from '@oct/shared';
import { REVIVAL_NETWORK_CHAIN_SLUGS } from '@oct/shared';
import { evaluateCrossing } from '../priceAlerts/crossing.js';
import { readDexSnapshots, type MintSnapshot } from '../marketData/dexBatch.js';
import { fetchUniverse, type UniverseToken } from './universe.js';
import { fetchTokenSecurity } from './security.js';
import {
  evaluateMcapGates,
  resolveGateConfig,
  resolveTargetMcapUsd,
  type McapGateConfig,
} from './gates.js';
import { resolveUserGateConfig } from './filters.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { AbstainLedger } from './abstainLedger.js';
import { loadState, recordObservations, stateKey, type McapCrossRow } from './state.js';

export const DEFAULT_POLL_MS = 180_000; // 3 min
const DEFAULT_COOLDOWN_MS = 24 * 3_600_000;
/** Mints per DexScreener request. 30 is the address limit; see dexBatch.ts. */
const DEFAULT_BATCH_SIZE = 25;
const LOG = '[McapCross]';

/**
 * DexScreener chain slug per watched network, used to reject a same-address
 * collision across chains. `/latest/dex/tokens/{addr}` is address-keyed and
 * chain-agnostic, so one 0x… address deployed on both BNB and Robinhood comes
 * back as one set of pairs; without this check the wrong chain's market cap
 * could be attributed to the token we asked about.
 *
 * Only a KNOWN, MISMATCHED slug rejects. An unrecognised slug passes: this map
 * is our belief about DexScreener's naming, not DexScreener's contract, and
 * being wrong about it must cost a false negative rather than a wrong alert.
 */
const DEX_CHAIN_SLUGS: Record<RevivalNetwork, string> = {
  solana: 'solana',
  bsc: 'bsc',
  robinhood: 'robinhood',
};
const KNOWN_DEX_SLUGS = new Set(Object.values(DEX_CHAIN_SLUGS));

/** What a fired crossing carries to every transport. */
export interface McapCrossAlertData {
  address: string;
  network: RevivalNetwork;
  /** OCT chain slug ('sol', 'bsc', 'robinhood'), for link building. */
  chain: string;
  symbol: string | null;
  /** Market cap at the crossing — the value that broke through the target. */
  mcapUsd: number;
  /** The target it crossed. Carried so a changed threshold is legible later. */
  targetUsd: number;
  liquidityUsd: number | null;
  /**
   * Traded USD over 24h, summed across the token's pools. Null = DexScreener
   * did not report one; it is never rendered as zero, because a token nobody
   * has a volume figure for and a token nobody traded are different claims.
   */
  volume24hUsd: number | null;
  /**
   * Estimated USD paid in trading fees/tax over 24h — `volume x tax rate`, the
   * operator's "Total Fees" metric (fees.ts). Null whenever either half was
   * unknown, which includes EVERY Solana token, since a transfer tax cannot
   * exist there. USD, not the ETH/SOL Axiom prints.
   */
  totalFeesUsd: number | null;
  /** liquidity / mcap at the crossing. Null when liquidity was unknown. */
  liquidityRatio: number | null;
  /** Previous observation, i.e. where it crossed FROM. */
  previousMcapUsd: number | null;
  /**
   * Non-blocking gate caveats (today: `honeypotUnknown`). Carried onto the wire
   * frame and the Telegram card so a check that never ran is never presented as
   * a check that passed. See GateVerdict.caveats.
   */
  caveats: string[];
  triggeredAt: string;
}

/**
 * Everything a transport needs to decide WHO gets one crossing, without being
 * able to make the sweep spend anything.
 *
 * The Telegram roster is a set of CHATS, not OCT users — but every chat row
 * carries `source_user_id`, "whose alerts this chat receives", so a chat that
 * has been linked resolves to exactly one OCT user (tgbot/source.ts). That user
 * has filters. This is how the transport asks about them.
 *
 * `passesFor` is a CLOSURE over the gate input and the security payload the
 * poller already paid for: N users cost N pure comparisons and zero requests,
 * and the filter read behind it is cached per user for a minute. Handing the
 * transport the raw `TokenSecurity` instead would let a future caller re-run
 * detection on its own terms; a boolean cannot.
 */
export interface McapCrossDeliveryVerdict {
  /**
   * Did the OPERATOR baseline pass? This is what a chat that resolves to NO
   * user gets — i.e. exactly what every chat got before per-user filters
   * existed. Preserving it is the difference between a new feature and a silent
   * regression in chats nobody has linked.
   */
  baselinePass: boolean;
  /**
   * Would this OCT user's own thresholds pass it? Only a `pass` is true: an
   * abstain is never a yes, so a threshold can narrow or widen a comparison but
   * can never turn "we could not tell" into "clear".
   */
  passesFor(userId: string): Promise<boolean>;
}

/**
 * How a fired crossing gets out of this module.
 *
 * Injected rather than imported so `mcapCross/` never reaches into `tgbot/`.
 * `hasSubscribers` is the self-gate from step 1: index.ts wires it to the
 * Telegram chat roster.
 */
export interface McapCrossDelivery {
  hasSubscribers(): Promise<boolean>;
  deliver(data: McapCrossAlertData, verdict: McapCrossDeliveryVerdict): void;
}

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function envInt(name: string, fallback: number, min = 0): number {
  const parsed = Number.parseInt(envFlag(name) ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/** Master switch. Only an explicit falsy value disables (journal/price-alert style). */
export function isMcapCrossEnabled(): boolean {
  const raw = (envFlag('MCAP_CROSS_ENABLED') ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

function resolvePollMs(): number {
  // 60s floor: below that the DexScreener budget stops being the constraint and
  // the upstream's own refresh cadence does.
  return envInt('MCAP_CROSS_POLL_MS', DEFAULT_POLL_MS, 60_000);
}

function resolveCooldownMs(): number {
  return envInt('MCAP_CROSS_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
}

/** USD for humans. Market caps are always ≥ $1, so the compact form is enough. */
function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Is this snapshot about the token we asked about, on the chain we meant?
 *
 * Exported for tests — the cross-chain collision it guards against is rare
 * enough that nobody would notice it regressing.
 */
export function snapshotMatchesNetwork(
  snapshot: MintSnapshot,
  network: RevivalNetwork,
): boolean {
  const slug = snapshot.chainId;
  if (slug == null) return true; // no claim made
  if (!KNOWN_DEX_SLUGS.has(slug)) return true; // not a slug we have an opinion about
  return slug === DEX_CHAIN_SLUGS[network];
}

/**
 * How long a user's resolved thresholds are reused before re-reading them.
 *
 * A minute, not a cycle: crossings arrive in bursts (a market move lifts
 * several tokens through 750K at once) and re-reading the same four numbers per
 * token in a burst is exactly the per-item storage read the egress rule exists
 * to prevent. A minute is also short enough that saving a filter in the console
 * takes effect on the next crossing rather than the next restart.
 */
const FILTER_CACHE_MS = 60_000;

/**
 * Per-user gate configs, resolved once and reused.
 *
 * Deliberately NOT keyed on the baseline: the baseline comes from env, which
 * cannot change without a restart, so a stale entry can only be stale about the
 * user's own values — bounded by the TTL above.
 */
class FilterCache {
  private entries = new Map<string, { at: number; cfg: McapGateConfig }>();

  async get(userId: string, baseline: McapGateConfig, now: number): Promise<McapGateConfig> {
    const hit = this.entries.get(userId);
    if (hit && now - hit.at < FILTER_CACHE_MS) return hit.cfg;

    // Never throws — the storage layer degrades a failed read to "no
    // overrides". An alert must not be lost to a transient database blip.
    const stored = await getStorageProvider().getMcapCrossFilters(userId);
    const cfg = resolveUserGateConfig(stored, baseline);
    this.entries.set(userId, { at: now, cfg });
    return cfg;
  }

  /**
   * Drop entries that are neither live nor fresh, so this cannot grow.
   *
   * "Live" is the set of connected console users. TTL is the second condition
   * because the Telegram side asks about users who may hold no socket at all —
   * a linked chat's owner reading alerts on their phone. Evicting those on
   * every cycle would turn a burst of crossings into one storage read per
   * crossing, which is precisely the per-item egress the cache exists to stop.
   */
  prune(live: Set<string>, now: number = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (!live.has(key) && now - entry.at >= FILTER_CACHE_MS) this.entries.delete(key);
    }
  }
}

class McapCrossPoller {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private readonly ledger = new AbstainLedger();
  private readonly filters = new FilterCache();
  /** Logged once so a subscriber-less deploy does not repeat itself forever. */
  private loggedIdle = false;

  constructor(
    private readonly wsServer: WsServer,
    private readonly delivery: McapCrossDelivery,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isMcapCrossEnabled()) {
      console.log(`${LOG} Disabled via OCT_MCAP_CROSS_ENABLED; poller idle.`);
      return;
    }

    const interval = resolvePollMs();
    console.log(
      `${LOG} Started (interval ${interval}ms, target ${formatUsd(resolveTargetMcapUsd())}). ` +
        'Idle until a chat subscribes.',
    );
    this.timer = setInterval(() => {
      void this.poll().catch((err) =>
        console.error(`${LOG} poll error:`, (err as Error)?.message),
      );
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Step 1 — the self-gate. Before discovery, before anything.
      if (!(await this.delivery.hasSubscribers())) {
        if (!this.loggedIdle) {
          console.log(`${LOG} No chat is subscribed; sweeping nothing until one is.`);
          this.loggedIdle = true;
        }
        return;
      }
      this.loggedIdle = false;

      const universe = await fetchUniverse();
      if (universe.length === 0) return;

      const state = await loadState(universe);
      const snapshots = await readDexSnapshots(
        [...new Set(universe.map((t) => t.address))],
        { batchSize: envInt('MCAP_CROSS_BATCH_SIZE', DEFAULT_BATCH_SIZE, 1), label: LOG },
      );

      await this.evaluate(universe, state, snapshots);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The per-token decision loop. Split out so `poll` reads as the four upstream
   * reads it is.
   */
  private async evaluate(
    universe: UniverseToken[],
    state: Map<string, McapCrossRow>,
    snapshots: Map<string, MintSnapshot>,
  ): Promise<void> {
    const target = resolveTargetMcapUsd();
    const baselineCfg = resolveGateConfig();
    const cooldownMs = resolveCooldownMs();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const writes: McapCrossRow[] = [];
    let fired = 0;
    let rejected = 0;
    let unresolved = 0;

    for (const token of universe) {
      const key = stateKey(token.network, token.address);
      const prior = state.get(key) ?? null;
      const snapshot = snapshots.get(token.address) ?? null;
      const usable =
        snapshot && snapshotMatchesNetwork(snapshot, token.network) ? snapshot : null;

      const verdict = evaluateCrossing({
        direction: 'above',
        targetUsd: target,
        lastSeenUsd: prior?.lastSeenMcap ?? null,
        observedUsd: usable?.mcapUsd ?? null,
      });

      // No pair, no market cap, a failed request, or a cross-chain collision:
      // write nothing at all, so the next real reading is compared against the
      // last real one rather than against a gap.
      if (verdict.action === 'abstain' || verdict.observedUsd == null) continue;

      const observed = verdict.observedUsd;
      const row: McapCrossRow = {
        address: token.address,
        network: token.network,
        lastSeenMcap: observed,
        lastSeenAt: nowIso,
        firedAt: prior?.firedAt ?? 0,
      };

      if (verdict.action !== 'fire') {
        this.ledger.clear(key);
        writes.push(row);
        continue;
      }

      // A genuine crossing, but this token already alerted recently. Record and
      // move on: the crossing is real, the second ping is not news.
      if (row.firedAt > 0 && now - row.firedAt < cooldownMs) {
        this.ledger.clear(key);
        writes.push(row);
        continue;
      }

      // --- The only expensive call in the whole feature, and only here ----
      const security = await fetchTokenSecurity(token.network, token.address);
      const gateInput = {
        network: token.network,
        mcapUsd: observed,
        liquidityUsd: usable?.liquidityUsd ?? token.liquidityUsd,
        // Straight from the batch read that already happened. There is no
        // fallback to the universe row: `UniverseToken` carries liquidity but
        // not volume, and inventing one would be exactly the "silence read as
        // zero" the gate abstains to avoid.
        volume24hUsd: usable?.volume24hUsd ?? null,
        security,
      };
      const gates = evaluateMcapGates(gateInput, baselineCfg);

      if (gates.decision === 'abstain') {
        unresolved += 1;
        if (this.ledger.note(key) === 'retry') {
          // Deliberately NOT written: leaving lastSeenMcap where it was means
          // the crossing is re-detected next cycle, which is what an abstain is
          // for. Bounded by the ledger so an unindexable token cannot leak one
          // security call per cycle forever.
          continue;
        }
        console.warn(
          `${LOG} Giving up on ${token.address.slice(0, 8)}… (${token.network}) at ` +
            `${formatUsd(observed)} — ${gates.abstainReason} after repeated attempts.`,
        );
        writes.push(row);
        continue;
      }

      this.ledger.clear(key);

      // --- Who, if anyone, gets this? -------------------------------------
      // The baseline verdict above governs the STATE and the Telegram surface
      // (that roster is chat-scoped, not user-scoped — see the note on emit).
      // Each connected console user is then judged against their own
      // thresholds, which is why a baseline REJECT is no longer the end of the
      // line: a user who lowered the liquidity floor asked to see exactly that
      // token. Zero requests are spent here; the gates are pure and `security`
      // is already in hand.
      const wsRecipients = await this.recipientsFor(gateInput, baselineCfg, now);
      const toTelegram = gates.decision === 'pass';

      if (!toTelegram && wsRecipients.length === 0) {
        // Dropped silently as far as the user is concerned — but logged, because
        // "the filter is eating everything" and "nothing is crossing" look
        // identical from the outside otherwise.
        rejected += 1;
        console.log(
          `${LOG} FILTERED ${usable?.symbol ? `$${usable.symbol}` : token.address.slice(0, 8)} ` +
            `(${token.network}) at ${formatUsd(observed)} — failed: ${gates.failed.join(', ')}`,
        );
        writes.push(row);
        continue;
      }

      fired += 1;
      // The cooldown row is written whenever the crossing reached ANYBODY, so a
      // token delivered only to a user with loosened filters is still muted for
      // 24h rather than re-alerting them every cycle.
      row.firedAt = now;
      writes.push(row);
      this.emit(
        {
          address: token.address,
          network: token.network,
          chain: REVIVAL_NETWORK_CHAIN_SLUGS[token.network],
          symbol: usable?.symbol ?? null,
          mcapUsd: observed,
          targetUsd: target,
          liquidityUsd: usable?.liquidityUsd ?? null,
          volume24hUsd: usable?.volume24hUsd ?? null,
          // Straight off the verdict rather than recomputed: the gate is the
          // one place the fee model lives, so a card can never disagree with
          // the comparison that produced it.
          totalFeesUsd: gates.totalFeesUsd,
          liquidityRatio: gates.liquidityRatio,
          caveats: gates.caveats,
          previousMcapUsd: prior?.lastSeenMcap ?? null,
          triggeredAt: nowIso,
        },
        wsRecipients,
        {
          baselinePass: toTelegram,
          passesFor: (userId) => this.passesFor(userId, gateInput, baselineCfg, now),
        },
      );
    }

    this.filters.prune(new Set(this.consoleUserIds()), now);

    await recordObservations(writes);

    if (fired > 0 || rejected > 0 || unresolved > 0) {
      console.log(
        `${LOG} cycle: ${universe.length} tracked, ${fired} alerted, ${rejected} filtered, ` +
          `${unresolved} unresolved (${this.ledger.size()} awaiting a retry).`,
      );
    }
  }

  /**
   * The console identities eligible for a per-user evaluation this cycle.
   *
   * Hosted: whoever currently has a socket open. Local: the single implicit
   * user, because local sockets never authenticate and `broadcastRaw` there
   * ignores the id anyway — the filter set still has to be the local user's,
   * which is the whole point of `userId = 'local'`.
   */
  private consoleUserIds(): string[] {
    return isHostedMode() ? this.wsServer.getConnectedUserIds() : ['local'];
  }

  /**
   * Re-run the gates once per connected user, against that user's thresholds.
   *
   * Only a `pass` earns delivery. A user whose own evaluation ABSTAINS is
   * skipped exactly like the baseline abstain above: a threshold changes what a
   * comparison means, never whether the underlying fact was known. That is the
   * property that keeps #369's honest-uncertainty work intact — `caveats` still
   * ride the payload, and no filter value can suppress or fabricate them.
   */
  private async recipientsFor(
    gateInput: Parameters<typeof evaluateMcapGates>[0],
    baseline: McapGateConfig,
    now: number,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const userId of this.consoleUserIds()) {
      if (await this.passesFor(userId, gateInput, baseline, now)) out.push(userId);
    }
    return out;
  }

  /**
   * One user, one crossing: does it clear THEIR thresholds?
   *
   * The single place a per-user verdict is produced, so the console fan-out and
   * the Telegram fan-out cannot disagree about what a filter means. Only `pass`
   * is true — `abstain` is not a yes, here or anywhere.
   */
  private async passesFor(
    userId: string,
    gateInput: Parameters<typeof evaluateMcapGates>[0],
    baseline: McapGateConfig,
    now: number,
  ): Promise<boolean> {
    const cfg = await this.filters.get(userId, baseline, now);
    return evaluateMcapGates(gateInput, cfg).decision === 'pass';
  }

  /**
   * Fan out one alert.
   *
   * TWO TRANSPORTS, AND NEITHER IS `broadcastAlert`. That seam carries a
   * `FrontendMessage` — an actual Discord/Telegram message that somebody
   * posted — and this signal has no message behind it; it is a poller
   * observing a chain. Synthesising a fake message to squeeze through it would
   * put a chat message that never existed into the console's notification
   * history. Revival and breakout hit the same wall and answered it the same
   * way: their own frame. So this emits a raw `mcap_cross_alert` frame, and
   * reaches Telegram through an explicit signal seam on the alert router rather
   * than through alert classification.
   *
   * THE CONSOLE FRAME IS ADDRESSED, NOT BROADCAST. It used to go to
   * everyone (`broadcastRaw` with no id, like `token_peak`) because the payload
   * is a global market fact carrying no user data. It still carries no user
   * data — but WHO SHOULD SEE IT is now a per-user question, so it is sent per
   * recipient. In local mode `broadcastRaw` ignores the id and this collapses
   * back to one send to the single client.
   *
   * TELEGRAM IS ALSO PER-USER NOW, VIA THE CHAT'S OWNER. The bot's roster is a
   * set of CHATS, not OCT users — but each chat row carries `source_user_id`,
   * "whose alerts this chat receives" (tgbot/source.ts), so a linked chat DOES
   * have an owner and that owner has filters. So this hands the transport a
   * verdict rather than a boolean: `baselinePass` for a chat that resolves to
   * nobody (unchanged behaviour), `passesFor(owner)` for one that does. The
   * decision of which to consult belongs to the transport, because only it
   * knows its own roster; the decision of what a filter MEANS stays here.
   *
   * ONE ASYMMETRY, STATED. A crossing the baseline REJECTED only reaches this
   * point when some connected console user's own filters passed it. So a
   * Telegram owner who loosened their filters but holds no console socket does
   * not get the widening — they get everything the baseline passes, narrowed by
   * their own thresholds. Narrowing (the feature) is complete; widening is
   * best-effort, and closing the gap would mean reading the chat roster inside
   * the sweep, which is the coupling `McapCrossDelivery` exists to avoid.
   */
  private emit(
    data: McapCrossAlertData,
    wsRecipients: string[],
    verdict: McapCrossDeliveryVerdict,
  ): void {
    const label = data.symbol ? `$${data.symbol}` : `${data.address.slice(0, 8)}…`;
    console.log(
      `${LOG} CROSSED ${label} (${data.network}) ${formatUsd(data.mcapUsd)} mcap ` +
        `— liquidity ${data.liquidityUsd != null ? formatUsd(data.liquidityUsd) : '?'}` +
        `${data.liquidityRatio != null ? ` (${(data.liquidityRatio * 100).toFixed(1)}% of mcap)` : ''}` +
        ` → ${wsRecipients.length} console, telegram baseline ${verdict.baselinePass ? 'yes' : 'no'}`,
    );
    for (const userId of wsRecipients) {
      this.wsServer.broadcastRaw({ type: 'mcap_cross_alert', data }, userId);
    }
    try {
      // Handed over WHATEVER the baseline said: a chat linked to a user with
      // looser thresholds may still want it, and only the transport can tell.
      // A chat that resolves to nobody sees `baselinePass` and nothing else.
      this.delivery.deliver(data, verdict);
    } catch (err) {
      // Delivery is best-effort: a Telegram problem must not stop the sweep or
      // lose the console frame that already went out.
      console.error(`${LOG} delivery failed:`, (err as Error)?.message);
    }
  }
}

let _poller: McapCrossPoller | null = null;

export function startMcapCrossPoller(wsServer: WsServer, delivery: McapCrossDelivery): void {
  if (_poller) return;
  _poller = new McapCrossPoller(wsServer, delivery);
  _poller.start();
}

export function stopMcapCrossPoller(): void {
  _poller?.stop();
  _poller = null;
}

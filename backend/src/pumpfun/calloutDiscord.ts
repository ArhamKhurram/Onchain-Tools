// Public Discord-channel posting for pump.fun callouts.
//
// The callout poller already delivers every matched callout twice — a WS frame to
// the console and (opt-in) a Pushover push. Both are PRIVATE: they go to the one
// operator or user who follows that caller. This module adds a THIRD, public
// delivery: one branded Components V2 card in an operator-configured Discord
// channel, so a community sees the call instead of just the console.
//
// Three properties are structural, not stylistic:
//
//  1. ONE POST PER CALLOUT — never per subscriber. The poller's follower fan-out
//     loops per (callout × follower); hooking in there would post the same call N
//     times. Posting is driven instead from the poller's `fresh` list, which is
//     already deduped by `calloutId` against the persisted cursor in
//     pump_callout_poll_state. `SeenCallouts` below is a small in-process backstop
//     for the one case the cursor can't cover: a poll that posts and then fails to
//     write the cursor, so the same ids arrive again next cycle.
//
//  2. THE FOLLOW GRAPH NEVER LEAVES THE BACKEND. Callout CONTENT is public
//     pump.fun data and fine to repost, but "user A's followed caller just called"
//     leaks who-follows-whom into a public channel. So the channel's caller set is
//     operator-controlled only: an explicit allowlist env var, else OCT's own
//     global Top Callers board (built from the public firehose, not from anyone's
//     follows). pump_tracked_callers is never read from here.
//
//  3. FAILURE IS ISOLATED. Nothing in this module throws at the poller: the entry
//     point is fully wrapped, runs AFTER the WS/Pushover delivery, and logs once
//     per failure. Unset/disabled config is a silent no-op, not an error path.

import type { Client } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { buildContractUrl, type ContractLinkTemplates } from '@oct/shared';
import {
  BRAND,
  botFooter,
  compactUsd,
  makeContainer,
  makeSection,
  makeSeparator,
  makeText,
  makeThumbnail,
  quoteLines,
  shortAddress,
} from '../bot/layout.js';
import { getBotClient } from '../bot/index.js';
import { getPumpCalloutFeedClient, type CalloutCoin, type CalloutUser, type RecentCallout } from './calloutFeedClient.js';
import { topCallersWindowed } from './callerBoardStore.js';

// --- Config ----------------------------------------------------------------

/** `OCT_<name>` with the repo-standard `TRENCHCORD_<name>` fallback. */
function envVar(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[`OCT_${name}`] ?? env[`TRENCHCORD_${name}`];
}

function envFlag(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = envVar(name, env)?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envInt(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const n = Number.parseInt(envVar(name, env) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface CalloutDiscordConfig {
  /** Master switch. Default OFF — this posts publicly, so it must be opt-in. */
  enabled: boolean;
  /** Target channel id; without it the feature stays off. */
  channelId: string | null;
  /** Explicit operator allowlist of caller wallet addresses; null = use the board. */
  allowlist: Set<string> | null;
  /** Burst cap: at most this many posts per rolling window. */
  maxPerWindow: number;
  windowMs: number;
  /** Top Callers board slice used when no allowlist is set. */
  boardLimit: number;
  boardMinCalls: number;
  boardWindowMs: number;
  /** How long a resolved caller set is reused before the board is re-read. */
  sourceTtlMs: number;
}

export const DEFAULT_BOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * Read the operator config. Pure in `env`, so tests drive it without touching
 * process.env. Everything but the two headline vars has a working default.
 */
export function resolveCalloutDiscordConfig(env: NodeJS.ProcessEnv = process.env): CalloutDiscordConfig {
  const rawAllowlist = envVar('CALLOUT_DISCORD_CALLERS', env)
    ?.split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  return {
    enabled: envFlag('CALLOUT_DISCORD_ENABLED', env),
    channelId: envVar('CALLOUT_DISCORD_CHANNEL_ID', env)?.trim() || null,
    allowlist: rawAllowlist && rawAllowlist.length > 0 ? new Set(rawAllowlist) : null,
    maxPerWindow: envInt('CALLOUT_DISCORD_MAX_PER_WINDOW', env, 5),
    windowMs: envInt('CALLOUT_DISCORD_WINDOW_MS', env, 60_000),
    boardLimit: envInt('CALLOUT_DISCORD_TOP_LIMIT', env, 25),
    boardMinCalls: envInt('CALLOUT_DISCORD_MIN_CALLS', env, 3),
    boardWindowMs: envInt('CALLOUT_DISCORD_BOARD_WINDOW_MS', env, DEFAULT_BOARD_WINDOW_MS),
    sourceTtlMs: envInt('CALLOUT_DISCORD_SOURCE_TTL_MS', env, 10 * 60_000),
  };
}

/** Both switches must be on: enabled AND a channel to post into. */
export function isCalloutDiscordEnabled(config: CalloutDiscordConfig): boolean {
  return config.enabled && config.channelId !== null;
}

/** Which caller set the channel is driven from (shown on the card + in logs). */
export function calloutSourceLabel(config: CalloutDiscordConfig): string {
  return config.allowlist ? 'Operator watchlist' : 'Top callers board';
}

// --- Flood protection ------------------------------------------------------

/**
 * Rolling-window burst cap for one channel. A hot caller or a leaderboard-wide
 * burst must not machine-gun the channel (or trip Discord's per-channel limit),
 * so posts beyond `maxPerWindow` in `windowMs` are DROPPED — never queued, since
 * a queued callout is stale by the time it lands.
 *
 * Drops are counted, never silent: the count is logged, and the next post that
 * does get through carries a "+N more callouts" line so the channel shows the
 * gap too.
 */
export class PostBudget {
  private stamps: number[] = [];
  private pendingDropped = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  /** True when this post fits in the window (and records it); false = dropped. */
  admit(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    if (this.stamps.length >= this.maxPerWindow) {
      this.pendingDropped += 1;
      return false;
    }
    this.stamps.push(now);
    return true;
  }

  /** Drops accumulated since the last drain (does not reset). */
  get dropped(): number {
    return this.pendingDropped;
  }

  /** Read and clear the drop counter — called when a post carries the summary. */
  drainDropped(): number {
    const n = this.pendingDropped;
    this.pendingDropped = 0;
    return n;
  }
}

// --- Dedupe ----------------------------------------------------------------

/**
 * Bounded in-process memory of callout ids already posted. The real dedupe is the
 * poller's persisted cursor (each callout appears in `fresh` exactly once); this
 * only covers a cursor write that failed after we posted. Bounded so a long-lived
 * process cannot grow it without limit.
 */
export class SeenCallouts {
  private ids = new Set<string>();
  private order: string[] = [];

  constructor(private readonly cap: number = 2000) {}

  /** Filter to callouts not yet posted, marking each survivor as seen. */
  take(callouts: RecentCallout[]): RecentCallout[] {
    const out: RecentCallout[] = [];
    for (const c of callouts) {
      if (this.ids.has(c.calloutId)) continue;
      this.ids.add(c.calloutId);
      this.order.push(c.calloutId);
      out.push(c);
    }
    while (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.ids.delete(evicted);
    }
    return out;
  }

  get size(): number {
    return this.ids.size;
  }
}

// --- Rendering -------------------------------------------------------------

/** Operator-level trade-link config. The channel post is not any one user's
 *  surface, so it uses OCT's default templates rather than a stored per-user one. */
const OPERATOR_LINK_TEMPLATES: ContractLinkTemplates = {
  evm: 'https://gmgn.ai/base/token/{address}',
  sol: 'https://axiom.trade/t/{address}?chain=sol',
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
};

const THESIS_LIMIT = 600;

export interface CalloutPostInput {
  callerAddress: string;
  callerName: string | null;
  callerAvatar: string | null;
  mint: string;
  symbol: string | null;
  coinName: string | null;
  thesis: string | null;
  marketCapUsd: number | null;
  multiple: number | null;
  /** Callouts dropped by the burst cap since the last post; 0 = no summary line. */
  suppressedCount?: number;
  sourceLabel: string;
}

/** `papipablo` / `7xK1..pump` — who made the call. */
export function callerDisplayName(input: Pick<CalloutPostInput, 'callerName' | 'callerAddress'>): string {
  return input.callerName?.trim() || shortAddress(input.callerAddress);
}

/** `$TOAD` / the short mint when the coin has no ticker yet. */
export function coinDisplayName(input: Pick<CalloutPostInput, 'symbol' | 'mint'>): string {
  const symbol = input.symbol?.trim();
  return symbol ? `$${symbol.replace(/^\$/, '')}` : shortAddress(input.mint);
}

/** `-# +3 more callouts held back (rate limit)`, or null when nothing was dropped. */
export function throttleNote(suppressed: number): string | null {
  if (suppressed <= 0) return null;
  const plural = suppressed === 1 ? 'callout' : 'callouts';
  return `-# +${suppressed} more ${plural} held back (rate limit)`;
}

/**
 * Render one callout as a branded Components V2 container.
 *
 * Layout mirrors the format the operator asked for — caller headline, the thesis
 * verbatim, the mint in a copyable code block — plus the two things OCT has that
 * the reference bot doesn't: market cap AT THE MOMENT OF THE CALL, and a chart
 * link built with the app's own contract-link convention.
 */
export function buildCalloutPostComponents(input: CalloutPostInput): unknown[] {
  const caller = callerDisplayName(input);
  const coin = coinDisplayName(input);

  const meta: string[] = [`MC at call ${input.marketCapUsd != null ? compactUsd(input.marketCapUsd) : '—'}`];
  if (input.multiple != null && input.multiple >= 1.05) meta.push(`${input.multiple.toFixed(2)}× since`);
  meta.push(input.sourceLabel);

  const headline = [makeText(`# 📣 ${caller} called out ${coin}`), makeText(`-# ${meta.join(' · ')}`)];

  // A section floats the caller's avatar beside the headline; without one there
  // is nothing to float, so the same two lines go in bare.
  const header = input.callerAvatar
    ? [makeSection(headline, makeThumbnail(input.callerAvatar))]
    : headline;

  const thesis = input.thesis?.trim();
  const thesisBlock = thesis
    ? makeText(quoteLines(thesis.length > THESIS_LIMIT ? `${thesis.slice(0, THESIS_LIMIT - 1)}…` : thesis))
    : makeText('-# No thesis given.');

  const chartUrl = buildContractUrl(input.mint, OPERATOR_LINK_TEMPLATES);
  const links = `[Chart →](${chartUrl}) · [pump.fun →](https://pump.fun/coin/${encodeURIComponent(input.mint)})`;

  const note = throttleNote(input.suppressedCount ?? 0);

  return [
    makeContainer(BRAND.gold, [
      ...header,
      makeSeparator(1),
      thesisBlock,
      // Fenced, not inline: a code block is the tap-to-copy shape on mobile, and
      // the mint is the one thing a reader always needs to lift verbatim.
      makeText(`\`\`\`\n${input.mint}\n\`\`\``),
      makeText(links),
      ...(note ? [makeText(note)] : []),
      makeText(botFooter(input.coinName ? `${input.coinName} · pump.fun callout` : 'pump.fun callout')),
    ]),
  ];
}

// --- Posting ---------------------------------------------------------------

export interface CalloutDiscordDeps {
  getClient: () => Client | null;
  /** Caller wallet addresses the channel is allowed to post — operator-driven only. */
  loadBoardAddresses: (config: CalloutDiscordConfig) => Promise<string[]>;
  resolveUsers: (addresses: string[]) => Promise<Map<string, CalloutUser>>;
  resolveCoins: (mints: string[]) => Promise<Map<string, CalloutCoin>>;
  now: () => number;
}

const realDeps: CalloutDiscordDeps = {
  getClient: getBotClient,
  loadBoardAddresses: async (config) => {
    const rows = await topCallersWindowed(config.boardWindowMs, 'count', config.boardMinCalls, config.boardLimit);
    return rows.map((r) => r.callerAddress);
  },
  resolveUsers: (addresses) => getPumpCalloutFeedClient().resolveUsers(addresses),
  resolveCoins: (mints) => getPumpCalloutFeedClient().resolveCoins(mints),
  now: () => Date.now(),
};

/**
 * Posts callouts into one Discord channel. Owns the throttle and the dedupe
 * backstop, so a single instance per process is what bounds channel traffic.
 */
export class CalloutDiscordPoster {
  private readonly budget: PostBudget;
  private readonly seen = new SeenCallouts();
  private sourceCache: { addresses: Set<string>; at: number } | null = null;
  private loggedDisabled = false;
  private lastErrorLoggedAt = 0;

  constructor(
    private readonly config: CalloutDiscordConfig,
    private readonly deps: CalloutDiscordDeps = realDeps,
  ) {
    this.budget = new PostBudget(config.maxPerWindow, config.windowMs);
  }

  /** The operator-configured caller set: allowlist if given, else the global board. */
  private async sourceAddresses(): Promise<Set<string>> {
    if (this.config.allowlist) return this.config.allowlist;
    const now = this.deps.now();
    if (this.sourceCache && now - this.sourceCache.at < this.config.sourceTtlMs) {
      return this.sourceCache.addresses;
    }
    const addresses = new Set(await this.deps.loadBoardAddresses(this.config));
    this.sourceCache = { addresses, at: now };
    return addresses;
  }

  /**
   * Post every fresh callout whose caller is in the operator-configured set.
   * NEVER throws and never rejects — the poller awaits this after its own
   * delivery, and a Discord problem must not touch that path.
   */
  async post(fresh: RecentCallout[]): Promise<void> {
    try {
      if (!isCalloutDiscordEnabled(this.config)) {
        // Unset is the normal state, not a fault: say it once per process, never
        // per poll, and only when the operator half-configured it.
        if (this.config.enabled && !this.config.channelId && !this.loggedDisabled) {
          this.loggedDisabled = true;
          console.warn(
            '[PumpCalloutDiscord] OCT_CALLOUT_DISCORD_ENABLED is on but OCT_CALLOUT_DISCORD_CHANNEL_ID is unset; not posting.',
          );
        }
        return;
      }
      if (fresh.length === 0) return;

      const client = this.deps.getClient();
      if (!client) return; // bot not connected on this instance

      const allowed = await this.sourceAddresses();
      if (allowed.size === 0) return;

      // Dedupe FIRST so a re-delivered callout never consumes budget twice.
      const matched = this.seen.take(fresh.filter((c) => allowed.has(c.callerAddress)));
      if (matched.length === 0) return;

      const channel = await client.channels.fetch(this.config.channelId!);
      if (!channel || !('send' in channel)) {
        this.logError(`channel ${this.config.channelId} is missing or not postable`);
        return;
      }

      const [users, coins] = await Promise.all([
        this.deps.resolveUsers([...new Set(matched.map((c) => c.callerAddress))]).catch(() => new Map<string, CalloutUser>()),
        this.deps.resolveCoins([...new Set(matched.map((c) => c.coinMint))]).catch(() => new Map<string, CalloutCoin>()),
      ]);

      // Oldest first so the newest call ends up at the bottom of the channel.
      const ordered = [...matched].reverse();
      let posted = 0;
      for (const c of ordered) {
        if (!this.budget.admit(this.deps.now())) continue;
        const user = users.get(c.callerAddress);
        const coin = coins.get(c.coinMint);
        const components = buildCalloutPostComponents({
          callerAddress: c.callerAddress,
          callerName: user?.username ?? null,
          callerAvatar: user?.avatar ?? null,
          mint: c.coinMint,
          symbol: coin?.symbol ?? null,
          coinName: coin?.name ?? null,
          thesis: c.thesis,
          marketCapUsd: c.marketCapUsd,
          multiple: c.multiple,
          suppressedCount: this.budget.drainDropped(),
          sourceLabel: calloutSourceLabel(this.config),
        });
        await (channel as { send: (payload: unknown) => Promise<unknown> }).send({
          flags: MessageFlags.IsComponentsV2,
          components,
        });
        posted += 1;
      }

      if (this.budget.dropped > 0) {
        console.warn(
          `[PumpCalloutDiscord] burst cap hit: ${this.budget.dropped} callout(s) dropped ` +
            `(cap ${this.config.maxPerWindow}/${this.config.windowMs}ms); posted ${posted}.`,
        );
      }
    } catch (err) {
      this.logError((err as Error)?.message ?? String(err));
    }
  }

  /** One log line per failure, rate-limited so a broken channel can't flood stdout. */
  private logError(message: string): void {
    const now = this.deps.now();
    if (now - this.lastErrorLoggedAt < 60_000) return;
    this.lastErrorLoggedAt = now;
    console.warn('[PumpCalloutDiscord] post failed:', message);
  }
}

let _poster: CalloutDiscordPoster | null = null;

/** Process-wide poster (config is read once, like every other env-driven knob). */
export function getCalloutDiscordPoster(): CalloutDiscordPoster {
  if (!_poster) _poster = new CalloutDiscordPoster(resolveCalloutDiscordConfig());
  return _poster;
}

/**
 * The poller's single seam. Fully guarded: it resolves, never rejects, so a
 * `void`/`await` at the call site cannot break the poll loop.
 */
export async function postCalloutsToDiscord(fresh: RecentCallout[]): Promise<void> {
  try {
    await getCalloutDiscordPoster().post(fresh);
  } catch (err) {
    console.warn('[PumpCalloutDiscord] unexpected failure:', (err as Error)?.message ?? String(err));
  }
}

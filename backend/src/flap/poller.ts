/**
 * The Flap RWA-stock listing watcher — "ping me when Flap lists a genuinely NEW
 * underlying stock", not on every meme launched against one that already exists.
 *
 * ITS OWN SIGNAL, END TO END. Per CLAUDE.md, signals are never fused: this lives
 * in its own directory beside mcapCross/ and revival/, with its own upstream
 * (an EVM VaultPortal contract), its own global store (state.ts) and its own
 * Telegram alert class. It reads none of their detection state and they read
 * none of its.
 *
 * THE ONE IDEA THAT MAKES IT USEFUL: DEDUPE ON THE UNDERLYING ASSET, NOT THE
 * VAULT. Flap mints a fresh vault per meme launch, and live BNB data showed 40
 * vaults resolving to just 13 distinct stocks. A vault-level alert would be the
 * meme firehose; an ASSET-level alert fires only the first time an underlying
 * RWA address is ever seen. See detect.ts for the resolvers (v1/v2 rwaAsset(),
 * v3 supportedAssets()).
 *
 * THE CYCLE, every OCT_FLAP_POLL_MS (default 3 min), per configured chain:
 *   1. Self-gate. No subscribed Telegram chat → return before any RPC. Same
 *      shape as mcapCross: the class defaults OFF, so a fresh deploy makes zero
 *      requests until a human opts in.
 *   2. Read the latest block and this chain's stored state (block cursor +
 *      known-asset set).
 *   3. FIRST RUN → SEED, DO NOT ALERT. Scan history back OCT_FLAP_SEED_BLOCKS
 *      (default ~30 days on BNB), collect every existing RWA asset into the
 *      known set, persist, and mark seeded. Day one therefore does not dump the
 *      dozen stocks Flap already lists — only assets first seen AFTER seeding
 *      alert.
 *   4. STEADY STATE → scan (cursor+1 .. latest], paginated ≤100k blocks. For
 *      each stock-factory vault, resolve its underlying asset(s); an asset NOT
 *      in the known set is a NEW STOCK → alert (carrying the asset symbol(s),
 *      the chain, and the FIRST token minted with that pairing). Add it to the
 *      set. A known asset is ignored — it is another meme vs an existing stock.
 *   5. One state write per chain per cycle (block cursor + grown asset set). No
 *      per-event, no per-asset rows — CLAUDE.md's egress rule.
 *
 * FAIL SAFE. A chain with no RPC configured/reachable logs once and idles;
 * BNB ships working regardless of Robinhood, one chain down never takes the
 * other or the server down, and a failed log page aborts the cycle WITHOUT
 * advancing the cursor so nothing is skipped.
 */

import { HttpFlapRpc, type FlapRpc } from './rpc.js';
import {
  addressTopic,
  factoryAddressesForChain,
  flapFactory,
  parseVaultCreatedLog,
  BSC_VAULTPORTAL,
  FLAP_TOPIC0,
  RWA_ASSET_SELECTOR,
  SUPPORTED_ASSETS_SELECTOR,
  SYMBOL_SELECTOR,
  decodeAddressResult,
  decodeAddressArrayResult,
  decodeStringResult,
  type FlapChain,
  type FlapResolver,
  type FlapVaultEvent,
} from './detect.js';
import { flapStateStore, type FlapStateStore } from './state.js';

const LOG = '[Flap]';
export const DEFAULT_POLL_MS = 180_000; // 3 min
/** eth_getLogs caps a query at 100k blocks (validated on Pinax bsc). */
const MAX_BLOCK_SPAN = 100_000;
/** ~30 days of BNB blocks (~3s/block). Env-overridable per chain shape. */
const DEFAULT_SEED_BLOCKS = 1_000_000;
/** How far `/flap test` scans back for the most recent listing. */
const DEFAULT_TEST_LOOKBACK_BLOCKS = 200_000;

/** What one NEW-STOCK alert carries out of this module. */
export interface FlapStockAlertData {
  /** The chain the stock was listed on; also the revival network id. */
  network: FlapChain;
  /** The RWA ticker(s), display-ready (falls back to a mint fragment). */
  symbols: string[];
  /** The FIRST token minted with this pairing — the event's `token`. The CA. */
  firstTokenAddress: string;
}

/**
 * How an alert leaves this module. Injected rather than imported so `flap/`
 * never reaches into `tgbot/`. `hasSubscribers` is the self-gate (step 1);
 * index.ts wires it to the Telegram roster.
 */
export interface FlapDelivery {
  hasSubscribers(): Promise<boolean>;
  deliver(data: FlapStockAlertData): void;
}

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function envInt(name: string, fallback: number, min = 0): number {
  const parsed = Number.parseInt(envFlag(name) ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/** Master switch. Only an explicit falsy value disables. */
export function isFlapEnabled(): boolean {
  const raw = (envFlag('FLAP_ENABLED') ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

function resolvePollMs(): number {
  return envInt('FLAP_POLL_MS', DEFAULT_POLL_MS, 30_000);
}

/** One chain's resolved upstream: where to read, and which VaultPortal to watch. */
export interface FlapChainConfig {
  chain: FlapChain;
  rpcUrl: string;
  vaultPortal: string;
}

/**
 * The configured chains.
 *
 * BNB is fully working out of the box: OCT_FLAP_BSC_RPC_URL, or the Pinax bsc
 * JSON-RPC built from PINAX_API_KEY (the key is the URL PATH — never a header).
 * Robinhood runs ONLY when BOTH OCT_FLAP_ROBINHOOD_RPC_URL and
 * OCT_FLAP_ROBINHOOD_VAULTPORTAL are set — Pinax does not index Robinhood and
 * its VaultPortal address is not published, so the watcher stays idle (with one
 * log line) rather than guessing.
 */
export function resolveFlapChainConfigs(): FlapChainConfig[] {
  const configs: FlapChainConfig[] = [];

  const bscUrl =
    envFlag('FLAP_BSC_RPC_URL')?.trim() ||
    (process.env.PINAX_API_KEY?.trim()
      ? `https://bsc.rpc.pinax.network/v1/${process.env.PINAX_API_KEY.trim()}`
      : '');
  if (bscUrl) {
    configs.push({
      chain: 'bsc',
      rpcUrl: bscUrl,
      vaultPortal: (envFlag('FLAP_BSC_VAULTPORTAL')?.trim() || BSC_VAULTPORTAL).toLowerCase(),
    });
  } else {
    console.warn(
      `${LOG} BNB idle: set OCT_FLAP_BSC_RPC_URL or PINAX_API_KEY. No BNB stock listings tracked.`,
    );
  }

  const rhUrl = envFlag('FLAP_ROBINHOOD_RPC_URL')?.trim();
  const rhPortal = envFlag('FLAP_ROBINHOOD_VAULTPORTAL')?.trim();
  if (rhUrl && rhPortal) {
    configs.push({ chain: 'robinhood', rpcUrl: rhUrl, vaultPortal: rhPortal.toLowerCase() });
  } else {
    console.log(
      `${LOG} Robinhood idle: needs both OCT_FLAP_ROBINHOOD_RPC_URL and ` +
        'OCT_FLAP_ROBINHOOD_VAULTPORTAL (Pinax does not index Robinhood; its VaultPortal is not published).',
    );
  }

  return configs;
}

/** A fresh, printable mint fragment when a symbol could not be read. */
function shortAsset(address: string): string {
  return address.slice(0, 6);
}

export interface FlapWatcherOpts {
  vaultPortal: string;
  seedBlocks: number;
  maxSpan: number;
  testLookbackBlocks: number;
}

/**
 * One chain's watcher. Injected RPC + store + delivery so the whole detection
 * loop is unit-testable without a network or a database.
 */
export class FlapChainWatcher {
  private polling = false;
  /** vault → its underlying asset addresses; a vault's assets never change. */
  private readonly vaultAssets = new Map<string, string[]>();
  /** asset → its symbol (or null when unreadable), so repeats cost no call. */
  private readonly assetSymbols = new Map<string, string | null>();

  constructor(
    private readonly chain: FlapChain,
    private readonly rpc: FlapRpc,
    private readonly store: FlapStateStore,
    private readonly delivery: FlapDelivery,
    private readonly opts: FlapWatcherOpts,
  ) {}

  /** One poll cycle. Never throws. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const latest = await this.rpc.blockNumber();
      if (latest == null) return;

      const state = await this.store.load(this.chain);
      const known = new Set(state.knownAssets);

      // SEED: mark existing assets WITHOUT alerting, once.
      if (!state.seeded) {
        const from = Math.max(0, latest - this.opts.seedBlocks);
        const events = await this.scanEvents(from, latest);
        if (events === null) {
          console.warn(`${LOG} ${this.chain} seed scan failed; will retry next cycle.`);
          return;
        }
        for (const ev of events) {
          for (const asset of await this.resolveVaultAssets(ev)) known.add(asset);
        }
        await this.store.save(this.chain, {
          lastScannedBlock: latest,
          seeded: true,
          knownAssets: [...known],
        });
        console.log(
          `${LOG} ${this.chain} seeded: ${known.size} existing stock asset(s) up to block ${latest}. ` +
            'Only assets first seen after now will alert.',
        );
        return;
      }

      const from = state.lastScannedBlock + 1;
      if (from > latest) return; // nothing new since last cycle

      const events = await this.scanEvents(from, latest);
      if (events === null) {
        console.warn(`${LOG} ${this.chain} scan failed; cursor held for retry.`);
        return; // do NOT advance the cursor over an unread window
      }

      let alerted = 0;
      for (const ev of events) {
        const assets = await this.resolveVaultAssets(ev);
        const fresh = assets.filter((a) => !known.has(a));
        if (fresh.length === 0) continue; // another meme vs an existing stock

        const symbols: string[] = [];
        for (const asset of fresh) symbols.push((await this.resolveSymbol(asset)) ?? shortAsset(asset));
        this.delivery.deliver({
          network: this.chain,
          symbols,
          firstTokenAddress: ev.token,
        });
        alerted += 1;
        for (const asset of fresh) known.add(asset);
      }

      await this.store.save(this.chain, {
        lastScannedBlock: latest,
        seeded: true,
        knownAssets: [...known],
      });
      if (alerted > 0) {
        console.log(`${LOG} ${this.chain}: ${alerted} new stock listing(s) alerted.`);
      }
    } catch (err) {
      console.error(`${LOG} ${this.chain} poll error:`, (err as Error)?.message);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The most recent stock listing in a bounded recent window, resolved AS IT
   * WOULD APPEAR — for `/flap test`. Touches no state, alerts nobody, and is not
   * subscriber-gated (it is an operator dry run).
   */
  async latestListing(): Promise<FlapStockAlertData | null> {
    const latest = await this.rpc.blockNumber();
    if (latest == null) return null;
    const from = Math.max(0, latest - this.opts.testLookbackBlocks);
    const events = await this.scanEvents(from, latest);
    if (!events || events.length === 0) return null;

    const ev = events[events.length - 1]!; // newest (scanEvents sorts ascending)
    const assets = await this.resolveVaultAssets(ev);
    if (assets.length === 0) return null;

    const symbols: string[] = [];
    for (const asset of assets) symbols.push((await this.resolveSymbol(asset)) ?? shortAsset(asset));
    return { network: this.chain, symbols, firstTokenAddress: ev.token };
  }

  /**
   * Every stock-factory vault event in [from, to], ascending by block. Null
   * when ANY page failed — the caller must then not advance its cursor. Filters
   * eth_getLogs by topic0 + a factory-address OR-set at topic3, then re-checks
   * the factory allowlist after decoding (defence against a lax node).
   */
  private async scanEvents(from: number, to: number): Promise<FlapVaultEvent[] | null> {
    const factoryTopics = factoryAddressesForChain(this.chain).map(addressTopic);
    if (factoryTopics.length === 0) return [];
    const topics: (string | string[] | null)[] = [FLAP_TOPIC0, null, null, factoryTopics];

    const out: FlapVaultEvent[] = [];
    for (let start = from; start <= to; start += this.opts.maxSpan) {
      const end = Math.min(start + this.opts.maxSpan - 1, to);
      const logs = await this.rpc.getLogs({
        fromBlock: start,
        toBlock: end,
        address: this.opts.vaultPortal,
        topics,
      });
      if (logs === null) return null;
      for (const log of logs) {
        const ev = parseVaultCreatedLog(log, this.opts.vaultPortal);
        if (ev && flapFactory(ev.factory)) out.push(ev);
      }
    }

    out.sort((a, b) => (a.blockNumber ?? 0) - (b.blockNumber ?? 0));
    return out;
  }

  /** The underlying asset addresses for a vault event, cached. */
  private async resolveVaultAssets(ev: FlapVaultEvent): Promise<string[]> {
    const cached = this.vaultAssets.get(ev.vault);
    if (cached) return cached;

    const factory = flapFactory(ev.factory);
    if (!factory) return [];
    const assets = await this.callAssets(ev.vault, factory.resolver);
    this.vaultAssets.set(ev.vault, assets);
    return assets;
  }

  private async callAssets(vault: string, resolver: FlapResolver): Promise<string[]> {
    if (resolver === 'single') {
      const asset = decodeAddressResult(await this.rpc.call(vault, RWA_ASSET_SELECTOR));
      return asset ? [asset] : [];
    }
    const arr = decodeAddressArrayResult(await this.rpc.call(vault, SUPPORTED_ASSETS_SELECTOR));
    return arr ?? [];
  }

  /** An asset's ticker, cached (null cached too — an unreadable symbol is stable). */
  private async resolveSymbol(asset: string): Promise<string | null> {
    if (this.assetSymbols.has(asset)) return this.assetSymbols.get(asset) ?? null;
    const symbol = decodeStringResult(await this.rpc.call(asset, SYMBOL_SELECTOR));
    this.assetSymbols.set(asset, symbol);
    return symbol;
  }
}

/** Manages one watcher per configured chain behind a single shared timer. */
class FlapPoller {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private ticking = false;
  private loggedIdle = false;

  constructor(
    private readonly watchers: FlapChainWatcher[],
    private readonly delivery: FlapDelivery,
    private readonly watchedChains: FlapChain[],
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.watchers.length === 0) {
      console.log(`${LOG} No chain configured; poller idle.`);
      return;
    }
    const interval = resolvePollMs();
    console.log(`${LOG} Started (interval ${interval}ms). Idle until a chat subscribes.`);
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error(`${LOG} tick error:`, (err as Error)?.message));
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Self-gate: nobody subscribed → make zero RPC requests.
      if (!(await this.delivery.hasSubscribers())) {
        if (!this.loggedIdle) {
          console.log(`${LOG} No chat is subscribed; watching nothing until one is.`);
          this.loggedIdle = true;
        }
        return;
      }
      this.loggedIdle = false;
      for (const watcher of this.watchers) await watcher.poll();
    } finally {
      this.ticking = false;
    }
  }

  async latestListing(): Promise<FlapStockAlertData | null> {
    for (const watcher of this.watchers) {
      const listing = await watcher.latestListing();
      if (listing) return listing;
    }
    return null;
  }

  chains(): FlapChain[] {
    return this.watchedChains;
  }
}

let _poller: FlapPoller | null = null;

/**
 * Start the Flap watcher. Injected delivery keeps `flap/` clear of `tgbot/`.
 * No-op when disabled or already started; never throws into startup.
 */
export function startFlapPoller(delivery: FlapDelivery): void {
  if (_poller) return;
  if (!isFlapEnabled()) {
    console.log(`${LOG} Disabled via OCT_FLAP_ENABLED; poller idle.`);
    return;
  }

  const seedBlocks = envInt('FLAP_SEED_BLOCKS', DEFAULT_SEED_BLOCKS, 1);
  const testLookbackBlocks = envInt('FLAP_TEST_LOOKBACK_BLOCKS', DEFAULT_TEST_LOOKBACK_BLOCKS, 1);
  const configs = resolveFlapChainConfigs();

  const watchers = configs.map(
    (cfg) =>
      new FlapChainWatcher(cfg.chain, new HttpFlapRpc(cfg.rpcUrl, cfg.chain), flapStateStore, delivery, {
        vaultPortal: cfg.vaultPortal,
        seedBlocks,
        maxSpan: MAX_BLOCK_SPAN,
        testLookbackBlocks,
      }),
  );

  _poller = new FlapPoller(watchers, delivery, configs.map((c) => c.chain));
  _poller.start();
}

export function stopFlapPoller(): void {
  _poller?.stop();
  _poller = null;
}

/** For `/flap test`: the most recent listing, or null when unavailable. */
export async function flapTestListing(): Promise<FlapStockAlertData | null> {
  return _poller ? _poller.latestListing() : null;
}

/** The chains the watcher is actually running for — for command messaging. */
export function flapWatchedChains(): FlapChain[] {
  return _poller ? _poller.chains() : [];
}

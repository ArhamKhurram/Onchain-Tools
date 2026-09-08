// "OCT Alerts": algorithm-scan signals from operator-configured source channels,
// forwarded through the bot to its subscribers in realtime.
//
// WHITE-LABEL. What reaches a chat is an OCT card attributed to "OCT Alerts ·
// SOL/EVM" — the CHAIN the signal came from, never the upstream that produced
// it. The upstream is named NOWHERE: not here, not in the alert-type key
// (`octSignals`), not in the card, not in an env var. Where a source channel
// has to be named it is named by CHAIN/ROLE ("sol source", "evm source"), and
// the operator supplies the actual channel IDs (and any upstream branding to
// strip) purely through env — so the vendor string lives only in the
// deployment's configuration, never in this repository.
//
// WHY BY ID, NOT BY TITLE. The two source channels' titles are user-editable
// and share a prefix, so a title match is both fragile and would have to encode
// the vendor word. Channel IDs are stable and exact. The operator lists them,
// per chain, in env — the same ids the existing Telegram source config shows.
//
// WHY THE TOPIC IS PART OF THE ID. The two algorithm feeds are two forum-TOPICS
// of ONE supergroup, addressed `-100…:topicId` (e.g. `-1003705845819:3` for SOL,
// `:4` for EVM — the `telegramChannelId` shape from telegram/messageProcessor).
// The supergroup's peer id is identical for both; only the topic tells them
// apart. So the match is on the FULL composite id INCLUDING the topic. Dropping
// the topic (as an earlier version did) collapsed `:3` and `:4` onto the same
// key: the SOL and EVM sets became identical, every EVM signal was mislabelled
// SOL, and any OTHER topic in that supergroup — general chat, a service post,
// the bare group — matched too and got force-forwarded. A configured source
// therefore matches ONLY its own topic; a bare-group source matches only a
// bare-group (topic-less) message.
//
// PURE. No I/O beyond reading process.env (the convention every sibling in this
// directory follows — see source.ts, guard.ts, digest.ts), so the whole
// recognise-and-shape step is a unit test rather than a running bot.

import { detectContractAddresses, normalizeContractAddress } from '../utils/contract.js';

/** Which source a signal came from. Drives the card's chain line + dedupe key. */
export type OctSignalChain = 'sol' | 'evm';

/**
 * One forwarded signal, reduced to what the card and the fan-out need.
 *
 * `text` is UNTRUSTED third-party content and is escaped at render, never here.
 * `addresses` are extracted by the shared detector, so they are already
 * narrowed to real SOL/EVM shapes. `ticker`/`mcapDisplay` are parsed from the
 * same untrusted body by the pure helpers below: bounded, validated, and
 * escaped at render — they are the ONLY scan fields the minimal card shows.
 */
export interface OctSignalView {
  /** The source channel's role — the label chain, not necessarily the address's. */
  chain: OctSignalChain;
  /** URL-routing hint for buildRevivalContractUrl / the quick-buy keyboard. */
  network: string;
  /** Contract addresses found in the message (may be empty — text still forwards). */
  addresses: string[];
  /** The scan body, with any upstream signature stripped. Escaped at render. */
  text: string;
  /**
   * Bare ticker parsed from the body (no `$`, upper-cased, length-capped), or
   * null when none could be found. The render adds exactly one `$`.
   */
  ticker: string | null;
  /**
   * Normalised market-cap display string parsed from a labelled `MC`/`MCAP`/
   * `Market Cap` figure (e.g. `$735.02K`), or null when absent/unparseable.
   * Never a NaN or a wrong number — an unparseable figure omits the line.
   */
  mcapDisplay: string | null;
}

// --- Field extraction from the untrusted scan body --------------------------
//
// UNTRUSTED INPUT. Everything below reads third-party text. Each helper is pure,
// bounds the length of what it returns, rejects non-finite numbers, and leaves
// escaping to the renderer (html.ts). None of them can throw on hostile input.

/** Longest ticker the card will show (a real ticker is a handful of chars). */
const MAX_TICKER_LEN = 12;
/** Longest market-cap numeric run we accept before treating it as garbage. */
const MAX_MCAP_DIGITS = 20;

/**
 * Normalise and validate a ticker CANDIDATE: strip a leading `$`, upper-case,
 * and accept it only when it is a single clean symbol — letters/digits/`_`,
 * length-capped, and carrying at least one letter (a bare number is not a
 * ticker). Returns null for anything else, so a candidate with a space or a
 * stray symbol can never become a ticker.
 */
function cleanTicker(raw: string): string | null {
  const s = raw.trim().replace(/^\$+/, '').toUpperCase();
  if (!new RegExp(`^[A-Z0-9_]{1,${MAX_TICKER_LEN}}$`).test(s)) return null;
  if (!/[A-Z]/.test(s)) return null;
  return s;
}

/**
 * The name token from the FIRST non-empty line, when that line names a SINGLE
 * clean symbol — a markdown/bold header or an image-card caption like
 * `MARLIN • 5.2x`. The token is whatever precedes the first `•`/`(` (or the
 * whole line when there is none), with markdown links/emphasis and a leading
 * emoji stripped. Returns null when what remains is empty or MULTI-WORD — a
 * sentence of prose (`GETTING THE LORD…`) must never become a ticker.
 */
function extractNameToken(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!firstLine) return null;

  // Unwrap markdown BEFORE splitting on delimiters, so a `](url)` inside a link
  // is not cut at its own parenthesis.
  const unwrapped = firstLine
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/https?:\/\/\S+/g, ' ') // bare urls
    .replace(/[*_`~]+/g, ''); // markdown emphasis markers

  // The name is whatever precedes a bullet/paren (a caption's `• 5.2x`, a
  // header's `($SYM)`); with neither, the whole line.
  const region = unwrapped
    .split(/[•(]/)[0]
    .replace(/^[^\p{L}\p{N}$]+/u, '') // leading emoji / bullet / symbols
    .trim();

  // A single clean token only — a space means prose, which is rejected.
  if (region === '' || /\s/.test(region)) return null;
  return region;
}

/**
 * The ticker for the card, in priority order:
 *   1. a `($SYMBOL)` parenthetical — the reliable header form (`… ** ($MARLIN)`);
 *   2. a standalone `$SYMBOL` that is a single clean token and is NOT running
 *      into a sentence (a `$` inside prose is not a ticker);
 *   3. the first-line NAME token, when it is a single clean symbol (a bold
 *      header, or a `MARLIN • 5.2x` caption).
 *
 * Every path yields a single validated token or null; a line of prose (with
 * spaces) can never become a ticker. Null → the card shows its neutral header.
 */
export function parseSignalTicker(text: string): string | null {
  // 1. ($SYMBOL) — the parenthetical the real header carries.
  const paren = text.match(/\(\s*\$([A-Za-z0-9_]{1,12})\s*\)/);
  const fromParen = paren ? cleanTicker(paren[1]) : null;
  if (fromParen) return fromParen;

  // 2. A standalone $SYMBOL, single clean token, not part of a sentence.
  const dollar = text.match(/\$([A-Za-z][A-Za-z0-9_]{0,11})(?![A-Za-z0-9_])/);
  if (dollar && dollar.index != null) {
    const cand = cleanTicker(dollar[1]);
    if (cand) {
      const restOfLine = text.slice(dollar.index + dollar[0].length).split(/\r?\n/)[0];
      const furtherWords = (restOfLine.match(/\p{L}{2,}/gu) ?? []).length;
      // 0-1 trailing words is a tag ("$MARLIN", "$MARLIN 5.2x"); 2+ is prose
      // ("$SOL bullish algorithm") and falls through to the name path.
      if (furtherWords < 2) return cand;
    }
  }

  // 3. The first-line name token, when it is a single clean symbol.
  const named = extractNameToken(text);
  return named ? cleanTicker(named) : null;
}

/**
 * The market cap for the card, from EITHER upstream message form:
 *   • a labelled figure — `MC`/`MCAP`/`Market Cap` with an optional `$` and
 *     `K`/`M`/`B`/`T` suffix (`$17.5K`, `750K`, `MC: **$735.02K**`);
 *   • an `@ <number><K/M/B/T>` "called-at" figure — the image-card caption form
 *     (`… @ 142.32K (6h)`), where the `@` anchor plays the label's role.
 *
 * Normalised to a `$…` display string. Null when absent or unparseable — never a
 * NaN and never a different number than the one written. Both forms are
 * DIGIT-BOUNDED and anchored (a label, or `@` + a magnitude suffix), so an
 * ATH/VOL/LIQ figure or a bare `@handle` cannot be mistaken for the market cap.
 */
export function parseSignalMarketCap(text: string): string | null {
  const labelled = text.match(
    /\b(?:MCAP|MC|MARKET\s*CAP)\b\s*[:=]?\s*\*{0,2}\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT])?/i,
  );
  // The `@ <mcap>` caption form REQUIRES a magnitude suffix — that is what makes
  // it a market cap rather than a stray "@ 5 min" or an "@handle".
  const atForm = text.match(/@\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT])\b/i);
  const m = labelled ?? atForm;
  if (!m) return null;

  const numStr = m[1].replace(/,/g, '');
  if (numStr.length > MAX_MCAP_DIGITS) return null;
  const value = Number(numStr);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = (m[2] ?? '').toUpperCase();
  return `$${numStr}${suffix}`;
}

// --- Dedupe (one call = one alert) ------------------------------------------
//
// Upstream posts the SAME call twice within seconds — a text card and an image
// card — each carrying the same contract. Left alone that is two alerts. This
// collapses them to one per (chain, primary address) inside a TTL window,
// first-wins. In-memory only: no persistence, no Supabase, nothing to restore.

/** Env names for the dedupe window, primary first. */
const DEDUPE_TTL_ENV = ['OCT_SIGNAL_DEDUPE_TTL_MS', 'TG_BOT_SIGNAL_DEDUPE_TTL_MS'] as const;
/** Default window: two near-simultaneous posts of one call collapse. */
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on the map so a long-running process cannot grow it unbounded. */
const DEDUPE_MAX_ENTRIES = 5000;

function readDedupeTtlMs(): number {
  for (const name of DEDUPE_TTL_ENV) {
    const raw = process.env[name]?.trim();
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return DEFAULT_DEDUPE_TTL_MS;
}

/**
 * The dedupe key for a signal: chain + case-normalised primary address. Chain
 * is part of the key on purpose — the same CA on SOL and on EVM are two real,
 * distinct tokens and both must alert. EVM addresses fold to lowercase (the same
 * mint arrives in mixed casings); SOL is base58 and case-SENSITIVE, so it is
 * left untouched — exactly `normalizeContractAddress`'s contract.
 */
export function octSignalDedupeKey(chain: OctSignalChain, address: string): string {
  return `${chain}:${normalizeContractAddress(address)}`;
}

/**
 * A tiny in-memory TTL set of recently-seen signal keys. One instance lives on
 * the alert router (a sibling of its guard/buffer). Expired keys are swept on
 * every check, and the map is capped so it cannot leak.
 */
export class OctSignalDedupe {
  /** key → epoch-ms at which the key expires. */
  private readonly seen = new Map<string, number>();

  /**
   * True when `key` was seen inside the TTL window (drop this signal); false the
   * FIRST time (record it and deliver). First-wins: a later duplicate never
   * refreshes the window, so a genuine re-call after the TTL alerts again.
   */
  isDuplicate(key: string, now: number = Date.now()): boolean {
    this.evict(now);
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return true;
    this.seen.set(key, now + readDedupeTtlMs());
    if (this.seen.size > DEDUPE_MAX_ENTRIES) this.trim();
    return false;
  }

  /** Drop every expired key. */
  private evict(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  /** Last-resort cap: drop the oldest-inserted keys (Map preserves order). */
  private trim(): void {
    const overflow = this.seen.size - DEDUPE_MAX_ENTRIES;
    if (overflow <= 0) return;
    let dropped = 0;
    for (const key of this.seen.keys()) {
      this.seen.delete(key);
      if (++dropped >= overflow) break;
    }
  }
}

/** Env names for the SOL source channel id list, primary first. */
const SOL_SOURCE_ENV = ['OCT_SIGNAL_SOURCE_CHANNEL_IDS_SOL', 'TG_BOT_SIGNAL_SOURCE_CHANNEL_IDS_SOL'] as const;
/** Env names for the EVM source channel id list, primary first. */
const EVM_SOURCE_ENV = ['OCT_SIGNAL_SOURCE_CHANNEL_IDS_EVM', 'TG_BOT_SIGNAL_SOURCE_CHANNEL_IDS_EVM'] as const;
/**
 * Env names for the substrings to strip from a forwarded body. The operator
 * puts the upstream's own signature/branding here; it is the ONLY place that
 * string is allowed to exist, and it never enters the codebase.
 */
const STRIP_TERMS_ENV = ['OCT_SIGNAL_STRIP_TERMS', 'TG_BOT_SIGNAL_STRIP_TERMS'] as const;

function readEnvList(names: readonly string[]): string[] {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  return [];
}

/**
 * Canonical form of a Telegram source id for exact comparison.
 *
 * Only the PEER-prefix noise is normalised: `-1001234567890`, its bare
 * `1234567890`, and (for a basic group) a single leading `-` all reduce to the
 * same digit-core, so the env value and the ingested id compare equal whichever
 * `-100`/bare form each happens to use. Two channels that merely share a prefix
 * still stay distinct — this compares the whole digit-core, never a prefix.
 *
 * The `:topicId` segment is PRESERVED and REQUIRED: a forum-topic source is
 * `<digit-core>:<topic>`, and `:3` never compares equal to `:4` or to the bare
 * group. The topic is normalised to its integer form so `:03` and `:3` agree; a
 * malformed/empty topic segment is treated as "no topic" (bare group).
 */
function canonicalChannelId(id: string): string {
  const trimmed = id.trim();
  const colon = trimmed.indexOf(':');
  const chatPart = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const topicPart = colon === -1 ? '' : trimmed.slice(colon + 1).trim();

  const core = chatPart
    .trim()
    .replace(/^-100/, '') // supergroup/channel peer prefix
    .replace(/^-/, ''); // basic-group prefix

  const topicNum = Number(topicPart);
  const topic = topicPart !== '' && Number.isInteger(topicNum) && topicNum > 0 ? String(topicNum) : '';

  return topic !== '' ? `${core}:${topic}` : core;
}

/** The configured id sets, per chain, canonicalised for exact comparison. */
function readSignalSources(): { sol: Set<string>; evm: Set<string> } {
  return {
    sol: new Set(readEnvList(SOL_SOURCE_ENV).map(canonicalChannelId)),
    evm: new Set(readEnvList(EVM_SOURCE_ENV).map(canonicalChannelId)),
  };
}

/** Whether the bot has any signal source configured at all. */
export function hasSignalSources(): boolean {
  const { sol, evm } = readSignalSources();
  return sol.size > 0 || evm.size > 0;
}

/**
 * The chain a message from `chatId` counts as, or null when the channel is not
 * a configured signal source. Read fresh so a restart-free env change applies,
 * exactly like readGuardLimits / readDefaultAlertSource.
 */
export function resolveOctSignalChain(chatId: string): OctSignalChain | null {
  const key = canonicalChannelId(chatId);
  if (key === '') return null;
  const { sol, evm } = readSignalSources();
  if (sol.has(key)) return 'sol';
  if (evm.has(key)) return 'evm';
  return null;
}

/** The operator-configured strip substrings (never a hardcoded vendor word). */
export function readSignalStripTerms(): string[] {
  return readEnvList(STRIP_TERMS_ENV);
}

// --- EVM chain resolution for an EVM-source signal --------------------------
//
// The EVM algorithm topic carries tokens from a REAL EVM chain (Robinhood, and
// occasionally Base/BSC), not a generic "evm". Resolving it wrong drops the
// chain label to "EVM" and — because Axiom only has a verified route on
// Robinhood — silently loses the Axiom quick-buy button. Two ways to resolve it,
// in order: the chain named by a chart/explorer link in the body, then the
// per-source configured default (Robinhood), never a bare `evm`.

/** Env names for the EVM-source fallback network, primary first. */
const EVM_FALLBACK_ENV = [
  'OCT_SIGNAL_EVM_FALLBACK_NETWORK',
  'TG_BOT_SIGNAL_EVM_FALLBACK_NETWORK',
] as const;

/**
 * The EVM-source fallback network when the body names no chain. The EVM topic is
 * the Robinhood chain, so a signal that carries no parseable link is Robinhood —
 * never a bare `evm`, which would lose both the label and the Axiom button.
 * Operator-overridable per deployment.
 */
function readEvmFallbackNetwork(): string {
  for (const name of EVM_FALLBACK_ENV) {
    const v = process.env[name]?.trim();
    if (v) return v.toLowerCase();
  }
  return 'robinhood';
}

/**
 * Chain aliases seen in an explorer/DEX path segment → the OCT network id the
 * card, label and quick-buy keyboard use. Generic: it reads the path segment,
 * never a vendor.
 */
const EVM_CHAIN_ALIASES: Record<string, string> = {
  robinhood: 'robinhood',
  hood: 'robinhood',
  base: 'base',
  bsc: 'bsc',
  bnb: 'bsc',
  binance: 'bsc',
  'binance-smart-chain': 'bsc',
  eth: 'eth',
  ethereum: 'eth',
  arbitrum: 'arb',
  arb: 'arb',
  polygon: 'polygon',
  matic: 'polygon',
  avalanche: 'avax',
  avax: 'avax',
};

/**
 * The EVM chain named by a chart/explorer link in the body, or null when none is
 * present. Reads the CHAIN PATH SEGMENT of a link (`dexscreener.com/<chain>/…`,
 * `geckoterminal.com/<chain>/…`, `dextools.io/app/<locale>/<chain>/…`) and maps
 * it via EVM_CHAIN_ALIASES — a generic path read, never a vendor match.
 */
export function parseEvmChainFromLinks(text: string): string | null {
  const re = /(?:dexscreener\.com|geckoterminal\.com|dextools\.io\/app\/[a-z]{2,})\/([a-z0-9-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const seg = m[1].toLowerCase();
    if (EVM_CHAIN_ALIASES[seg]) return EVM_CHAIN_ALIASES[seg];
  }
  return null;
}

/**
 * The network id for an EVM-source signal: the chain a body link names, else the
 * caller's body-derived hint, else the configured default (Robinhood). Never a
 * bare `evm`.
 */
export function resolveEvmSignalNetwork(text: string, hint?: string | null): string {
  return parseEvmChainFromLinks(text) ?? (hint?.trim() || null) ?? readEvmFallbackNetwork();
}

/**
 * A line that reads as an upstream signature/footer rather than scan content:
 * a bare handle, a bare link, or a promotional call-to-action. Contract
 * addresses are extracted independently of the body, so stripping such a line
 * can never cost the CA.
 */
function isSignatureLine(line: string): boolean {
  if (/^@[\w]{3,}$/.test(line)) return true;
  if (/^(?:https?:\/\/\S+|t\.me\/\S+)$/i.test(line)) return true;
  if (/^(?:powered by|sponsored by|brought to you by|via|join|subscribe|follow)\b/i.test(line)) return true;
  // A dash-led line is only a signature when it ALSO carries a promo marker, so
  // an em-dashed sentence of real content survives.
  if (/^[—–-]{1,3}\s*\S/.test(line) && /(?:powered|sponsor|via|join|subscribe|follow|t\.me\/|@)/i.test(line)) {
    return true;
  }
  return false;
}

/**
 * Remove upstream branding from a forwarded body: any line containing an
 * operator-configured strip term, and any line shaped like a signature/footer.
 * Blank runs are collapsed. The substantive scan text — and every contract
 * address, which is extracted separately — is preserved.
 */
export function stripUpstreamSignature(text: string, needles: string[]): string {
  const lc = needles.map((n) => n.trim().toLowerCase()).filter((n) => n !== '');
  const kept = text.split(/\r?\n/).filter((raw) => {
    const line = raw.trim();
    if (line === '') return true;
    const low = line.toLowerCase();
    if (lc.some((n) => low.includes(n))) return false;
    return !isSignatureLine(line);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Recognise a message from a configured signal source and shape it for the
 * fan-out, or null when the channel is not a source (or nothing is left to
 * forward). No side effects — the caller decides whether to deliver.
 */
export function buildOctSignalView(input: {
  chatId: string;
  text: string;
  evmChainHint?: string | null;
}): OctSignalView | null {
  const chain = resolveOctSignalChain(input.chatId);
  if (!chain) return null;

  const raw = input.text ?? '';
  const addresses = detectContractAddresses(raw).addresses;
  const text = stripUpstreamSignature(raw, readSignalStripTerms());

  // A scan is only worth forwarding if it carries a contract address: the CA
  // and its buy buttons ARE the alert. The source topics also carry non-scan
  // chatter, status lines and split messages with no CA — forwarding those
  // produced a burst of empty "OCT Alerts · <chain>" cards, which is noise, not
  // signal. No address → drop.
  if (addresses.length === 0) return null;

  const network = chain === 'sol' ? 'solana' : resolveEvmSignalNetwork(raw, input.evmChainHint);
  // Ticker/MC are parsed from the RAW body (before signature stripping) so a
  // stat line is never lost to an aggressive strip; the CA is likewise
  // extracted independently. Both are omitted, not faked, when absent.
  const ticker = parseSignalTicker(raw);
  const mcapDisplay = parseSignalMarketCap(raw);
  return { chain, network, addresses, text, ticker, mcapDisplay };
}
